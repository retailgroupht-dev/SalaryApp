# Локальний API «Розрахунок зарплат»

Застосунок піднімає HTTP-сервер, через який інші програми й скрипти забирають і закидають
дані без участі вікна: замовлення, працівників, розрахунок зарплати, файли експорту, резервну копію.

- Адреса зараз: `http://127.0.0.1:8765`
- Вмикається й налаштовується у вкладці **Налаштування → Локальний API** (адреса, порт, ключ).
- `127.0.0.1` — доступ лише з цього комп’ютера; `0.0.0.0` — також з локальної мережі.
- Усі відповіді — JSON у UTF-8 (крім файлів експорту й цієї документації).
- Помилка — JSON `{"error": "…"}` зі статусом 400 (поганий запит), 401 (ключ), 404, 413 (завеликий запит), 502 (Google недоступний), 500.

## Авторизація

Ключ не задано: запити приймаються без перевірки. Якщо відкриваєте API в мережу (адреса 0.0.0.0), обов’язково задайте ключ.

Ключ передається одним із способів:

- заголовок `Authorization: Bearer <ключ>`
- заголовок `X-Api-Key: <ключ>`
- параметр `?key=<ключ>` в адресі

## Поля

**Працівник** — `{id, name, ratePercent}`. `ratePercent` порожнє (`null`) = загальна ставка з налаштувань.

**Замовлення** — `{id, employeeId, product, number, amount, channel, status, date, np}`:

| Поле | Опис |
|---|---|
| `employee` або `employeeId` | при створенні: id **або ім’я** працівника (регістр не важливий) |
| `number` | номер ТТН або замовлення; за ним зливаються повтори |
| `amount` | сума, число |
| `product` | назва товару (необов’язково) |
| `channel` | `Rozetka`, `Пром 1`…`Пром 3`, `Епіцентр` або порожньо |
| `status` | `ok` — Виконано, `refused` — Відмова, `cancelled` — Скасовано, `nodata` — Немає даних, `checking` — Перевіряється; невідоме значення → `checking` |
| `date` | `YYYY-MM-DD`; без дати — сьогодні. Період розрахунку береться з дати |
| `np` | що відповіла Нова Пошта: `{status, code, reason, received, checked}` або `null` (заповнюється трекінгом) |

Зарплата = сума замовлень зі статусом `ok` × ставка (%). Інші статуси не рахуються.

## Маршрути

### Стан

`GET /api/health` → `{ok, version, employees, orders, routes}`

```bash
curl "http://127.0.0.1:8765/api/health"
```

### Розрахунок зарплати

`GET /api/salary?period=YYYY-MM` — за місяць; без `period` — за весь час.
Відповідь: `{period, ratePercent, rows: [{employeeId, name, ratePercent, total, done, refused, cancelled, nodata, checking, sumDone, salary}], totals: {total, done, sumDone, salary}}`.

```bash
curl "http://127.0.0.1:8765/api/salary?period=2026-11"
```

### Файл розрахунку

`GET /api/export?format=xlsx|csv&period=YYYY-MM` — той самий файл, що з кнопки «Експорт»:
аркуш «Зарплата» (підсумок на працівника) і «Замовлення» (усі замовлення періоду).

```bash
curl -o зарплата-2026-11.xlsx "http://127.0.0.1:8765/api/export?format=xlsx&period=2026-11"
```

### Працівники

- `GET /api/employees` — список.
- `POST /api/employees` з `{name, ratePercent?}` → працівник (якщо ім’я вже є — повертає наявного).
- `DELETE /api/employees/:id` — видаляє працівника **разом із його замовленнями**.

```bash
curl -X POST -H "Content-Type: application/json" "http://127.0.0.1:8765/api/employees" -d '{"name":"Іваненко","ratePercent":6}'
```

### Замовлення

- `GET /api/orders?employee=&period=&status=&q=` — фільтри необов’язкові: працівник (id або ім’я), місяць `YYYY-MM`, статус, пошук по товару чи номеру.
- `POST /api/orders` — один об’єкт або масив. Запис **з `id`** замінюється повністю; **без `id`** зливається за «працівник + номер»: якщо такий номер уже є, оновлюються статус, сума й канал, інакше додається новий. Повторна відправка того самого пакета не плодить дублікатів. Відповідь `{added, updated, parsed}`.
- `DELETE /api/orders/:id` → `{deleted}`.

```bash
curl -G --data-urlencode "employee=Настя" --data-urlencode "period=2026-11" "http://127.0.0.1:8765/api/orders"

curl -X POST -H "Content-Type: application/json" "http://127.0.0.1:8765/api/orders" -d '[
  {"employee":"Настя","number":"20451500000001","amount":350,"status":"ok","channel":"Rozetka","product":"компас"},
  {"employee":"Товкес","number":"PRM-100000001","amount":1200,"status":"refused","channel":"Пром 2","date":"2026-11-03"}
]'
```

### Нова Пошта: за номером ТТН

Замовлення можна додавати лише за номером ТТН (14 цифр): статус, дата створення накладної,
дата отримання й (з ключем відправника) сума післяплати підтягуються з трекінгу Нової Пошти.
Без ключа Нова Пошта віддає лише статус і дати — тоді `amount` буде `null`, у замовленні
сума лишиться 0 (або попередня), і її треба вказати вручну. Для передплачених замовлень суми
теж немає. Ключ задається у **Налаштування → Нова Пошта** або `PUT /api/settings`.

Зіставлення статусів НП: отримано (коди 9, 10, 11, 106) → `ok`; відмова, не забрали,
припинено зберігання (102, 103, 105) → `refused`; видалено (2) → `cancelled`;
номер не знайдено (3) → `nodata`; усе інше (в дорозі, у відділенні) → `checking`.

- `GET /api/track?numbers=20450000000000,20450000000001` — лише подивитися, без запису: `{results: [{number, found, status, npStatus, npCode, reason, amount, dateCreated, dateReceived, product, cityRecipient}], skipped}`.
- `POST /api/track` з `{"employee": "Настя", "numbers": ["2045…", "2045…"], "channel": "Rozetka"}` (`numbers` — масив або рядок через пробіл/кому; `channel`, `product` необов’язкові) — додає замовлення або оновлює наявні з тим самим номером. Відповідь `{added, updated, notFound, skipped, noAmount, orders}`.
- `POST /api/track/refresh` з `{"ids": [1000, 1001]}` або з фільтрами `{"employee": "Настя", "period": "2026-11", "status": "checking"}` (порожнє тіло `{}` — усі замовлення) — перевіряє наявні замовлення в НП і оновлює статус, суму й блок `np`; `"withDate": true` — також замінює дату на дату створення накладної. Номери не-ТТН пропускаються. Відповідь `{checked, updated, skipped, notFound, changes: [{id, number, from, to}]}`.

```bash
curl "http://127.0.0.1:8765/api/track?numbers=20451520852070"

curl -X POST -H "Content-Type: application/json" "http://127.0.0.1:8765/api/track" \
  -d '{"employee":"Настя","numbers":["20451520852070","20451521500117"],"channel":"Rozetka"}'

curl -X POST -H "Content-Type: application/json" "http://127.0.0.1:8765/api/track/refresh" -d '{"status":"checking"}'
```

### Імпорт аркуша

`POST /api/import` з одним із варіантів тіла:

- `{"employee": "Настя", "url": "https://docs.google.com/spreadsheets/d/…/edit#gid=0"}` — застосунок сам завантажить CSV (доступ до таблиці має бути «усім, хто має посилання», у посиланні має бути `gid` потрібного аркуша);
- `{"employee": "Товкес", "csv": "<текст CSV>", "date": "2026-11-05", "defaultStatus": "ok"}`.

Розуміє два формати аркуша: «Лист2» (B товар, C номер, D сума або ОТКАЗ/ОТМЕНА/НЕТ ДАННЫХ,
Q/R/S канал, T підсумковий статус) і «номер + сума» (A номер, B сума; статус для таких рядків —
`defaultStatus`, типово `ok`). Нові записи отримують дату `date` (типово сьогодні); повтори за
номером оновлюються, дата й товар лишаються. Відповідь `{parsed, added, updated, employeeId}`.

```bash
curl -X POST -H "Content-Type: application/json" "http://127.0.0.1:8765/api/import" \
  -d '{"employee":"Настя","url":"https://docs.google.com/spreadsheets/d/1uZD6oE1j6znYm4K4XxwlXqwj5UJVKG8TyHHvfZKvBFs/edit#gid=0"}'
```

### Резервна копія

- `GET /api/data` — уся база одним JSON (`settings`, `employees`, `orders`).
- `PUT /api/data` — замінити базу даними з такої копії (налаштування API при цьому не чіпаються). Відповідь `{employees, orders}`.

```bash
curl -o backup.json "http://127.0.0.1:8765/api/data"
curl -X PUT -H "Content-Type: application/json" "http://127.0.0.1:8765/api/data" --data-binary @backup.json
```

### Налаштування

- `GET /api/settings` — поточні (ставка, збережені посилання на таблиці, параметри API).
- `PUT /api/settings` з `{"ratePercent": 5}` — змінити загальну ставку; з `{"np": {"apiKey": "…"}}` — ключ API Нової Пошти (порожній — трекінг без ключа).

### Документація

`GET /api/docs` — цей текст у Markdown; `GET /api/docs?download=1` — як файл.

## Поради

- Кирилицю в адресі кодуйте: у curl `-G --data-urlencode "employee=Настя"`, у коді — `encodeURIComponent`. У тілі JSON кирилиця йде як є.
- Windows PowerShell: `Invoke-RestMethod "http://127.0.0.1:8765/api/salary?period=2026-11"`; файл — `Invoke-WebRequest "http://127.0.0.1:8765/api/export?format=xlsx" -OutFile зарплата.xlsx`.
- Python: `requests.get("http://127.0.0.1:8765/api/salary", params={"period": "2026-11"}).json()`.
- Усі дані лежать в одному файлі `data.json` (шлях показано у вкладці Налаштування); API пише в нього одразу.
