# Sell Grid — Bybit Short (режим Щукина)

Статическая страница + минимальный Node-сервер для Railway.

## Деплой на Railway
1. Railway → New Project → Deploy from GitHub repo → выбрать этот репозиторий.
2. Railway сам запустит `npm start` (порт берётся из `PORT`).
3. Settings → Networking → Generate Domain.

Проверка: `/health` отвечает `ok`.

## Локально
```
npm start
# http://localhost:3000
```
