# Дискотека — заказ песен
- index.html — сайт для учеников
- admin.html — страница организатора (вход по паролю)
- server/ — бэкенд на своём сервере (bratoyd.fun): заявки в SQLite, файлы на диске
- worker.js, setup.sql — старый бэкенд на Cloudflare + Supabase, больше не используется

## Сервер
Ubuntu 24.04, Node 24, Caddy. Код в `/srv/disco/app`, данные (база и песни) в `/srv/disco/data`,
пароль админки и секреты в `/srv/disco/disco.env`.

Обновить код:

    scp server/server.js ubuntuuser@195.209.220.183:/tmp/
    ssh ubuntuuser@195.209.220.183 'sudo install -m 644 /tmp/server.js /srv/disco/app/ && sudo systemctl restart disco'

Сменить пароль админки: поправить `ADMIN_PASSWORD` в `/srv/disco/disco.env`, потом `sudo systemctl restart disco`.
Логи: `sudo journalctl -u disco -f`. Тесты: `node --test server/*.test.js`.
