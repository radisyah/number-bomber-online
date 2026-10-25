'use strict';
/* NUMBER BOMBER Online — satu Vercel Function untuk PENSINYALAN (bukan untuk gameplay).
   Gameplay berjalan langsung antar-perangkat lewat WebRTC (tanpa server di tengah → latensi serendah mungkin).
   Server ini hanya dipakai untuk: membuat/gabung ruangan dengan kode 5 karakter, saling bertukar SDP/ICE,
   dan sebagai RELAY cadangan bila koneksi langsung gagal (mis. jaringan seluler dengan NAT ketat dan tanpa TURN).

     GET  /api/room?action=ice                  -> daftar ICE server (STUN/TURN)
     GET  /api/room?code=&token=&since=N        -> polling kotak surat: {peer, msgs, n}
     POST /api/room {action: create|join|send|leave, ...}

   Redis:  room:KODE (host) · guest:KODE (tamu, SET NX → hanya satu) · mb:KODE:h / mb:KODE:g (kotak surat, list) */
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
const K = { room: c => 'room:' + c, guest: c => 'guest:' + c, mb: (c, r) => 'mb:' + c + ':' + r };

function iceServers() {
  const raw = process.env.ICE_SERVERS;           // JSON array, mis. [{"urls":"turn:host:3478","username":"u","credential":"p"}]
  if (raw) { try { const a = JSON.parse(raw); if (Array.isArray(a) && a.length) return a; } catch (e) { /* abaikan, pakai bawaan */ } }
  return DEFAULT_ICE;
}

/* Identifikasi pemanggil → 'h' (host) / 'g' (tamu). Mengembalikan {role, room, guest}. */
async function auth(code, token) {
  const r = await getStore().pipeline([['GET', K.room(code)], ['GET', K.guest(code)]]);
  const room = parse(r[0]);
  if (!room) throw fail(404, 'Ruangan tidak ditemukan atau sudah kedaluwarsa.', { gone: true });
  const guest = parse(r[1]);
  let role = null;
  if (token && room.host.token === token) role = 'h';
  else if (token && guest && guest.token === token) role = 'g';
  if (!role) throw fail(401, 'Sesi tidak valid. Gabung ulang ke ruangan.', { gone: true });
  return { role, room, guest };
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
  const code = normCode(b.code), store = getStore();
  const r = await store.pipeline([['GET', K.room(code)], ['GET', K.guest(code)]]);
  const room = parse(r[0]);
  if (!room) throw fail(404, 'Ruangan tidak ditemukan atau sudah kedaluwarsa.');
  const cur = parse(r[1]);
  if (b.token && cur && cur.token === b.token) return { code, token: cur.token, role: 'g', name: cur.name, hostName: room.host.name };   // sambung ulang
  const name = cleanName(b.name, 'Pemain 2'), token = rid(12);
  const ok = await store.cmd(['SET', K.guest(code), JSON.stringify({ token, name }), 'NX', 'EX', TTL]);
  if (ok !== 'OK') throw fail(409, 'Ruangan sudah penuh (2 pemain).');
  await store.pipeline([['DEL', K.mb(code, 'g')], ['RPUSH', K.mb(code, 'h'), JSON.stringify({ t: 'join' })], ['EXPIRE', K.mb(code, 'h'), TTL]]);
  return { code, token, role: 'g', name, hostName: room.host.name };
}

async function actState(q) {
  const code = normCode(q.code), token = String(q.token || '');
  const { role, room, guest } = await auth(code, token);
  const since = Math.max(0, Math.floor(Number(q.since) || 0));
  const msgs = await getStore().cmd(['LRANGE', K.mb(code, role), since, -1]);
  const peer = role === 'h' ? { joined: !!guest, name: guest ? guest.name : '' } : { joined: true, name: room.host.name };
  return { peer, msgs: (msgs || []).map(parse).filter(Boolean), n: since + (msgs || []).length };
}

async function actSend(b) {
  const code = normCode(b.code), { role } = await auth(code, String(b.token || ''));
  const list = Array.isArray(b.msgs) ? b.msgs.slice(0, MAX_BATCH) : [];
  if (!list.length) return {};
  const to = role === 'h' ? 'g' : 'h', key = K.mb(code, to), store = getStore();
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
  const to = a.role === 'h' ? 'g' : 'h';
  const cmds = [['RPUSH', K.mb(code, to), JSON.stringify({ t: 'bye' })], ['EXPIRE', K.mb(code, to), 600]];
  if (a.role === 'h') cmds.push(['DEL', K.room(code), K.guest(code)]);      // host pergi = ruangan ditutup
  else cmds.push(['DEL', K.guest(code)]);                                    // tamu pergi = kursi kosong lagi
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
      out = q.action === 'ice' ? { iceServers: iceServers() } : await actState(q);
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
