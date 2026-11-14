'use strict';
/*
 * الخادم الخلفي: يستقبل أوامر الموقع عبر WebSocket ويشغّل بوتات mineflayer.
 * التشغيل:  npm install  ثم  npm start
 *
 * متغيرات اختيارية:
 *   PORT=3000            المنفذ
 *   MAX_BOTS=30          أقصى عدد بوتات في نفس الوقت
 *   MAX_PER_IP=2         أقصى عدد بوتات لكل زائر
 *   MAX_HOURS=3          أقصى مدة بقاء للبوت
 *   ALLOWED_ORIGINS=https://my-site.netlify.app   (للسماح لموقعك فقط)
 */
const http = require('http');
const dns = require('dns').promises;
const net = require('net');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const mineflayer = require('mineflayer');

const PORT = Number(process.env.PORT || 3000);
const MAX_BOTS = Number(process.env.MAX_BOTS || 30);
const MAX_PER_IP = Number(process.env.MAX_PER_IP || 2);
const MAX_LIFETIME = Number(process.env.MAX_HOURS || 3) * 3600e3;
const GRACE = 10 * 60e3; // مدة بقاء البوت بعد إغلاق الصفحة
const ORIGINS = (process.env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);

const sessions = new Map();
const startLog = new Map(); // ip -> أوقات محاولات الدخول

// ---------- أدوات مساعدة ----------
function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  }
  const v = ip.toLowerCase();
  if (v.startsWith('::ffff:')) return v.includes('.') ? isPrivateIp(v.slice(7)) : true;
  return v === '::' || v === '::1' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80');
}

function parseTarget(input) {
  const s = String(input || '').trim().replace(/^[a-z]+:\/\//i, '').replace(/\/.*$/, '');
  let host = s;
  let port = 25565;
  const m = s.match(/^(.+):(\d{1,5})$/);
  if (m) { host = m[1]; port = Number(m[2]); }
  if (!/^[a-z0-9.-]{1,253}$/i.test(host) || port < 1 || port > 65535) return null;
  return { host, port };
}

function randomName() {
  return 'Bot_' + crypto.randomBytes(3).toString('hex');
}

function reasonText(r) {
  const t = typeof r === 'string' ? r : JSON.stringify(r);
  return String(t).slice(0, 250);
}

function send(s, obj) {
  if (s.ws && s.ws.readyState === 1) s.ws.send(JSON.stringify(obj));
}

function log(s, text, level = 'info') {
  const e = { type: 'log', text, level };
  s.logs.push(e);
  if (s.logs.length > 150) s.logs.shift();
  send(s, e);
}

function setState(s, state) {
  s.state = state;
  send(s, { type: 'status', state, session: state === 'offline' ? null : s.id, name: s.name });
}

function destroy(s, reason, level = 'warn') {
  if (s.dead) return;
  s.dead = true;
  clearTimeout(s.grace);
  clearTimeout(s.life);
  clearInterval(s.afk);
  try { if (s.bot) s.bot.quit(); } catch (e) {}
  try { if (s.bot) s.bot.end(); } catch (e) {}
  sessions.delete(s.id);
  if (reason) log(s, reason, level);
  setState(s, 'offline');
}

function antiAfk(bot) {
  try {
    bot.setControlState('jump', true);
    setTimeout(() => { try { bot.setControlState('jump', false); } catch (e) {} }, 350);
    bot.look(Math.random() * Math.PI * 2, (Math.random() - 0.5) * 0.6, false);
  } catch (e) {}
}

// ---------- تشغيل البوت ----------
async function launch(s, input) {
  const t = parseTarget(input);
  if (!t) throw new Error('عنوان السيرفر غير صحيح.');
  let { host, port } = t;
  const original = host;

  if (!net.isIP(host) && port === 25565) {
    try {
      const srv = await dns.resolveSrv('_minecraft._tcp.' + host);
      if (srv.length) { host = srv[0].name; port = srv[0].port; }
    } catch (e) { /* لا يوجد SRV */ }
  }

  let addrs;
  try {
    addrs = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true });
  } catch (e) {
    throw new Error('لم أجد هذا السيرفر، تأكد من العنوان.');
  }
  if (!addrs.length || addrs.some((a) => isPrivateIp(a.address))) {
    throw new Error('هذا العنوان غير مسموح.');
  }
  if (s.dead) return;

  log(s, 'جارٍ الاتصال بـ ' + original + ':' + t.port + ' ...', 'info');

  const bot = mineflayer.createBot({
    host,
    port,
    fakeHost: original,
    username: s.name,
    auth: 'offline',
    hideErrors: true,
    checkTimeoutInterval: 60000
  });
  s.bot = bot;

  bot.once('login', () => log(s, 'تم الاتصال، جارٍ تحميل العالم...', 'ok'));
  bot.once('spawn', () => {
    setState(s, 'online');
    log(s, 'البوت داخل السيرفر الآن باسم ' + s.name, 'ok');
    s.afk = setInterval(() => antiAfk(bot), 25000);
  });
  bot.on('messagestr', (msg) => { if (msg && msg.trim()) log(s, msg.trim().slice(0, 300), 'chat'); });
  bot.on('kicked', (reason) => log(s, 'تم طرد البوت: ' + reasonText(reason), 'err'));
  bot.on('error', (err) => log(s, 'خطأ: ' + (err && err.message ? err.message : err), 'err'));
  bot.once('end', (reason) => destroy(s, 'انتهى الاتصال' + (reason ? ' (' + reason + ')' : ''), 'warn'));
}

// ---------- الخادم ----------
const fs = require('fs');
const path = require('path');
const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('OK bots=' + sessions.size);
    return;
  }
  fs.readFile(path.join(__dirname, 'index.html'), (err, data) => {
    if (err) { res.writeHead(404); res.end('index.html not found'); return; }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(data);
  });
});

const wss = new WebSocketServer({ server, maxPayload: 4096 });

wss.on('connection', (ws, req) => {
  if (ORIGINS.length && !ORIGINS.includes(req.headers.origin)) { ws.close(1008, 'origin'); return; }
  const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  let sess = null;
  let lastChat = 0;

  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  const reply = (obj) => { if (ws.readyState === 1) ws.send(JSON.stringify(obj)); };

  ws.on('message', async (raw) => {
    let m;
    try { m = JSON.parse(raw.toString()); } catch (e) { return; }

    if (m.type === 'resume') {
      const s = sessions.get(String(m.session || ''));
      if (!s || s.dead) { reply({ type: 'status', state: 'offline', session: null }); return; }
      clearTimeout(s.grace);
      if (s.ws && s.ws !== ws) { try { s.ws.close(); } catch (e) {} }
      s.ws = ws;
      sess = s;
      reply({ type: 'status', state: s.state, session: s.id, name: s.name });
      s.logs.forEach((e) => reply(e));
      return;
    }

    if (m.type === 'start') {
      if (sess && !sess.dead) { reply({ type: 'error', text: 'عندك بوت شغال بالفعل.' }); return; }
      const now = Date.now();
      const recent = (startLog.get(ip) || []).filter((t) => now - t < 10 * 60e3);
      if (recent.length >= 6) { reply({ type: 'error', text: 'محاولات كثيرة، انتظر بضع دقائق.' }); return; }
      if (sessions.size >= MAX_BOTS) { reply({ type: 'error', text: 'الموقع ممتلئ حالياً، حاول لاحقاً.' }); return; }
      const mine = [...sessions.values()].filter((x) => x.ip === ip).length;
      if (mine >= MAX_PER_IP) { reply({ type: 'error', text: 'وصلت للحد الأقصى من البوتات.' }); return; }

      let name = String(m.name || '').trim();
      if (!name) name = randomName();
      if (!/^[A-Za-z0-9_]{3,16}$/.test(name)) {
        reply({ type: 'error', text: 'اسم البوت غير صالح.' });
        return;
      }
      recent.push(now);
      startLog.set(ip, recent);

      const s = {
        id: crypto.randomBytes(16).toString('hex'),
        ip, ws, name, logs: [], state: 'connecting', dead: false
      };
      sessions.set(s.id, s);
      sess = s;
      s.life = setTimeout(() => destroy(s, 'انتهت مدة بقاء البوت.', 'info'), MAX_LIFETIME);
      setState(s, 'connecting');
      try {
        await launch(s, m.host);
      } catch (err) {
        destroy(s, err.message || 'تعذر تشغيل البوت.', 'err');
      }
      return;
    }

    if (!sess || sess.dead) return;

    if (m.type === 'stop') {
      destroy(sess, 'تم إخراج البوت من السيرفر.', 'info');
      return;
    }

    if (m.type === 'chat') {
      const now = Date.now();
      if (now - lastChat < 1000 || sess.state !== 'online') return;
      lastChat = now;
      const text = String(m.text || '').replace(/[\u0000-\u001f\u007f§]/g, '').slice(0, 200);
      if (text) { try { sess.bot.chat(text); } catch (e) {} }
    }
  });

  ws.on('close', () => {
    if (sess && !sess.dead && sess.ws === ws) {
      sess.ws = null;
      sess.grace = setTimeout(() => destroy(sess, null), GRACE);
    }
  });
  ws.on('error', () => {});
});

setInterval(() => {
  wss.clients.forEach((c) => {
    if (!c.isAlive) { c.terminate(); return; }
    c.isAlive = false;
    try { c.ping(); } catch (e) {}
  });
  const now = Date.now();
  for (const [ip, arr] of startLog) {
    const keep = arr.filter((t) => now - t < 10 * 60e3);
    if (keep.length) startLog.set(ip, keep); else startLog.delete(ip);
  }
}, 30000);

process.on('uncaughtException', (e) => console.error('uncaught:', e && e.message));
process.on('unhandledRejection', (e) => console.error('unhandled:', e && e.message));

server.listen(PORT, () => console.log('mc-bot backend listening on :' + PORT));
