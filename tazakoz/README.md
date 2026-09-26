# TazaKöz

Требуется Node.js >= 22.5 (https://nodejs.org). Зависимостей нет.

    npm start        # http://localhost:3000

Переменные окружения: `PORT`, `INSPECTOR_KEY` (по умолчанию `demo-inspector`), `DB_FILE`.
Кабинет инспектора: кнопка «Инспектор» в шапке → ввести ключ.
База — SQLite-файл `server/tazakoz.db (статика лежит в docs/)`, создаётся и заполняется демо-данными при первом запуске.

API: `GET /api/public`, `GET|POST /api/cases` (заголовок `X-User-Id`),
`GET /api/inspector/cases`, `PATCH /api/inspector/cases/:id`, `POST /api/inspector/flag` (заголовок `X-Inspector-Key`).
