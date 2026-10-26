'use strict';
/* NUMBER BOMBER Online — satu Vercel Function untuk PENSINYALAN (bukan untuk gameplay).
   Gameplay berjalan langsung antar-perangkat lewat WebRTC (tanpa server di tengah → latensi serendah mungkin).
   Server ini hanya dipakai untuk: membuat/gabung ruangan dengan kode 5 karakter, saling bertukar SDP/ICE,
   dan sebagai RELAY cadangan bila koneksi langsung gagal (mis. jaringan seluler dengan NAT ketat dan tanpa TURN).

     GET  /api/room?action=ice                  -> daftar ICE server (STUN/TURN)
     GET  /api/room?code=&token=&since=N        -> polling kotak surat: {peer, msgs, n}
     POST /api/room {action: create|join|send|leave, ...}

   Peran: h = host (P1) · g = tamu (P2) · m = Room Master (hanya menonton, tersambung ke host).
   Redis:  room:KODE (host) · guest:KODE / master:KODE (SET NX → hanya satu) · mb:KODE:<dari><ke> (kotak surat per pasangan: hg, gh, hm, mh) */
const crypto = require('crypto');
const { getStore } = require('../lib/store.js');

const TTL = 2 * 3600;
const MAX_MB = 15000;          // batas panjang kotak surat (relay ±15 menit)
const MAX_BATCH = 60, MAX_MSG = 12000;
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const DEFAULT_ICE = [
  { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
  { urls: 'stun:stun.cloudflare.com:3478' }
];

const fail = (status, msg, extra) => { const e = new Error(msg); e.status = status; if (extra) Object.assign(e, extra); return e; };
const rid = n => crypto.randomBytes(n).toString('hex');
const cleanName = (s, fb) => {
  s = String(s == null ? '' : s).replace(/[\u0000-\u001f<>&"'`]/g, '').replace(/\s+/g, ' ').trim().slice(0, 14);
  return s || fb;
};
const normCode = c => { c = String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, ''); if (c.length !== 5) throw fail(400, 'Kode ruangan harus 5 karakter.'); return c; };
const parse = s => { try { return s ? JSON.parse(s) : null; } catch (e) { return null; } };
const K = { room: c => 'room:' + c, guest: c => 'guest:' + c, master: c => 'master:' + c, mb: (c, link) => 'mb:' + c + ':' + link };

/* ICE server, urutan prioritas:
   1) Metered: env METERED_APP_NAME + METERED_API_KEY (+ METERED_REGION opsional) → kredensial diambil dari REST API Metered di SERVER
      (key tidak pernah dikirim ke browser), di-cache 5 menit.
   2) env ICE_SERVERS (JSON array manual).
   3) STUN publik saja (koneksi langsung tanpa relay TURN). */
let meteredCache = { at: 0, list: null };
async function meteredServers() {
  const app = (process.env.METERED_APP_NAME || '').trim().replace(/\.metered\.live.*$/i, ''), key = (process.env.METERED_API_KEY || '').trim();
  if (!app || !key) return null;
  if (meteredCache.list && Date.now() - meteredCache.at < 5 * 60 * 1000) return meteredCache.list;
  try {
    const region = (process.env.METERED_REGION || '').trim();
    const u = 'https://' + encodeURIComponent(app) + '.metered.live/api/v1/turn/credentials?apiKey=' + encodeURIComponent(key) + (region ? '&region=' + encodeURIComponent(region) : '');
    const ac = new AbortController(), t = setTimeout(() => ac.abort(), 4000);
    const r = await fetch(u, { signal: ac.signal }); clearTimeout(t);
    if (!r.ok) throw new Error('Metered ' + r.status);
    const arr = await r.json();
    if (Array.isArray(arr) && arr.length) { meteredCache = { at: Date.now(), list: arr }; return arr; }
  } catch (e) { console.error('Metered gagal, pakai cadangan:', e.message); }
  return meteredCache.list;       // pakai cache lama bila ada
}
async function iceServers() {
  const m = await meteredServers();
  if (m) return m;
  const raw = process.env.ICE_SERVERS;           // JSON array, mis. [{"urls":"turn:host:3478","username":"u","credential":"p"}]
  if (raw) { try { const a = JSON.parse(raw); if (Array.isArray(a) && a.length) return a; } catch (e) { /* abaikan, pakai bawaan */ } }
  return DEFAULT_ICE;
}

/* Identifikasi pemanggil → 'h' (host) / 'g' (tamu). Mengembalikan {role, room, guest}. */
async function auth(code, token) {
  const r = await getStore().pipeline([['GET', K.room(code)], ['GET', K.guest(code)], ['GET', K.master(code)]]);
  const room = parse(r[0]);
  if (!room) throw fail(404, 'Ruangan tidak ditemukan atau sudah kedaluwarsa.', { gone: true });
  const guest = parse(r[1]), master = parse(r[2]);
  let role = null;
  if (token && room.host.token === token) role = 'h';
  else if (token && guest && guest.token === token) role = 'g';
  else if (token && master && master.token === token) role = 'm';
  if (!role) throw fail(401, 'Sesi tidak valid. Gabung ulang ke ruangan.', { gone: true });
  return { role, room, guest, master };
}

async function actCreate(b) {
  const store = getStore(), name = cleanName(b.name, 'Pemain 1'), token = rid(12);
  for (let i = 0; i < 12; i++) {
    let code = ''; for (let k = 0; k < 5; k++) code += ALPHABET[crypto.randomInt(ALPHABET.length)];
    const room = { code, host: { token, name }, createdAt: Date.now() };
    const ok = await store.cmd(['SET', K.room(code), JSON.stringify(room), 'NX', 'EX', TTL]);
    if (ok === 'OK') return { code, token, role: 'h', name };
  }
  throw fail(503, 'Gagal membuat ruangan. Coba lagi.');
}

async function actJoin(b) {
  const code = normCode(b.code), store = getStore(), asMaster = b.as === 'master', slot = asMaster ? K.master(code) : K.guest(code);
  const r = await store.pipeline([['GET', K.room(code)], ['GET', slot]]);
  const room = parse(r[0]);
  if (!room) throw fail(404, 'Ruangan tidak ditemukan atau sudah kedaluwarsa.');
  const cur = parse(r[1]), role = asMaster ? 'm' : 'g';
  if (b.token && cur && cur.token === b.token) return { code, token: cur.token, role, name: cur.name, hostName: room.host.name };   // sambung ulang
  const name = cleanName(b.name, asMaster ? 'Room Master' : 'Pemain 2'), token = rid(12);
  const ok = await store.cmd(['SET', slot, JSON.stringify({ token, name }), 'NX', 'EX', TTL]);
  if (ok !== 'OK') throw fail(409, asMaster ? 'Room Master sudah ada di ruangan ini.' : 'Ruangan sudah penuh (2 pemain).');
  const base = await store.cmd(['LLEN', K.mb(code, asMaster ? 'hm' : 'hg')]);     // pesan lama (sesi sebelumnya) dilewati klien baru lewat 'base'
  return { code, token, role, name, hostName: room.host.name, base: base || 0 };
}

async function actState(q) {
  const code = normCode(q.code), token = String(q.token || '');
  const { role, room, guest, master } = await auth(code, token);
  const since = Math.max(0, Math.floor(Number(q.since) || 0));
  const peerRole = role === 'h' ? (q.peer === 'm' ? 'm' : 'g') : 'h';        // host punya dua pasangan; yang lain hanya host
  const msgs = await getStore().cmd(['LRANGE', K.mb(code, peerRole + role), since, -1]);
  const who = peerRole === 'g' ? guest : (peerRole === 'm' ? master : room.host);
  const peer = { joined: !!who, name: who ? (who.name || '') : '' };
  return { peer, msgs: (msgs || []).map(parse).filter(Boolean), n: since + (msgs || []).length };
}

async function actSend(b) {
  const code = normCode(b.code), { role } = await auth(code, String(b.token || ''));
  const list = Array.isArray(b.msgs) ? b.msgs.slice(0, MAX_BATCH) : [];
  if (!list.length) return {};
  const to = role === 'h' ? (b.to === 'm' ? 'm' : 'g') : 'h', key = K.mb(code, role + to), store = getStore();
  const strs = [];
  for (const m of list) {
    const s = typeof m === 'string' ? m : JSON.stringify(m);
    if (s.length > MAX_MSG) throw fail(413, 'Pesan terlalu besar.');
    strs.push(s);
  }
  const res = await store.pipeline([['RPUSH', key].concat(strs), ['EXPIRE', key, TTL]]);
  if (res[0] > MAX_MB) throw fail(409, 'Sesi relay terlalu panjang. Mulai ruangan baru.');
  return {};
}

async function actLeave(b) {
  const code = normCode(b.code), store = getStore();
  let a; try { a = await auth(code, String(b.token || '')); } catch (e) { return {}; }
  const bye = JSON.stringify({ t: 'bye' }), cmds = [];
  if (a.role === 'h') {                                  // host pergi = ruangan ditutup untuk semua
    cmds.push(['RPUSH', K.mb(code, 'hg'), bye], ['EXPIRE', K.mb(code, 'hg'), 600], ['RPUSH', K.mb(code, 'hm'), bye], ['EXPIRE', K.mb(code, 'hm'), 600],
              ['DEL', K.room(code), K.guest(code), K.master(code)]);
  } else if (a.role === 'g') cmds.push(['RPUSH', K.mb(code, 'gh'), bye], ['EXPIRE', K.mb(code, 'gh'), 600], ['DEL', K.guest(code)]);       // kursi kosong lagi
  else cmds.push(['RPUSH', K.mb(code, 'mh'), bye], ['EXPIRE', K.mb(code, 'mh'), 600], ['DEL', K.master(code)]);                              // kursi Room Master kosong lagi
  await store.pipeline(cmds);
  return {};
}

function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') { try { return JSON.parse(req.body); } catch (e) { throw fail(400, 'Body tidak valid.'); } }
  return {};
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  try {
    let out;
    if (req.method === 'GET') {
      const q = req.query || {};
      out = q.action === 'ice' ? { iceServers: await iceServers() } : await actState(q);
    } else if (req.method === 'POST') {
      const b = readBody(req);
      const acts = { create: actCreate, join: actJoin, send: actSend, leave: actLeave };
      if (!acts[b.action]) throw fail(400, 'Aksi tidak dikenal.');
      out = await acts[b.action](b);
    } else throw fail(405, 'Metode tidak didukung.');
    res.status(200).json(Object.assign({ ok: true }, out));
  } catch (e) {
    const status = e.status || 500;
    if (status >= 500) console.error(e);
    res.status(status).json({ ok: false, error: status >= 500 && !e.status ? 'Terjadi kesalahan di server.' : e.message, gone: !!e.gone });
  }
};
