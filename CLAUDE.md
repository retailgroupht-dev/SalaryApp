# CanculateSalaryApp — SalaryApp

Десктопний застосунок (Electron, Windows/macOS) для розрахунку зарплат працівників за
виконаними замовленнями. Замінює ручний підрахунок у Google Таблицях «Настя Пром+Розетка»
і «Товкес3 пром+Епіцентр» (журнали замовлень без формул, статуси дописує сторонній скрипт).

Зарплата = сума замовлень зі статусом «Виконано» × ставка (за замовчуванням 5 %, є
індивідуальна ставка на працівника). Відмови, скасування, «немає даних» не рахуються.
Період — місяць за полем «дата» замовлення: при додаванні за номером — дата продажу з маркетплейсу
(інакше дата накладної НП), при імпорті з таблиці — день імпорту (прапорець «також дату» в перевірці замінює).

## Файли

- `src/lib.js` — чиста логіка: CSV, зіставлення рядків аркуша «Лист2» (B товар, C номер,
  D сума/ОТКАЗ/ОТМЕНА/НЕТ ДАННЫХ, Q/R/S канал, T статус) і аркуша «номер + сума»,
  злиття за номером, розрахунок, запис XLSX (власний zip без бібліотек). Тести — `test/`.
- `src/np.js` — трекінг Нової Пошти (`TrackingDocument/getStatusDocuments`, пакети по 100,
  кілька ключів — береться найінформативніша відповідь): статус, дати, з ключем відправника — сума.
  Коди НП → статуси: 9/10/11 ok, 102/103/105/106/108 refused, 2 cancelled, 3 nodata, решта checking.
- `src/marketplaces.js` — Prom (`orders/list`, date_from), Rozetka (`orders/search`, `?ttn=`,
  pageSize=100), Епіцентр (`v4/oms/orders`, курсор), Rozetka Delivery (PRM-…, публічний трекінг);
  пошук замовлення за номером у порядку Rozetka → Prom → Епіцентр; `parseScriptAccounts` —
  ключі з Apps Script таблиць. Перенесено зі скрипта «Проверка заказов» (файли `nastya.txt`,
  `tovkes.txt` у теці — з ключами, у `.gitignore`).
- `src/lookup.js` — зведення джерел за правилами скрипта: сума з маркетплейсу (інакше НП),
  проблема ОТКАЗ > ВОЗВРАТ > ОТМЕНА з будь-якого джерела, перевізник перебиває маркетплейс,
  ніде немає → nodata, НП ще не видала → checking (у таблиці такі рядки вже «ОК» — свідома відмінність).
  Кабінети — `settings.accounts: [{kind: np|prom|rozetka|epicentr, name, token}]`, назва = канал.
- `src/store.js` — усі дані в одному `data.json` у теці користувача
  (Win `%APPDATA%\SalaryApp\`, Mac `~/Library/Application Support/SalaryApp/`; дані зі старої теки
  «Розрахунок зарплат» переносяться при першому запуску). Іконка — `build/icon.png` (генерує `build/make-icon.js`).
- `src/service.js` — уся робота з даними (працівники, замовлення, імпорт, розрахунок, експорт,
  резервна копія); нею користуються і вікно (IPC), і HTTP API. Помилки — `ApiError(status, msg)`.
- `src/api.js` — локальний HTTP API (`http`, JSON), маршрути в `ROUTES_DOC`.
- `src/main.js` — вікно, IPC, діалоги файлів, автооновлення; імпорт за посиланням на Google
  Таблицю (експорт CSV, доступ «усім за посиланням», у посиланні має бути `#gid=` аркуша).
- `src/renderer/` — інтерфейс (вкладки Зарплата / Замовлення / Працівники / Налаштування).

## Локальний API

Вмикається в Налаштуваннях (типово увімкнено, `http://127.0.0.1:8765`, без ключа). Ключ —
`Authorization: Bearer …`, `X-Api-Key` або `?key=`. Адреса `0.0.0.0` відкриває API в локальну
мережу — лише з ключем. Маршрути (повний перелік і приклади curl — у вкладці Налаштування):
`GET /api/health`, `GET /api/salary?period=YYYY-MM`, `GET|POST /api/employees`,
`DELETE /api/employees/:id`, `GET /api/orders?employee=&period=&status=&q=`,
`POST /api/orders` (об’єкт або масив; без `id` — злиття за «працівник + номер»),
`DELETE /api/orders/:id`, `POST /api/import` (`{employee, url}` або `{employee, csv}`),
`GET /api/track?numbers=` (подивитися), `POST /api/track` (`{employee, numbers}` — додати за номером),
`POST /api/track/refresh` (`{ids}` або фільтри, `withDate`) — перевірити наявні,
`POST /api/settings/accounts/import` (`{script}`), `GET /api/settings/accounts/test`,
`GET /api/export?format=xlsx|csv&period=`, `GET|PUT /api/data` (резервна копія),
`GET|PUT /api/settings`, `GET /api/docs`. `employee` приймає id або ім’я. Тести API — `test/api.test.js`.

Повна документація — `src/api-docs.js` (одне джерело): показується у вкладці Налаштування,
завантажується звідти файлом `.md`, віддається `GET /api/docs`, а `npm run docs` оновлює
`API.md` у репозиторії. Змінивши маршрути, оновити `api-docs.js` і перегенерувати `API.md`.

## Запуск і перевірка

```bash
npm install
npm test            # тести логіки
npm start           # запуск у режимі розробки
SALARY_DATA_DIR=/tmp/sal SALARY_SMOKE_SHOT=/tmp/sal.png npm start   # знімок вікна без людини
npm run dist        # збірка інсталятора в dist/ (без публікації)
npm run pack && open dist/mac-arm64/SalaryApp.app   # зібраний застосунок (у режимі розробки macOS показує назву «Electron»)
```

## Випуск версії й автооновлення

1. Підняти `version` у `package.json`.
2. Запушити тег `salary-v<версія>` — workflow `.github/workflows/salary-app-release.yml`
   збирає Windows (nsis) і macOS (dmg+zip) і публікує реліз `v<версія>` у GitHub Releases
   репозиторію `retailgroupht-dev/ht-dron` (`build.publish` у `package.json`).
3. Застосунок при запуску перевіряє реліз через electron-updater, завантажує й ставить
   після перезапуску. Обмеження: без сертифіката Apple автооновлення на macOS не працює
   (лише завантаження з Releases вручну); якщо репозиторій приватний, оновлювач не бачить
   релізів — потрібен окремий публічний репозиторій для релізів (змінити `build.publish`).

Цей проєкт окремий від схеми «робочий чат / адміністратор» решти репозиторію: чат, відкритий
у цій папці, сам комітить і пушить (у репо він лише для зручності). `node_modules/` і `dist/`
у `.gitignore`.
