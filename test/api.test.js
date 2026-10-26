'use strict';
/* Tes API pensinyalan: node test/api.test.js  (memori lokal) */
const assert = require('assert');
const { start } = require('../dev-server.js');
let base, pass = 0;
const api = async (method, body, q) => {
  const r = await fetch(base + '/api/room' + (q ? '?' + new URLSearchParams(q) : ''), { method, headers: { 'Content-Type': 'application/json' }, body: method === 'POST' ? JSON.stringify(body) : undefined });
  return Object.assign({ http: r.status }, await r.json());
};
const post = (action, o) => api('POST', Object.assign({ action }, o));
const T = async (name, fn) => { try { await fn(); pass++; console.log('  ✔', name); } catch (e) { console.log('  ✘', name, '\n     ', e.stack.split('\n').slice(0, 3).join('\n      ')); process.exitCode = 1; } };

(async () => {
  const srv = await start(0); base = 'http://localhost:' + srv.address().port;
  let H, G;
  await T('ice mengembalikan daftar STUN', async () => { const j = await api('GET', null, { action: 'ice' }); assert(j.ok && j.iceServers.length >= 1); });
  await T('create membuat kode 5 karakter', async () => { H = await post('create', { name: 'Andi' }); assert(H.ok && /^[A-Z2-9]{5}$/.test(H.code) && H.role === 'h'); });
  await T('host melihat peer belum bergabung', async () => { const j = await api('GET', null, { code: H.code, token: H.token, since: 0 }); assert(j.ok && j.peer.joined === false && j.msgs.length === 0); });
  await T('join dengan kode kecil/besar & nama dibersihkan', async () => { G = await post('join', { code: H.code.toLowerCase(), name: '<b>Budi</b>' }); assert(G.ok && G.role === 'g' && G.hostName === 'Andi' && !/[<>]/.test(G.name)); });
  await T('kursi ketiga ditolak (409)', async () => { const j = await post('join', { code: H.code, name: 'X' }); assert(j.http === 409 && !j.ok); });
  await T('tamu yang sama bisa sambung ulang dengan token', async () => { const j = await post('join', { code: H.code, token: G.token }); assert(j.ok && j.token === G.token); });
  await T('kode salah → 404, format salah → 400', async () => { assert((await post('join', { code: 'ZZZZZ' })).http === 404); assert((await post('join', { code: 'AB' })).http === 400); });
  let hn = 0, gn = 0;
  await T('host menerima notifikasi join + presence', async () => { const j = await api('GET', null, { code: H.code, token: H.token, since: hn }); hn = j.n; assert(j.peer.joined && j.peer.name === G.name && /Budi/.test(j.peer.name) ); });
  await T('sinyal host → tamu (berurutan, since bekerja)', async () => {
    assert((await post('send', { code: H.code, token: H.token, msgs: [{ t: 'sig', d: { sdp: 'offer' } }, { t: 'sig', d: { c: 1 } }] })).ok);
    let j = await api('GET', null, { code: G.code, token: G.token, since: gn }); gn = j.n;
    assert(j.msgs.length === 2 && j.msgs[0].d.sdp === 'offer' && j.msgs[1].d.c === 1 && gn === 2);
    j = await api('GET', null, { code: G.code, token: G.token, since: gn }); assert(j.msgs.length === 0 && j.n === 2);
  });
  await T('relay tamu → host membawa array string', async () => {
    assert((await post('send', { code: G.code, token: G.token, msgs: [{ t: 'rl', d: ['{"t":"p"}', '{"t":"w"}'] }] })).ok);
    const j = await api('GET', null, { code: H.code, token: H.token, since: hn }); hn = j.n; assert(j.msgs[0].t === 'rl' && j.msgs[0].d.length === 2);
  });
  await T('token salah ditolak (401) & pesan terlalu besar ditolak (413)', async () => {
    assert((await api('GET', null, { code: H.code, token: 'x', since: 0 })).http === 401);
    assert((await post('send', { code: H.code, token: H.token, msgs: ['x'.repeat(13000)] })).http === 413);
  });
  let M, mhn = 0;
  await T('Room Master bergabung (kursi terpisah dari pemain)', async () => {
    M = await post('join', { code: H.code, name: 'Wasit', as: 'master' }); assert(M.ok && M.role === 'm');
    const j = await api('GET', null, { code: H.code, token: H.token, since: 0, peer: 'm' }); assert(j.peer.joined && j.peer.name === 'Wasit');
    const j2 = await api('GET', null, { code: H.code, token: H.token, since: 0, peer: 'g' }); assert(j2.peer.joined && /Budi/.test(j2.peer.name));
  });
  await T('Room Master kedua ditolak (409)', async () => { const j = await post('join', { code: H.code, name: 'X', as: 'master' }); assert(j.http === 409); });
  await T('sinyal host ↔ master terpisah dari jalur tamu', async () => {
    assert((await post('send', { code: H.code, token: H.token, to: 'm', msgs: [{ t: 'sig', d: { sdp: 'for-master' } }] })).ok);
    let j = await api('GET', null, { code: M.code, token: M.token, since: 0 }); assert(j.msgs.length === 1 && j.msgs[0].d.sdp === 'for-master');
    j = await api('GET', null, { code: G.code, token: G.token, since: gn }); assert(j.msgs.length === 0, 'tamu tidak boleh menerima pesan master');
    assert((await post('send', { code: M.code, token: M.token, msgs: [{ t: 'sig', d: { c: 9 } }] })).ok);
    j = await api('GET', null, { code: H.code, token: H.token, since: 0, peer: 'm' }); assert(j.msgs.length === 1 && j.msgs[0].d.c === 9);
    j = await api('GET', null, { code: H.code, token: H.token, since: hn, peer: 'g' }); assert(!j.msgs.some(m => m.d && m.d.c === 9));
  });
  await T('master keluar → host dapat bye, kursi master kosong lagi', async () => {
    assert((await post('leave', { code: M.code, token: M.token })).ok);
    const j = await api('GET', null, { code: H.code, token: H.token, since: 1, peer: 'm' }); assert(j.msgs.some(m => m.t === 'bye') && !j.peer.joined);
    assert((await post('join', { code: H.code, name: 'Wasit2', as: 'master' })).ok);
  });
  await T('tamu keluar → host dapat bye, kursi kosong lagi', async () => {
    assert((await post('leave', { code: G.code, token: G.token })).ok);
    const j = await api('GET', null, { code: H.code, token: H.token, since: hn }); hn = j.n; assert(j.msgs.some(m => m.t === 'bye') && j.peer.joined === false);
    const g2 = await post('join', { code: H.code, name: 'Cici' }); assert(g2.ok && g2.name === 'Cici');
  });
  await T('host keluar → ruangan ditutup', async () => {
    assert((await post('leave', { code: H.code, token: H.token })).ok);
    const j = await api('GET', null, { code: H.code, token: H.token, since: 0 }); assert(j.http === 404 && j.gone === true);
  });
  console.log(pass + ' tes lulus'); srv.close();
})();
