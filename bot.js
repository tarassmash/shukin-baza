// =====================================================================
// Sell Grid Shukin — серверный бот 24/7 (Bybit v5, USDT-перпы)
// Логика перенесена из index.html (runSellGridCycle / processSymbol /
// scanUltraVol1m / analyzeShukinContext) + лимит удержания позиции.
// =====================================================================
'use strict';
const crypto = require('crypto');

const env = (k, d) => (process.env[k] !== undefined && process.env[k] !== '' ? process.env[k] : d);
const num = (k, d) => { const v = parseFloat(env(k, d)); return isFinite(v) ? v : d; };

const CFG = {
  key: env('BYBIT_API_KEY', ''),
  secret: env('BYBIT_API_SECRET', ''),
  testnet: env('BYBIT_TESTNET', '0') === '1',
  live: env('LIVE', '1') === '1',
  enabled: env('BOT_ENABLED', '1') === '1',
  category: 'linear',
  interval: env('INTERVAL', '1'),          // таймфрейм свечей (ультра-вола = 1m)
  cycleSec: Math.max(2, num('CYCLE_SEC', 3)),
  // --- режим Щукина ---
  shukin: env('SHUKIN', '1') === '1',
  gridStepPct: num('GRID_STEP_PCT', 1.0),
  gridLevels: Math.max(1, Math.min(10, Math.round(num('GRID_LEVELS', 5)))),
  tpPct: num('TP_PCT', 0.7),
  slPct: num('SL_PCT', 10),
  orderUsdt: num('ORDER_USDT', 12),
  maxDailyLoss: num('MAX_DAILY_LOSS', 15),
  makerExit: env('MAKER_EXIT', '1') === '1',
  spikeProtect: env('SPIKE_PROTECT', '1') === '1',
  maxSpikePct: num('MAX_SPIKE_PCT', 0.5),
  volFilter: env('VOL_FILTER', '1') === '1',
  minAtrPct: num('MIN_ATR_PCT', 0.2),
  maxAtrPct: num('MAX_ATR_PCT', 5),
  // --- 24/7 управление ---
  maxHoldMin: num('MAX_HOLD_MIN', 90),        // макс. время жизни позиции
  maxSymbols: Math.max(1, Math.round(num('MAX_SYMBOLS', 1))), // сколько монет из скана торговать одновременно
  maxOpenPositions: Math.max(1, Math.round(num('MAX_OPEN_POSITIONS', 3))),
  maxPosUsdt: num('MAX_POS_USDT', 120),       // потолок добора в одну монету
  scanEveryMin: Math.max(1, num('SCAN_EVERY_MIN', 5)),
  cooldownMin: num('COOLDOWN_MIN', 30)        // пауза по монете после стопа/лимита времени
};
if (CFG.shukin) {
  if (CFG.gridStepPct < 1) CFG.gridStepPct = 1;
  if (CFG.tpPct < 0.7) CFG.tpPct = 0.7;
  if (CFG.slPct < 10) CFG.slPct = 10;
}

const BASE = env('BYBIT_BASE', '') || (CFG.testnet ? 'https://api-testnet.bybit.com' : 'https://api.bybit.com');

// ---------------------------------------------------------------- state
const S = {
  startedAt: Date.now(),
  paused: !CFG.enabled,
  busy: false,
  cycles: 0,
  lastCycleAt: 0,
  lastError: '',
  dayKey: '',
  dayPnl: 0,
  dayTrades: 0,
  lastPnlFetch: 0,
  lastScanAt: 0,
  hotList: [],          // последние результаты скана
  targets: [],          // монеты, где бот ставит сетку
  cooldown: {},         // symbol -> until ts
  openedAt: {},         // symbol -> { side, ts }
  watch: {},            // symbol -> { priceHistory, candles, candlesAt, oi, oiAt, status, mid, rsi, atrPct, signal }
  instCache: {},        // symbol -> { ts, inst }
  positions: [],
  ordersCount: 0,
  logs: []
};

function log(msg, type) {
  const line = `[${new Date().toISOString().slice(11, 19)}] ${type === 'err' ? '❌ ' : type === 'ok' ? '✅ ' : ''}${msg}`;
  console.log(line);
  S.logs.unshift(line);
  if (S.logs.length > 400) S.logs.length = 400;
}

// ---------------------------------------------------------------- http
async function httpJson(url, opts) {
  const res = await fetch(url, Object.assign({ signal: AbortSignal.timeout(10000) }, opts || {}));
  const text = await res.text();
  try { return JSON.parse(text); }
  catch (e) { throw new Error(`HTTP ${res.status}: ${text.slice(0, 120).replace(/\s+/g, ' ')}`); }
}

async function publicGet(path, params) {
  const q = Object.keys(params || {}).map(k => k + '=' + encodeURIComponent(params[k])).join('&');
  return httpJson(BASE + path + (q ? '?' + q : ''));
}

async function signedRequest(method, path, params) {
  if (!CFG.key || !CFG.secret) throw new Error('Нет BYBIT_API_KEY / BYBIT_API_SECRET');
  const ts = Date.now().toString();
  const recv = '10000';
  let query = '', body = '';
  if (method === 'GET') {
    query = Object.keys(params || {}).sort().map(k => k + '=' + encodeURIComponent(params[k])).join('&');
  } else {
    body = JSON.stringify(params || {});
  }
  const sign = crypto.createHmac('sha256', CFG.secret)
    .update(ts + CFG.key + recv + (method === 'GET' ? query : body)).digest('hex');
  return httpJson(BASE + path + (query ? '?' + query : ''), {
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-BAPI-API-KEY': CFG.key,
      'X-BAPI-SIGN': sign,
      'X-BAPI-TIMESTAMP': ts,
      'X-BAPI-RECV-WINDOW': recv
    },
    body: method === 'GET' ? undefined : body
  });
}

// ---------------------------------------------------------------- helpers
function roundToStep(v, step) {
  step = parseFloat(step) || 0.01;
  const p = Math.round(1 / step);
  return Math.round(v * p) / p;
}
function floorToStep(v, step) {
  step = parseFloat(step) || 0.001;
  const n = Math.floor(v / step + 1e-9);
  const dec = (String(step).split('.')[1] || '').length;
  return parseFloat((n * step).toFixed(dec));
}
function fmt(n) {
  if (n == null || isNaN(n)) return '—';
  const a = Math.abs(n);
  if (a >= 1000) return n.toFixed(2);
  if (a >= 1) return n.toFixed(4);
  if (a >= 0.01) return n.toFixed(6);
  return n.toFixed(8);
}
const isOurs = o => (o.orderLinkId || '').startsWith('sg_');
const sleep = ms => new Promise(r => setTimeout(r, ms));

function inCooldown(sym) { return (S.cooldown[sym] || 0) > Date.now(); }
function setCooldown(sym) {
  if (CFG.cooldownMin > 0) S.cooldown[sym] = Date.now() + CFG.cooldownMin * 60000;
}

function watchOf(sym) {
  if (!S.watch[sym]) S.watch[sym] = { priceHistory: [], candles: [], candlesAt: 0, oi: [], oiAt: 0, status: '—' };
  return S.watch[sym];
}

// ---------------------------------------------------------------- market data
async function getInstrument(symbol) {
  const c = S.instCache[symbol];
  if (c && Date.now() - c.ts < 3600000) return c.inst;
  const j = await publicGet('/v5/market/instruments-info', { category: CFG.category, symbol });
  if (j.retCode !== 0) throw new Error(j.retMsg);
  const info = j.result?.list?.[0];
  if (!info) throw new Error('Инструмент не найден ' + symbol);
  const inst = {
    tickSize: info.priceFilter?.tickSize || '0.01',
    qtyStep: info.lotSizeFilter?.qtyStep || '0.001',
    minQty: info.lotSizeFilter?.minOrderQty || '0.001',
    minNotional: parseFloat(info.lotSizeFilter?.minNotionalValue || '5')
  };
  S.instCache[symbol] = { ts: Date.now(), inst };
  return inst;
}

async function getOrderBook(symbol) {
  const j = await publicGet('/v5/market/orderbook', { category: CFG.category, symbol, limit: 5 });
  if (j.retCode !== 0) throw new Error(j.retMsg);
  return {
    bids: (j.result?.b || []).map(([p]) => parseFloat(p)),
    asks: (j.result?.a || []).map(([p]) => parseFloat(p))
  };
}

function sanitizeCandles(raw) {
  const m = new Map();
  for (const c of raw || []) if (c.time && isFinite(c.close)) m.set(c.time, c);
  return [...m.values()].sort((a, b) => a.time - b.time);
}

async function getKlines(symbol, interval, limit) {
  const j = await publicGet('/v5/market/kline', { category: CFG.category, symbol, interval, limit: limit || 200 });
  if (j.retCode !== 0) throw new Error(j.retMsg);
  return sanitizeCandles((j.result?.list || []).map(r => ({
    time: Math.floor(parseInt(r[0], 10) / 1000),
    open: parseFloat(r[1]), high: parseFloat(r[2]), low: parseFloat(r[3]),
    close: parseFloat(r[4]), volume: parseFloat(r[5] || 0)
  })));
}

function mapOiInterval(tf) {
  const m = { '1': '5min', '3': '5min', '5': '5min', '15': '15min', '30': '30min', '60': '1h', '240': '4h', 'D': '1d' };
  return m[String(tf)] || '5min';
}

async function getOpenInterest(symbol, interval, limit) {
  const j = await publicGet('/v5/market/open-interest', {
    category: CFG.category, symbol, intervalTime: mapOiInterval(interval), limit: limit || 50
  });
  if (j.retCode !== 0) throw new Error(j.retMsg || 'OI error');
  return (j.result?.list || []).map(r => ({
    time: Math.floor(parseInt(r.timestamp, 10) / 1000),
    value: parseFloat(r.openInterest || 0)
  })).reverse();
}

// ---------------------------------------------------------------- account
async function getAllPositions() {
  const j = await signedRequest('GET', '/v5/position/list', { category: CFG.category, settleCoin: 'USDT', limit: 200 });
  if (j.retCode !== 0) throw new Error('positions: ' + j.retMsg);
  return (j.result?.list || [])
    .filter(p => Math.abs(parseFloat(p.size || 0)) > 0)
    .map(p => ({
      symbol: p.symbol,
      side: p.side,
      size: parseFloat(p.size),
      avgPrice: parseFloat(p.avgPrice),
      markPrice: parseFloat(p.markPrice || 0),
      unrealisedPnl: parseFloat(p.unrealisedPnl || 0),
      createdTime: parseInt(p.createdTime || '0', 10)
    }));
}

async function getAllOpenOrders() {
  const out = [];
  let cursor = '';
  for (let page = 0; page < 10; page++) {
    const params = { category: CFG.category, settleCoin: 'USDT', limit: 50 };
    if (cursor) params.cursor = cursor;
    const j = await signedRequest('GET', '/v5/order/realtime', params);
    if (j.retCode !== 0) throw new Error('orders: ' + j.retMsg);
    out.push(...(j.result?.list || []));
    cursor = j.result?.nextPageCursor || '';
    if (!cursor || !(j.result?.list || []).length) break;
  }
  return out;
}

async function cancelOrder(symbol, orderId) {
  const j = await signedRequest('POST', '/v5/order/cancel', { category: CFG.category, symbol, orderId });
  if (j.retCode !== 0 && j.retCode !== 110001) log(`cancel ${symbol}: ${j.retMsg}`, 'err');
  return j;
}

async function cancelOurOrders(symbol, orders, filterFn) {
  const ours = orders.filter(o => o.symbol === symbol && isOurs(o) && (!filterFn || filterFn(o)));
  for (const o of ours) { try { await cancelOrder(symbol, o.orderId); } catch (e) {} }
  if (ours.length) log(`${symbol}: снято наших ордеров ${ours.length}`);
  return ours.length;
}

async function closeMarket(pos, why) {
  const side = pos.side === 'Buy' ? 'Sell' : 'Buy';
  const j = await signedRequest('POST', '/v5/order/create', {
    category: CFG.category, symbol: pos.symbol, side,
    orderType: 'Market', qty: String(pos.size), reduceOnly: true, positionIdx: 0,
    orderLinkId: 'sg_close_' + (why || 'x') + '_' + Date.now()
  });
  if (j.retCode !== 0) throw new Error(`close ${pos.symbol}: ${j.retMsg}`);
  log(`${pos.symbol}: позиция ${pos.side} ${pos.size} закрыта market (uPnL ${pos.unrealisedPnl.toFixed(3)})`, 'ok');
}

async function placeMakerExit(symbol, pos, tpPrice, inst) {
  const side = pos.side === 'Buy' ? 'Sell' : 'Buy';
  const price = roundToStep(tpPrice, inst.tickSize);
  const body = {
    category: CFG.category, symbol, side, orderType: 'Limit',
    qty: String(pos.size), price: String(price), timeInForce: 'PostOnly',
    reduceOnly: true, positionIdx: 0, orderLinkId: 'sg_tp_' + Date.now()
  };
  let j = await signedRequest('POST', '/v5/order/create', body);
  if (j.retCode !== 0) {
    body.timeInForce = 'GTC';
    body.orderLinkId = 'sg_tp_' + Date.now() + '_g';
    j = await signedRequest('POST', '/v5/order/create', body);
  }
  if (j.retCode === 0) log(`${symbol}: maker TP ${pos.size} @ ${price}`, 'ok');
  else log(`${symbol}: maker TP fail: ${j.retMsg}`, 'err');
  return j.retCode === 0 ? body.orderLinkId : '';
}

// почему наш ордер исчез (отменён биржей и т.п.) — пишем в лог
async function explainOrder(symbol, orderLinkId) {
  try {
    const j = await signedRequest('GET', '/v5/order/history', { category: CFG.category, symbol, orderLinkId });
    const o = j.result?.list?.[0];
    if (o) log(`${symbol}: TP-ордер ${o.orderStatus}${o.cancelType && o.cancelType !== 'UNKNOWN' ? ' · ' + o.cancelType : ''}${o.rejectReason && o.rejectReason !== 'EC_NoError' ? ' · ' + o.rejectReason : ''}`);
  } catch (e) {}
}

async function placeSellLimit(symbol, qty, price, tp, sl, inst) {
  const limitPrice = roundToStep(price, inst.tickSize);
  const body = {
    category: CFG.category, symbol, side: 'Sell', orderType: 'Limit',
    qty: String(qty), price: String(limitPrice), timeInForce: 'GTC', positionIdx: 0,
    orderLinkId: 'sg_s_' + Date.now() + '_' + Math.floor(Math.random() * 999)
  };
  if (sl) { body.stopLoss = String(sl); body.slTriggerBy = 'LastPrice'; }
  if (tp && !CFG.makerExit) { body.takeProfit = String(tp); body.tpTriggerBy = 'LastPrice'; }
  const j = await signedRequest('POST', '/v5/order/create', body);
  if (j.retCode === 0) log(`${symbol}: sell limit ${qty} @ ${limitPrice}`, 'ok');
  else log(`${symbol}: sell ${qty} @ ${limitPrice} — ${j.retMsg}`, 'err');
  return j;
}

// ---------------------------------------------------------------- чья позиция и когда открыта
// По истории исполнений идём от свежих сделок назад, пока размер позиции не станет 0.
// Так получаем время открытия и сделки, из которых позиция набрана.
// Позиция «бота», если хоть одна из этих сделок — по ордеру бота (orderLinkId sg_…).
async function getPosMeta(pos) {
  const c = S.openedAt[pos.symbol];
  if (c && c.side === pos.side) return c;
  const j = await signedRequest('GET', '/v5/execution/list', { category: CFG.category, symbol: pos.symbol, limit: 100 });
  if (j.retCode !== 0) throw new Error('executions: ' + j.retMsg);
  const execs = (j.result?.list || []).filter(e => parseFloat(e.execQty || 0) > 0 && (e.execType || 'Trade') !== 'Funding');
  let running = pos.side === 'Buy' ? pos.size : -pos.size;
  const eps = Math.max(pos.size * 1e-6, 1e-12);
  let ts = 0, ours = false;
  for (const e of execs) {                 // newest -> oldest
    const q = parseFloat(e.execQty);
    const signed = e.side === 'Buy' ? q : -q;
    running -= signed;
    ts = parseInt(e.execTime, 10);
    if ((e.orderLinkId || '').startsWith('sg_s_')) ours = true;
    if (Math.abs(running) <= eps) break;
  }
  if (!ts) ts = pos.createdTime || 0;      // нет сделок за 7 дней → старая и не наша
  const meta = { side: pos.side, ts, ours };
  S.openedAt[pos.symbol] = meta;
  log(`${pos.symbol}: позиция ${pos.side} ${ours ? 'БОТА' : 'чужая (не трогаю)'}, открыта ${ts ? new Date(ts).toISOString().slice(0, 16).replace('T', ' ') + ' UTC' : 'давно'}`);
  return meta;
}

// ---------------------------------------------------------------- индикаторы
function estimateAtrPct(candles, period) {
  if (!candles || candles.length < period + 1) return null;
  let sum = 0;
  for (let i = candles.length - period; i < candles.length; i++) {
    const c = candles[i], prev = candles[i - 1];
    sum += Math.max(c.high - c.low, Math.abs(c.high - prev.close), Math.abs(c.low - prev.close));
  }
  const last = candles[candles.length - 1].close;
  return last ? (sum / period) / last : null;
}

function calculateRSI(candles, period) {
  if (!candles || candles.length < period + 1) return null;
  let gains = 0, losses = 0;
  for (let i = candles.length - period; i < candles.length; i++) {
    const d = candles[i].close - candles[i - 1].close;
    if (d >= 0) gains += d; else losses -= d;
  }
  if (losses === 0) return 100;
  return 100 - 100 / (1 + (gains / period) / (losses / period));
}

function buildCvd(candles) {
  let cum = 0;
  return candles.map(c => { cum += c.close >= c.open ? (c.volume || 0) : -(c.volume || 0); return { time: c.time, value: cum }; });
}

function analyzeShukinContext(candles, oiData) {
  const r = { allowShort: true, reason: 'OK', oiTrend: '—', cvdTrend: '—', oiChangePct: 0, cvdSlope: 0 };
  if (!candles || candles.length < 10) { r.allowShort = false; r.reason = 'мало данных'; return r; }
  const cvd = buildCvd(candles);
  let oiTrend = 'n/a', oiChangePct = 0;
  if (oiData && oiData.length >= 6) {
    const avg = a => a.reduce((s, x) => s + x.value, 0) / (a.length || 1);
    const aR = avg(oiData.slice(-4)), aP = avg(oiData.slice(-8, -4));
    oiChangePct = aP > 0 ? ((aR - aP) / aP) * 100 : 0;
    oiTrend = oiChangePct > 1.5 ? 'растёт' : oiChangePct < -1.0 ? 'падает' : 'флэт';
  }
  r.oiTrend = oiTrend; r.oiChangePct = oiChangePct;
  const tail = cvd.slice(-8);
  let cvdSlope = 0;
  if (tail.length >= 4) {
    const mid = Math.floor(tail.length / 2);
    const avgV = a => a.reduce((s, x) => s + x.value, 0) / (a.length || 1);
    const a1 = avgV(tail.slice(0, mid)), a2 = avgV(tail.slice(mid));
    cvdSlope = (a2 - a1) / (Math.abs(a2) > 1e-9 ? Math.abs(a2) : 1);
  }
  r.cvdSlope = cvdSlope;
  r.cvdTrend = cvdSlope > 0.03 ? 'покупки' : cvdSlope < -0.03 ? 'продажи' : 'нейтр.';
  const rsi = calculateRSI(candles, 14);
  const last = candles[candles.length - 1];
  const ago = candles[Math.max(0, candles.length - 12)];
  const pumpPct = ago && ago.close ? ((last.close - ago.close) / ago.close) * 100 : 0;
  if (oiTrend === 'растёт' && oiChangePct > 2.5) { r.allowShort = false; r.reason = 'OI растёт — рано шортить'; }
  else if (cvdSlope > 0.08 && oiTrend === 'растёт') { r.allowShort = false; r.reason = 'OI↑ + CVD покупки'; }
  else if (cvdSlope > 0.12) { r.allowShort = false; r.reason = 'CVD сильные покупки'; }
  else if (oiTrend === 'падает' || cvdSlope < -0.02) r.reason = oiTrend === 'падает' ? 'OI падает' : 'CVD продажи';
  else if (pumpPct > 3 && (oiTrend === 'флэт' || oiTrend === 'n/a') && cvdSlope <= 0.05) r.reason = 'памп выдыхается';
  else if (rsi != null && rsi >= 70 && cvdSlope <= 0.04) r.reason = 'RSI перекуп + CVD не тянет';
  else r.reason = 'нейтральный контекст';
  return r;
}

// ---------------------------------------------------------------- скан ультра-волатильных 1m
function candleRangePct(k, n) {
  const t = k.slice(-Math.max(1, n));
  let hi = -Infinity, lo = Infinity;
  for (const c of t) { if (c.high > hi) hi = c.high; if (c.low < lo) lo = c.low; }
  const last = t[t.length - 1].close || 0;
  return last ? ((hi - lo) / last) * 100 : 0;
}
function lastMovePct(k, n) {
  if (k.length < 2) return 0;
  const last = k[k.length - 1], prev = k[Math.max(0, k.length - 1 - n)];
  return prev && prev.close ? ((last.close - prev.close) / prev.close) * 100 : 0;
}
function volSpike(k, lb) {
  if (k.length < lb + 2) return 1;
  const last = k[k.length - 1].volume || 0;
  const prev = k.slice(-lb - 1, -1);
  const avg = prev.reduce((s, c) => s + (c.volume || 0), 0) / (prev.length || 1);
  return avg > 0 ? last / avg : 1;
}
async function mapPool(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  async function worker() {
    while (i < items.length) { const idx = i++; try { out[idx] = await fn(items[idx]); } catch (e) { out[idx] = null; } }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

async function scanUltraVol1m() {
  const res = await publicGet('/v5/market/tickers', { category: CFG.category });
  if (res.retCode !== 0 || !res.result?.list) throw new Error('Тикеры недоступны: ' + (res.retMsg || ''));
  const pool = res.result.list
    .filter(t => t.symbol.endsWith('USDT') && parseFloat(t.turnover24h || 0) > 1500000)
    .sort((a, b) => Math.abs(parseFloat(b.price24hPcnt || 0)) - Math.abs(parseFloat(a.price24hPcnt || 0)))
    .slice(0, 48);
  const scored = await mapPool(pool, 6, async coin => {
    const k = await getKlines(coin.symbol, '1', 40);
    if (!k || k.length < 16) return null;
    const range15 = candleRangePct(k, 15), range5 = candleRangePct(k, 5), range1 = candleRangePct(k, 1);
    const move5 = lastMovePct(k, 5), move1 = lastMovePct(k, 1);
    const atr = estimateAtrPct(k, 14);
    const atrPct = atr != null ? atr * 100 : 0;
    const spike = volSpike(k, 12);
    const score = range15 * 1.4 + range5 * 1.8 + range1 * 2.2 + Math.abs(move5) * 1.2 +
      Math.abs(move1) * 1.5 + atrPct * 1.6 + Math.min(spike, 6) * 0.35;
    const hot = range15 >= 0.70 || range5 >= 0.45 || range1 >= 0.28 || Math.abs(move5) >= 0.40 || atrPct >= 0.22;
    if (!hot) return null;
    return { symbol: coin.symbol, move5, range15, atrPct, rsi: calculateRSI(k, 14), score };
  });
  return scored.filter(Boolean).sort((a, b) => b.score - a.score).slice(0, 12);
}

async function maybeRescan() {
  if (Date.now() - S.lastScanAt < CFG.scanEveryMin * 60000 && S.targets.length) return;
  S.lastScanAt = Date.now();
  try {
    const hot = await scanUltraVol1m();
    S.hotList = hot;
    const hotSyms = hot.map(h => h.symbol).filter(s => !inCooldown(s) && !(S.foreign && S.foreign.has(s)));
    // «липкие» цели: оставляем текущую, пока она ещё в горячем списке
    const keep = S.targets.filter(s => hotSyms.includes(s));
    const next = [...keep];
    for (const s of hotSyms) { if (next.length >= CFG.maxSymbols) break; if (!next.includes(s)) next.push(s); }
    const changed = next.join(',') !== S.targets.join(',');
    S.targets = next;
    if (hot.length) {
      const t = hot[0];
      log(`Скан 1m: ${hot.length} горячих. Топ ${t.symbol} · 15m ${t.range15.toFixed(2)}% · ATR ${t.atrPct.toFixed(2)}%` +
        (changed ? ` → цели: ${next.join(', ') || '—'}` : ''), changed ? 'ok' : undefined);
    } else {
      log('Скан 1m: сейчас нет сильных движений');
    }
  } catch (e) {
    log('Скан: ' + e.message, 'err');
  }
}

// ---------------------------------------------------------------- дневной PnL (с биржи)
async function refreshDayPnl() {
  const now = new Date();
  const k = now.toISOString().slice(0, 10);
  if (S.dayKey !== k) { S.dayKey = k; S.dayPnl = 0; S.dayTrades = 0; S.lastPnlFetch = 0; }
  if (Date.now() - S.lastPnlFetch < 60000) return;
  S.lastPnlFetch = Date.now();
  const start = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  // сделки за сегодня (+1 день назад, чтобы видеть входы позиций, закрытых сегодня)
  const orderMap = {};          // orderId -> orderLinkId закрывающего ордера
  const botSyms = new Set();    // монеты, где сегодня исполнялись входы бота
  let cursor = '';
  for (let page = 0; page < 10; page++) {
    const p = { category: CFG.category, startTime: start - 86400000, endTime: Date.now(), limit: 100 };
    if (cursor) p.cursor = cursor;
    const j = await signedRequest('GET', '/v5/execution/list', p);
    if (j.retCode !== 0) throw new Error('executions(day): ' + j.retMsg);
    for (const e of j.result?.list || []) {
      orderMap[e.orderId] = { link: e.orderLinkId || '', stop: e.stopOrderType || '' };
      if ((e.orderLinkId || '').startsWith('sg_s_')) botSyms.add(e.symbol);
      // принудительные закрытия бота (по времени / стопу) → кулдаун, даже после перезапуска
      const link = e.orderLinkId || '';
      if (link.startsWith('sg_close_') && !link.startsWith('sg_close_tp_') && CFG.cooldownMin > 0) {
        const until = parseInt(e.execTime, 10) + CFG.cooldownMin * 60000;
        if (until > Date.now() && (S.cooldown[e.symbol] || 0) < until) S.cooldown[e.symbol] = until;
      }
    }
    cursor = j.result?.nextPageCursor || '';
    if (!cursor) break;
  }
  // закрытие считается нашим: закрыли ордером бота, или сработал стоп/тейк
  // позиции на монете, где бот набирал шорт
  let sum = 0, n = 0;
  cursor = '';
  for (let page = 0; page < 5; page++) {
    const p = { category: CFG.category, startTime: start, endTime: Date.now(), limit: 100 };
    if (cursor) p.cursor = cursor;
    const j = await signedRequest('GET', '/v5/position/closed-pnl', p);
    if (j.retCode !== 0) throw new Error('closed-pnl: ' + j.retMsg);
    for (const r of j.result?.list || []) {
      const o = orderMap[r.orderId] || { link: '', stop: '' };
      const ours = o.link.startsWith('sg_') || (!o.link && botSyms.has(r.symbol));
      if (!ours) continue;
      sum += parseFloat(r.closedPnl || 0); n++;
    }
    cursor = j.result?.nextPageCursor || '';
    if (!cursor) break;
  }
  S.dayPnl = sum; S.dayTrades = n;
}

// ---------------------------------------------------------------- один символ
async function processSymbol(symbol, ctx) {
  const { pos, orders, allowGrid } = ctx;
  const w = watchOf(symbol);
  const symOrders = orders.filter(o => o.symbol === symbol);
  const inst = await getInstrument(symbol);
  const book = await getOrderBook(symbol);
  if (!book.bids.length || !book.asks.length) throw new Error('пустой стакан');
  const mid = (book.bids[0] + book.asks[0]) / 2;
  w.mid = mid;

  // ручной/чужой LONG — только лимит времени (выше), сетку не трогаем
  if (pos && pos.side === 'Buy') { w.status = 'LONG (только лимит времени)'; return; }

  const tpPct = CFG.tpPct / 100, slPct = CFG.slPct / 100, gridStep = CFG.gridStepPct / 100;

  // --- в шорте: TP / SL / maker TP ---
  if (pos && pos.side === 'Sell') {
    const entry = pos.avgPrice || mid;
    const movePct = (entry - mid) / entry;
    if (movePct >= tpPct) {
      log(`${symbol}: 🎯 TP ${(movePct * 100).toFixed(2)}%`, 'ok');
      await closeMarket(pos, 'tp');
      await cancelOurOrders(symbol, orders);
      S.lastPnlFetch = 0;
      w.status = 'TP';
      return;
    }
    if (movePct <= -slPct) {
      log(`${symbol}: 🚨 SL ${(movePct * 100).toFixed(2)}%`, 'err');
      await closeMarket(pos, 'sl');
      await cancelOurOrders(symbol, orders);
      setCooldown(symbol);
      S.targets = S.targets.filter(s => s !== symbol);
      S.lastPnlFetch = 0;
      w.status = 'SL';
      return;
    }
    if (CFG.makerExit) {
      const tpOrders = symOrders.filter(o => (o.orderLinkId || '').startsWith('sg_tp_'));
      const want = roundToStep(entry * (1 - tpPct), inst.tickSize);
      const okTp = tpOrders.find(o =>
        Math.abs(parseFloat(o.qty) - pos.size) < 1e-9 &&
        Math.abs(parseFloat(o.price) - want) <= Math.max(parseFloat(inst.tickSize) * 2, want * 0.0005));
      if (!okTp && Date.now() - (w.tpAt || 0) > 30000) {
        if (w.tpLink && !tpOrders.length) await explainOrder(symbol, w.tpLink);
        for (const o of tpOrders) { try { await cancelOrder(symbol, o.orderId); } catch (e) {} }
        w.tpAt = Date.now();
        w.tpLink = await placeMakerExit(symbol, pos, want, inst);
      }
    }
    if (!CFG.shukin) { w.status = 'SHORT'; return; }   // обычный режим: без добора
  }

  // --- можно ли ставить/держать сетку ---
  const ourSells = symOrders.filter(o => (o.orderLinkId || '').startsWith('sg_s_') && o.side === 'Sell');
  const posUsdt = pos ? pos.size * mid : 0;
  let block = '';
  if (!allowGrid) block = ctx.blockReason || 'не цель';
  else if (posUsdt >= CFG.maxPosUsdt) block = `лимит ${CFG.maxPosUsdt} USDT`;
  if (block) {
    if (ourSells.length) {
      for (const o of ourSells) { try { await cancelOrder(symbol, o.orderId); } catch (e) {} }
      log(`${symbol}: сетка снята (${block})`);
    }
    w.status = (pos ? 'SHORT · ' : '') + block;
    return;
  }

  // свечи, спайк, ATR
  if (!w.candles.length || Date.now() - w.candlesAt > 9000) {
    try { w.candles = await getKlines(symbol, CFG.interval, 60); w.candlesAt = Date.now(); } catch (e) {}
  }
  w.priceHistory.push(mid);
  if (w.priceHistory.length > 5) w.priceHistory.shift();
  let isSpike = false;
  if (CFG.spikeProtect && w.priceHistory.length >= 3) {
    const old = w.priceHistory[0];
    if (Math.abs(mid - old) / old >= CFG.maxSpikePct / 100) isSpike = true;
  }
  w.atrPct = estimateAtrPct(w.candles, 14);
  w.rsi = calculateRSI(w.candles, 14);
  let volOk = true;
  if (CFG.volFilter && w.atrPct != null) {
    if (w.atrPct < CFG.minAtrPct / 100 || w.atrPct > CFG.maxAtrPct / 100) volOk = false;
  }
  if (isSpike || !volOk) { w.status = (pos ? 'SHORT · ' : '') + (isSpike ? 'SPIKE пауза' : 'ATR фильтр'); return; }

  if (CFG.shukin) {
    if (!w.oi.length || Date.now() - w.oiAt > 15000) {
      try { const oi = await getOpenInterest(symbol, CFG.interval, 50); if (oi.length) w.oi = oi; w.oiAt = Date.now(); } catch (e) {}
    }
    const sig = analyzeShukinContext(w.candles, w.oi);
    w.signal = sig;
    if (!sig.allowShort) { w.status = (pos ? 'SHORT · ' : '') + 'ЖДАТЬ: ' + sig.reason; return; }
  }

  // --- синхронизация сетки ---
  let qty = floorToStep(CFG.orderUsdt / mid, inst.qtyStep);
  if (qty < parseFloat(inst.minQty)) qty = parseFloat(inst.minQty);
  const targets = [];
  // якорь: восстанавливаем по уже стоящим ордерам, переносим только если цена ушла > 1 шага
  if (!w.anchor && ourSells.length) w.anchor = Math.min(...ourSells.map(o => parseFloat(o.price))) / (1 + gridStep);
  if (!w.anchor || Math.abs(mid - w.anchor) / w.anchor > gridStep) w.anchor = mid;
  const anchor = w.anchor;
  for (let i = 1; i <= CFG.gridLevels; i++) targets.push(roundToStep(anchor * (1 + gridStep * i), inst.tickSize));

  // не превышаем потолок позиции с учётом уже стоящих ордеров
  let room = CFG.maxPosUsdt - posUsdt;

  const tol = anchor * gridStep * 0.35;
  const matched = new Set();
  const toCancel = [];
  for (const o of ourSells) {
    const px = parseFloat(o.price);
    const t = targets.find(t => Math.abs(px - t) <= tol);
    if (t != null && !matched.has(t)) { matched.add(t); room -= parseFloat(o.qty) * px; }
    else toCancel.push(o);
  }
  for (const o of toCancel) { try { await cancelOrder(symbol, o.orderId); } catch (e) {} }
  if (toCancel.length) log(`${symbol}: сетка перенесена (снято ${toCancel.length})`);
  if ((w.noFundsUntil || 0) > Date.now()) { w.status = (pos ? 'SHORT · ' : '') + 'мало баланса'; return; }

  let placed = 0;
  for (const px of targets) {
    if (matched.has(px)) continue;
    if (room < qty * px) break;
    const tp = roundToStep(px * (1 - tpPct), inst.tickSize);
    const sl = (!CFG.shukin || !pos) ? roundToStep(px * (1 + slPct), inst.tickSize) : null;
    const j = await placeSellLimit(symbol, qty, px, tp, sl, inst);
    if (j.retCode === 0) { placed++; room -= qty * px; }
    else if (j.retCode === 110007 || j.retCode === 110004 || /not enough/i.test(j.retMsg || '')) {
      w.noFundsUntil = Date.now() + 60000; break;           // мало баланса — пауза 1 мин
    }
  }
  w.status = (pos ? 'SHORT · ' : '') + `сетка ${matched.size + placed}/${CFG.gridLevels}` + (CFG.shukin && w.signal ? ' · ' + w.signal.reason : '');
}

// ---------------------------------------------------------------- главный цикл
async function cycle() {
  if (S.busy) return;
  S.busy = true;
  try {
    if (!CFG.key || !CFG.secret) { S.lastError = 'нет API ключей (BYBIT_API_KEY / BYBIT_API_SECRET)'; return; }

    try { await refreshDayPnl(); } catch (e) { log(e.message, 'err'); }
    const dailyBlocked = CFG.maxDailyLoss > 0 && S.dayPnl <= -Math.abs(CFG.maxDailyLoss);

    const [positions, orders] = await Promise.all([getAllPositions(), getAllOpenOrders()]);
    S.positions = positions;
    S.ordersCount = orders.length;

    // 1) лимит удержания — только для позиций, открытых ботом
    const alive = [];        // позиции бота
    const foreign = new Set(); // монеты с чужими позициями (и с неизвестной принадлежностью)
    for (const p of positions) {
      let meta;
      try { meta = await getPosMeta(p); } catch (e) { log(`${p.symbol}: история сделок — ${e.message}`, 'err'); foreign.add(p.symbol); continue; }
      if (!meta.ours) { foreign.add(p.symbol); continue; }
      const opened = meta.ts;
      const ageMin = (Date.now() - opened) / 60000;
      p.ageMin = ageMin;
      if (CFG.maxHoldMin > 0 && ageMin >= CFG.maxHoldMin) {
        log(`${p.symbol}: ⏱ позиция живёт ${ageMin.toFixed(0)} мин ≥ ${CFG.maxHoldMin} — закрываю`, 'err');
        if (CFG.live) {
          try {
            await cancelOurOrders(p.symbol, orders);
            await closeMarket(p, 'tm');
            delete S.openedAt[p.symbol];
            setCooldown(p.symbol);
            S.targets = S.targets.filter(s => s !== p.symbol);
            S.lastPnlFetch = 0;
          } catch (e) { log(e.message, 'err'); alive.push(p); }
        }
        continue;
      }
      alive.push(p);
    }
    for (const s of Object.keys(S.openedAt)) if (!positions.find(p => p.symbol === s)) delete S.openedAt[s];

    // ордера бота на монетах с чужими позициями (хвосты) — снимаем, чтобы не задеть чужую позицию
    for (const sym of foreign) {
      if (orders.some(o => o.symbol === sym && isOurs(o))) {
        log(`${sym}: там чужая позиция — снимаю ордера бота`);
        await cancelOurOrders(sym, orders);
      }
    }

    // 2) скан целей (монеты с чужими позициями пропускаем)
    S.foreign = foreign;
    if (!S.paused && !dailyBlocked) await maybeRescan();

    // 3) вселенная: цели + позиции + монеты с нашими ордерами
    const posBySym = {};
    alive.forEach(p => { posBySym[p.symbol] = p; });
    const universe = new Set([...S.targets, ...Object.keys(posBySym), ...orders.filter(isOurs).map(o => o.symbol)]);
    const openShorts = alive.length;

    const results = await Promise.allSettled([...universe].map(sym => {
      const pos = posBySym[sym] || null;
      let allowGrid = S.targets.includes(sym), blockReason = '';
      if (foreign.has(sym)) { allowGrid = false; blockReason = 'там чужая позиция'; }
      else if (S.paused) { allowGrid = false; blockReason = 'пауза'; }
      else if (dailyBlocked) { allowGrid = false; blockReason = 'дневной лимит убытка'; }
      else if (inCooldown(sym)) { allowGrid = false; blockReason = 'кулдаун'; }
      else if (!S.targets.includes(sym)) { blockReason = 'не в цели'; }
      else if (!pos && openShorts >= CFG.maxOpenPositions) { allowGrid = false; blockReason = `макс. ${CFG.maxOpenPositions} позиций`; }
      if (!CFG.live) return Promise.resolve();
      return processSymbol(sym, { pos, orders, allowGrid, blockReason });
    }));
    results.forEach((r, i) => {
      if (r.status === 'rejected') log(`${[...universe][i]}: ${r.reason?.message || r.reason}`, 'err');
    });
    for (const s of Object.keys(S.watch)) if (!universe.has(s)) delete S.watch[s];

    S.cycles++;
    S.lastCycleAt = Date.now();
    S.lastError = '';
  } catch (e) {
    S.lastError = e.message || String(e);
    log(S.lastError, 'err');
    if (/403|restricted|CloudFront/i.test(S.lastError)) await sleep(30000);
  } finally {
    S.busy = false;
  }
}

let timer = null;
function start() {
  log(`СТАРТ · ${CFG.testnet ? 'TESTNET' : 'MAINNET'} · live=${CFG.live} · Щукин=${CFG.shukin} · шаг ${CFG.gridStepPct}% × ${CFG.gridLevels} · TP ${CFG.tpPct}% · SL ${CFG.slPct}% · ${CFG.orderUsdt} USDT/ур · удержание ≤ ${CFG.maxHoldMin} мин`, 'ok');
  if (!CFG.key || !CFG.secret) log('Нет BYBIT_API_KEY / BYBIT_API_SECRET — добавь переменные в Railway', 'err');
  if (S.paused) log('BOT_ENABLED=0 — новые сетки не ставятся, позиции под контролем');
  // проверка доступа к Bybit из региона сервера
  publicGet('/v5/market/time', {}).then(j => log('Bybit доступен, serverTime ' + (j.result?.timeSecond || '?'), 'ok'))
    .catch(e => log('Bybit НЕ доступен с этого сервера: ' + e.message, 'err'));
  // ждём, пока Railway погасит старый контейнер, чтобы два бота не работали одновременно
  const delay = Math.max(0, num('START_DELAY_SEC', 20)) * 1000;
  if (delay) log(`Первый цикл через ${delay / 1000} с (старый контейнер успевает остановиться)`);
  setTimeout(() => {
    if (stopped) return;
    cycle();
    timer = setInterval(cycle, CFG.cycleSec * 1000);
  }, delay);
}
let stopped = false;
function stop() { stopped = true; if (timer) clearInterval(timer); timer = null; }

function status() {
  return {
    now: Date.now(),
    startedAt: S.startedAt,
    mode: { testnet: CFG.testnet, live: CFG.live, shukin: CFG.shukin, paused: S.paused, hasKeys: !!(CFG.key && CFG.secret) },
    config: Object.fromEntries(Object.entries(CFG).filter(([k]) => k !== 'key' && k !== 'secret')),
    cycles: S.cycles,
    lastCycleAt: S.lastCycleAt,
    lastError: S.lastError,
    day: { key: S.dayKey, pnl: S.dayPnl, trades: S.dayTrades, blocked: CFG.maxDailyLoss > 0 && S.dayPnl <= -Math.abs(CFG.maxDailyLoss) },
    targets: S.targets,
    hotList: S.hotList,
    cooldown: Object.fromEntries(Object.entries(S.cooldown).filter(([, t]) => t > Date.now())),
    positions: S.positions.map(p => ({
      symbol: p.symbol, side: p.side, size: p.size, avgPrice: p.avgPrice, unrealisedPnl: p.unrealisedPnl,
      ours: S.openedAt[p.symbol] ? !!S.openedAt[p.symbol].ours : null,
      openedAt: S.openedAt[p.symbol]?.ts || null,
      ageMin: S.openedAt[p.symbol]?.ts ? (Date.now() - S.openedAt[p.symbol].ts) / 60000 : null
    })),
    ordersCount: S.ordersCount,
    watch: Object.fromEntries(Object.entries(S.watch).map(([s, w]) => [s, {
      mid: w.mid, rsi: w.rsi, atrPct: w.atrPct != null ? w.atrPct * 100 : null, status: w.status,
      signal: w.signal ? { allow: w.signal.allowShort, reason: w.signal.reason, oi: w.signal.oiTrend, cvd: w.signal.cvdTrend } : null
    }])),
    logs: S.logs.slice(0, 150)
  };
}

async function pause(cancelGrids) {
  S.paused = true;
  log('⏸ ПАУЗА: новые сетки не ставятся, позиции под контролем (TP/SL/лимит времени)', 'ok');
  if (cancelGrids && CFG.key) {
    try {
      const orders = await getAllOpenOrders();
      const syms = [...new Set(orders.filter(isOurs).map(o => o.symbol))];
      for (const s of syms) await cancelOurOrders(s, orders, o => (o.orderLinkId || '').startsWith('sg_s_'));
    } catch (e) { log('пауза: ' + e.message, 'err'); }
  }
}
function resume() { S.paused = false; S.lastScanAt = 0; log('▶ ВОЗОБНОВЛЕНО', 'ok'); }

module.exports = { start, stop, status, pause, resume, log };
