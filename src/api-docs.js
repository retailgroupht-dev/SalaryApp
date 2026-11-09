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

  return `# Локальний API SalaryApp${version}

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

**Два набори замовлень.** Кожне замовлення належить одному з наборів (\`source\`):
\`auto\` — веде програма сама (збір із кабінетів Prom / Rozetka / Епіцентр, автоматичне оновлення);
\`manual\` — з реальних даних (вставлені з таблиці рядки, додані за номером або руками).
Набори не змішуються: повтори зливаються лише всередині свого набору. Зарплата рахується за одним набором
(\`source\` у запиті або \`salarySource\` у налаштуваннях, типово \`auto\`); будь-який набір вивантажується файлом через \`GET /api/orders?format=xlsx\`.

**Замовлення** — \`{id, employeeId, product, number, orderId, kind, source, amount, channel, status, date, track}\`:

| Поле | Опис |
|---|---|
| \`employee\` або \`employeeId\` | при створенні: id **або ім’я** працівника (регістр не важливий) |
| \`number\` | ТТН (порожньо, якщо відправлення ще не створено або замовлення скасовано). Повтори зливаються за ТТН (також за кодом посилки всередині номера) або за \`kind\` + \`orderId\` |
| \`orderId\`, \`kind\` | № замовлення в кабінеті та кабінет (\`rozetka\`, \`prom\`, \`epicentr\`); заповнюються автоматично з кабінетів |
| \`source\` | набір: \`auto\` або \`manual\` (типово \`manual\` для записів, створених через API чи руками) |
| \`amount\` | сума, число |
| \`product\` | назва товару (необов’язково) |
| \`channel\` | \`Rozetka\`, \`Пром 1\`…\`Пром 3\`, \`Епіцентр\` або порожньо |
| \`status\` | ${statuses}; невідоме значення → \`checking\` |
| \`date\` | \`YYYY-MM-DD\`; без дати — сьогодні. Період розрахунку береться з дати |
| \`track\` | результат останньої перевірки за номером: \`{checked, note, problem, np: {status, code, reason, received}, mp: {kind, channel, orderId, status}, rd: {status}}\` або \`null\` |

Зарплата = сума замовлень зі статусом \`ok\` × ставка (%). Інші статуси не рахуються.

## Маршрути

### Стан

\`GET /api/health\` → \`{ok, version, employees, orders, routes}\`

\`\`\`bash
curl${auth} "${base}/api/health"
\`\`\`

### Розрахунок зарплати

\`GET /api/salary?period=YYYY-MM&source=auto|manual\` — за місяць; без \`period\` — за весь час; без \`source\` — набір із налаштувань.
Відповідь: \`{period, source, ratePercent, rows: [{employeeId, name, ratePercent, total, done, refused, cancelled, nodata, checking, sumDone, salary}], totals: {total, done, sumDone, salary}}\`.

\`\`\`bash
curl${auth} "${base}/api/salary?period=2026-11"
\`\`\`

### Файл розрахунку

\`GET /api/export?format=xlsx|csv&period=YYYY-MM&source=auto|manual\` — той самий файл, що з кнопки «Експорт»:
аркуш «Зарплата» (підсумок на працівника) і «Замовлення» (усі замовлення періоду з вибраного набору).

\`\`\`bash
curl${auth} -o зарплата-2026-11.xlsx "${base}/api/export?format=xlsx&period=2026-11&source=auto"
\`\`\`

### Працівники

- \`GET /api/employees\` — список.
- \`POST /api/employees\` з \`{name, ratePercent?}\` → працівник (якщо ім’я вже є — повертає наявного).
- \`DELETE /api/employees/:id\` — видаляє працівника **разом із його замовленнями**.

\`\`\`bash
curl${auth} -X POST -H "Content-Type: application/json" "${base}/api/employees" -d '{"name":"Іваненко","ratePercent":6}'
\`\`\`

### Замовлення

- \`GET /api/orders?employee=&period=&status=&q=&source=\` — фільтри необов’язкові: працівник (id або ім’я), місяць \`YYYY-MM\`, статус, пошук по товару, ТТН чи № замовлення, набір \`auto|manual\`. З \`&format=xlsx|csv\` — той самий список файлом (кнопки «Експорт» на вкладках замовлень); колонка «Деталі» — що сказав перевізник чи кабінет (як рядок під статусом у вікні).
- \`POST /api/orders\` — один об’єкт або масив. Запис **з \`id\`** замінюється повністю; **без \`id\`** зливається за «працівник + номер» усередині свого набору (\`source\`, типово \`manual\`): якщо такий номер уже є, оновлюються статус, сума й канал, інакше додається новий. Повторна відправка того самого пакета не плодить дублікатів. Відповідь \`{added, updated, parsed}\`.
- \`DELETE /api/orders/:id\` → \`{deleted}\`.

\`\`\`bash
curl${auth} -G --data-urlencode "employee=Настя" --data-urlencode "period=2026-11" "${base}/api/orders"

curl${auth} -X POST -H "Content-Type: application/json" "${base}/api/orders" -d '[
  {"employee":"Настя","number":"20451500000001","amount":350,"status":"ok","channel":"Rozetka","product":"компас"},
  {"employee":"Товкес","number":"PRM-100000001","amount":1200,"status":"refused","channel":"Пром 2","date":"2026-11-03"}
]'
\`\`\`

### Пошук за номером: Нова Пошта + маркетплейси

Замовлення можна додавати лише за номером (ТТН Нової Пошти — 14 цифр, PRM-… Rozetka Delivery,
номер замовлення маркетплейсу). Застосунок робить те саме, що скрипт у Google Таблицях:

- **Нова Пошта** (усі ключі з кабінетів, береться найінформативніша відповідь): статус, дата
  створення накладної, дата отримання; з ключем відправника — ще сума післяплати й опис.
- **Rozetka → Prom.ua → Епіцентр** (кабінети з Налаштувань, у цьому порядку пріоритету):
  сума замовлення, дата продажу (створення замовлення), статус, канал = назва кабінету
  (наприклад «Пром 2»), товар. Rozetka шукає прямо за ТТН; Prom і Епіцентр гортаються від
  свіжих до старих до дати накладної мінус 14 днів (без дати — 180 днів).
- **Rozetka Delivery** (PRM-…): публічний трекінг, лише статус.

Зведення: відмова / повернення / скасування з будь-якого джерела (пріоритет ОТКАЗ > ВОЗВРАТ >
ОТМЕНА; повернення посилки перевізником перебиває «ОК» маркетплейсу) → \`refused\` або
\`cancelled\`; ніде не знайдено → \`nodata\`; Нова Пошта ще не видала посилку → \`checking\`;
інакше \`ok\`. Сума — з маркетплейсу, інакше з Нової Пошти, інакше \`null\` (вкажіть вручну).
Дата — з маркетплейсу, інакше дата накладної.

- \`GET /api/track?numbers=20450000000000,PRM-700000000\` — лише подивитися, без запису: \`{results: [{number, found, status, problem, amount, amountSource, date, channel, product, note, np, mp, rd}], errors}\`.
- \`POST /api/track\` з \`{"numbers": ["2045…", "PRM-…"]}\` (\`numbers\` — масив або рядок через пробіл/кому; \`channel\`, \`product\` необов’язкові й лише для нових; \`source\` типово \`manual\`) — додає замовлення або оновлює наявні з тим самим номером. Працівника вказувати не треба: пошук іде всіма ключами, а чиє замовлення, каже кабінет, у якому воно знайшлося (кабінет маркетплейсу з \`employeeId\`, інакше ключ відправника Нової Пошти з \`employeeId\`); якщо такого немає — наявне замовлення з цим номером у наборі, а коли працівник у базі один — він. Номери, чийого власника визначити не вдалося, не додаються й повертаються в \`noEmployee\`. \`"employee": "Настя"\` у тілі призначає всі номери вказаному працівникові. Відповідь \`{added, updated, notFound, noAmount, noEmployee, errors, orders}\`.
- \`POST /api/track/refresh\` з \`{"ids": [1000, 1001]}\` або з фільтрами \`{"employee": "Настя", "period": "2026-11", "status": "checking", "source": "auto"}\` (порожнє тіло \`{}\` — усі замовлення обох наборів) — перевіряє наявні замовлення й оновлює статус, суму, канал і блок \`track\`; \`"withDate": true\` — також замінює дату. Замовлення без номера пропускаються. Відповідь \`{checked, updated, skipped, notFound, errors, changes: [{id, number, from, to}]}\`.

\`\`\`bash
curl${auth} "${base}/api/track?numbers=20451520852070"

curl${auth} -X POST -H "Content-Type: application/json" "${base}/api/track" \\
  -d '{"numbers":["20451520852070","20451521500117"]}'

curl${auth} -X POST -H "Content-Type: application/json" "${base}/api/track/refresh" -d '{"status":"checking"}'
\`\`\`

### Вставка з таблиці

\`POST /api/import/paste\` з \`{"text": "…"}\` — рядки, скопійовані з колонок Google Таблиці (товар, ТТН або номер і,
необов’язково, працівник), розділені табуляцією; порядок колонок неважливий: номер упізнається за виглядом, працівник —
за ім’ям. Рядкам без імені працівника дає кабінет, який знайшов замовлення (як у \`POST /api/track\` без \`employee\`);
\`"employee": "Настя"\` у тілі призначає такі рядки вказаному працівникові. Відповідь
\`{parsed, added, updated, notFound, noAmount, noEmployee, errors, unknown: [{line, reason}]}\`.

### Відправлення з кабінетів

Без жодного ручного введення: усе, що створено в кабінетах Prom / Rozetka / Епіцентр за місяць,
звірене з Новою Поштою.

- \`GET /api/shipments?employee=Настя&period=2026-11\` — лише подивитися: \`{items: [{employeeId, employee, number, ttn, orderId, channel, kind, product, amount, date, status, problem, mpStatus, note, inBase}], errors}\`. Без \`employee\` — усі працівники, але замовлення спільних кабінетів (ключ без працівника) показуються лише для одного вибраного працівника.
- \`POST /api/shipments/add\` з \`{"employee": "Настя", "period": "2026-11"}\` — зібрати й додати в набір \`auto\` (повтори за «працівник + номер» чи № замовлення оновлюються). Відповідь \`{added, updated, collected, errors}\`.

### Автоматичне оновлення

\`POST /api/sync\` — те саме, що робить застосунок за розкладом (Налаштування → Автоматичне оновлення): за поточний
і попередній місяць зібрати відправлення з кабінетів кожного працівника й додати в замовлення, потім перевірити все зі
статусом \`checking\`. Відповідь \`{months, collected, added, updated, checked, changed, errors}\`; якщо вже виконується — \`{skipped: true}\`.
Розклад: \`PUT /api/settings\` з \`{"auto": {"enabled": true, "hours": 6}}\` (1, 3, 6, 12 або 24 години).

### Резервна копія

- \`GET /api/data\` — уся база одним JSON (\`settings\`, \`employees\`, \`orders\`).
- \`PUT /api/data\` — замінити базу даними з такої копії (налаштування API при цьому не чіпаються). Відповідь \`{employees, orders}\`.

\`\`\`bash
curl${auth} -o backup.json "${base}/api/data"
curl${auth} -X PUT -H "Content-Type: application/json" "${base}/api/data" --data-binary @backup.json
\`\`\`

### Налаштування

- \`GET /api/settings\` — поточні (ставка, набір для зарплати, параметри API, кабінети з ключами, автооновлення).
- \`PUT /api/settings\` з \`{"ratePercent": 5}\` — змінити загальну ставку; з \`{"salarySource": "auto|manual"}\` — який набір рахувати в зарплаті; з \`{"accounts": [{"kind": "np|prom|rozetka|epicentr", "name": "Пром 2", "token": "…", "employeeId": 5}]}\` — замінити список кабінетів (назва кабінету стає каналом замовлення; \`employeeId\` — чиї замовлення в цьому кабінеті: знайдене ним замовлення отримує цього працівника; порожній = спільний кабінет, він власника не визначає).
- \`POST /api/settings/accounts/import\` з \`{"script": "<код Apps Script таблиці>", "employee": "Настя"}\` — додати ключі з масивів \`NOVA_POSHTA_ACCOUNTS\`, \`PROM_ACCOUNTS\`, \`EPICENTER_ACCOUNTS\`, \`ROZETKA_ACCOUNTS\`, прив’язавши до працівника (без \`employee\` — спільні). Той самий ключ у двох працівників стає спільним. Відповідь \`{parsed, added, accounts}\`.
- \`GET /api/settings/accounts/test\` — перевірити всі кабінети: \`[{name, kind, ok, message}]\`.

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
