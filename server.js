// HTTP: панель статуса серверного бота + ручная страница + API паузы.
const http = require('http');
const fs = require('fs');
const path = require('path');
const bot = require('./bot');

const PORT = process.env.PORT || 3000;
const PASSWORD = process.env.DASH_PASSWORD || '';

function authorized(req) {
  if (!PASSWORD) return true;
  const h = req.headers.authorization || '';
  if (!h.startsWith('Basic ')) return false;
  const [, pass] = Buffer.from(h.slice(6), 'base64').toString().split(/:(.*)/s);
  return pass === PASSWORD;
}

function send(res, code, type, body) {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-cache' });
  res.end(body);
}

const MANUAL_BANNER =
  '<div style="background:#f6465d;color:#fff;padding:8px 16px;font:600 13px sans-serif;text-align:center">' +
  '⚠ Бот уже работает 24/7 на сервере. Не нажимай здесь «Старт» с live — будет два бота. ' +
  '<a href="/" style="color:#fff;text-decoration:underline">Панель сервера</a></div>';

http.createServer(async (req, res) => {
  const url = (req.url || '/').split('?')[0];
  if (url === '/health') return send(res, 200, 'text/plain', 'ok');

  if (!authorized(req)) {
    res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Sell Grid"' });
    return res.end('auth required');
  }

  try {
    if (url === '/api/status') return send(res, 200, 'application/json; charset=utf-8', JSON.stringify(bot.status()));
    if (req.method === 'POST' && url === '/api/pause') { await bot.pause(true); return send(res, 200, 'application/json', '{"ok":true}'); }
    if (req.method === 'POST' && url === '/api/resume') { bot.resume(); return send(res, 200, 'application/json', '{"ok":true}'); }
    if (url === '/manual') {
      const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8').replace('<body>', '<body>' + MANUAL_BANNER);
      return send(res, 200, 'text/html; charset=utf-8', html);
    }
    return send(res, 200, 'text/html; charset=utf-8', fs.readFileSync(path.join(__dirname, 'dashboard.html')));
  } catch (e) {
    return send(res, 500, 'text/plain', 'error: ' + e.message);
  }
}).listen(PORT, '0.0.0.0', () => {
  console.log('HTTP on port ' + PORT);
  bot.start();
});

function shutdown() { console.log('SIGTERM — остановка цикла'); bot.stop(); setTimeout(() => process.exit(0), 500); }
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
process.on('unhandledRejection', e => console.error('unhandledRejection', e));
process.on('uncaughtException', e => console.error('uncaughtException', e));
