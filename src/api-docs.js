'use strict';
// Документація локального API у Markdown. Одне джерело для: вкладки «Налаштування»,
// кнопки «Завантажити .md», маршруту GET /api/docs і файлу API.md у репозиторії
// (`npm run docs`).
const { STATUS } = require('./lib');

// opts: {base, token, version}
function buildDocs(opts = {}) {
  const base = opts.base || 'http://127.0.0.1:8765';
  const token = opts.token || '';
  const version = opts.version ? ` (версія застосунку ${opts.version})` : '';
  const auth = token ? ` -H "Authorization: Bearer ${token}"` : '';
  const authNote = token
    ? 'У налаштуваннях задано ключ, тому кожен запит має нести його (див. нижче).'
    : 'Ключ не задано: запити приймаються без перевірки. Якщо відкриваєте API в мережу (адреса 0.0.0.0), обов’язково задайте ключ.';
  const statuses = Object.entries(STATUS).map(([k, v]) => `\`${k}\` — ${v}`).join(', ');

  return `# Локальний API «Розрахунок зарплат»${version}

Застосунок піднімає HTTP-сервер, через який інші програми й скрипти забирають і закидають
дані без участі вікна: замовлення, працівників, розрахунок зарплати, файли експорту, резервну копію.

- Адреса зараз: \`${base}\`
- Вмикається й налаштовується у вкладці **Налаштування → Локальний API** (адреса, порт, ключ).
- \`127.0.0.1\` — доступ лише з цього комп’ютера; \`0.0.0.0\` — також з локальної мережі.
- Усі відповіді — JSON у UTF-8 (крім файлів експорту й цієї документації).
- Помилка — JSON \`{"error": "…"}\` зі статусом 400 (поганий запит), 401 (ключ), 404, 413 (завеликий запит), 502 (Google недоступний), 500.

## Авторизація

${authNote}

Ключ передається одним із способів:

- заголовок \`Authorization: Bearer <ключ>\`
- заголовок \`X-Api-Key: <ключ>\`
- параметр \`?key=<ключ>\` в адресі

## Поля

**Працівник** — \`{id, name, ratePercent}\`. \`ratePercent\` порожнє (\`null\`) = загальна ставка з налаштувань.

**Замовлення** — \`{id, employeeId, product, number, amount, channel, status, date}\`:

| Поле | Опис |
|---|---|
| \`employee\` або \`employeeId\` | при створенні: id **або ім’я** працівника (регістр не важливий) |
| \`number\` | номер ТТН або замовлення; за ним зливаються повтори |
| \`amount\` | сума, число |
| \`product\` | назва товару (необов’язково) |
| \`channel\` | \`Rozetka\`, \`Пром 1\`…\`Пром 3\`, \`Епіцентр\` або порожньо |
| \`status\` | ${statuses}; невідоме значення → \`checking\` |
| \`date\` | \`YYYY-MM-DD\`; без дати — сьогодні. Період розрахунку береться з дати |

Зарплата = сума замовлень зі статусом \`ok\` × ставка (%). Інші статуси не рахуються.

## Маршрути

### Стан

\`GET /api/health\` → \`{ok, version, employees, orders, routes}\`

\`\`\`bash
curl${auth} "${base}/api/health"
\`\`\`

### Розрахунок зарплати

\`GET /api/salary?period=YYYY-MM\` — за місяць; без \`period\` — за весь час.
Відповідь: \`{period, ratePercent, rows: [{employeeId, name, ratePercent, total, done, refused, cancelled, nodata, checking, sumDone, salary}], totals: {total, done, sumDone, salary}}\`.

\`\`\`bash
curl${auth} "${base}/api/salary?period=2026-11"
\`\`\`

### Файл розрахунку

\`GET /api/export?format=xlsx|csv&period=YYYY-MM\` — той самий файл, що з кнопки «Експорт»:
аркуш «Зарплата» (підсумок на працівника) і «Замовлення» (усі замовлення періоду).

\`\`\`bash
curl${auth} -o зарплата-2026-11.xlsx "${base}/api/export?format=xlsx&period=2026-11"
\`\`\`

### Працівники

- \`GET /api/employees\` — список.
- \`POST /api/employees\` з \`{name, ratePercent?}\` → працівник (якщо ім’я вже є — повертає наявного).
- \`DELETE /api/employees/:id\` — видаляє працівника **разом із його замовленнями**.

\`\`\`bash
curl${auth} -X POST -H "Content-Type: application/json" "${base}/api/employees" -d '{"name":"Іваненко","ratePercent":6}'
\`\`\`

### Замовлення

- \`GET /api/orders?employee=&period=&status=&q=\` — фільтри необов’язкові: працівник (id або ім’я), місяць \`YYYY-MM\`, статус, пошук по товару чи номеру.
- \`POST /api/orders\` — один об’єкт або масив. Запис **з \`id\`** замінюється повністю; **без \`id\`** зливається за «працівник + номер»: якщо такий номер уже є, оновлюються статус, сума й канал, інакше додається новий. Повторна відправка того самого пакета не плодить дублікатів. Відповідь \`{added, updated, parsed}\`.
- \`DELETE /api/orders/:id\` → \`{deleted}\`.

\`\`\`bash
curl${auth} -G --data-urlencode "employee=Настя" --data-urlencode "period=2026-11" "${base}/api/orders"

curl${auth} -X POST -H "Content-Type: application/json" "${base}/api/orders" -d '[
  {"employee":"Настя","number":"20451500000001","amount":350,"status":"ok","channel":"Rozetka","product":"компас"},
  {"employee":"Товкес","number":"PRM-100000001","amount":1200,"status":"refused","channel":"Пром 2","date":"2026-11-03"}
]'
\`\`\`

### Імпорт аркуша

\`POST /api/import\` з одним із варіантів тіла:

- \`{"employee": "Настя", "url": "https://docs.google.com/spreadsheets/d/…/edit#gid=0"}\` — застосунок сам завантажить CSV (доступ до таблиці має бути «усім, хто має посилання», у посиланні має бути \`gid\` потрібного аркуша);
- \`{"employee": "Товкес", "csv": "<текст CSV>", "date": "2026-11-05", "defaultStatus": "ok"}\`.

Розуміє два формати аркуша: «Лист2» (B товар, C номер, D сума або ОТКАЗ/ОТМЕНА/НЕТ ДАННЫХ,
Q/R/S канал, T підсумковий статус) і «номер + сума» (A номер, B сума; статус для таких рядків —
\`defaultStatus\`, типово \`ok\`). Нові записи отримують дату \`date\` (типово сьогодні); повтори за
номером оновлюються, дата й товар лишаються. Відповідь \`{parsed, added, updated, employeeId}\`.

\`\`\`bash
curl${auth} -X POST -H "Content-Type: application/json" "${base}/api/import" \\
  -d '{"employee":"Настя","url":"https://docs.google.com/spreadsheets/d/1uZD6oE1j6znYm4K4XxwlXqwj5UJVKG8TyHHvfZKvBFs/edit#gid=0"}'
\`\`\`

### Резервна копія

- \`GET /api/data\` — уся база одним JSON (\`settings\`, \`employees\`, \`orders\`).
- \`PUT /api/data\` — замінити базу даними з такої копії (налаштування API при цьому не чіпаються). Відповідь \`{employees, orders}\`.

\`\`\`bash
curl${auth} -o backup.json "${base}/api/data"
curl${auth} -X PUT -H "Content-Type: application/json" "${base}/api/data" --data-binary @backup.json
\`\`\`

### Налаштування

- \`GET /api/settings\` — поточні (ставка, збережені посилання на таблиці, параметри API).
- \`PUT /api/settings\` з \`{"ratePercent": 5}\` — змінити загальну ставку.

### Документація

\`GET /api/docs\` — цей текст у Markdown; \`GET /api/docs?download=1\` — як файл.

## Поради

- Кирилицю в адресі кодуйте: у curl \`-G --data-urlencode "employee=Настя"\`, у коді — \`encodeURIComponent\`. У тілі JSON кирилиця йде як є.
- Windows PowerShell: \`Invoke-RestMethod "${base}/api/salary?period=2026-11"\`; файл — \`Invoke-WebRequest "${base}/api/export?format=xlsx" -OutFile зарплата.xlsx\`.
- Python: \`requests.get("${base}/api/salary", params={"period": "2026-11"}${token ? `, headers={"X-Api-Key": "${token}"}` : ''}).json()\`.
- Усі дані лежать в одному файлі \`data.json\` (шлях показано у вкладці Налаштування); API пише в нього одразу.
`;
}

module.exports = { buildDocs };

if (require.main === module) {
  process.stdout.write(buildDocs({ base: 'http://127.0.0.1:8765' }));
}
