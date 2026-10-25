# NUMBER BOMBER · Online

Versi online dari *NUMBER BOMBER* (Bomberman + soal matematika), 1 vs 1 dengan **kode ruangan** seperti math-duel.
Satu perangkat = satu pemain. Host = P1, tamu = P2.

## Kenapa terasa tanpa delay
Gameplay **tidak lewat server**. Dua perangkat tersambung langsung (WebRTC DataChannel), jadi latensi = jarak jaringan kedua HP saja.
- Gerakan, soal matematika, energi, kemampuan **dihitung di perangkat pemain sendiri** → respons sentuhan instan.
- Dunia bersama (bom, ledakan, peti, power-up, nyawa, timer ronde) diputuskan **host**, disiarkan sebagai kejadian andal + snapshot 10×/dtk.
- Bom tamu muncul seketika (prediksi lokal) lalu dikonfirmasi host. Lawan digambar dengan interpolasi + ekstrapolasi dari paket 30×/dtk.
- Server Vercel + Upstash Redis hanya dipakai untuk membuat/gabung ruangan, bertukar SDP/ICE, dan **relay cadangan** bila koneksi langsung gagal
  (badge kiri-bawah menampilkan `LANGSUNG · xx ms` atau `RELAY`).

## Deploy ke Vercel
1. Taruh folder ini di GitHub → **Add New → Project** di Vercel (preset "Other", tanpa build command).
2. **Storage / Marketplace → Upstash Redis** → hubungkan ke proyek (mengisi `KV_REST_API_URL`/`KV_REST_API_TOKEN` atau `UPSTASH_REDIS_REST_*`). **Redeploy**.
3. *(Disarankan)* Tambahkan server **TURN** lewat env `ICE_SERVERS` (lihat `.env.example`). Tanpa TURN, sebagian jaringan seluler dengan NAT ketat
   tidak bisa langsung P2P dan jatuh ke relay (lebih lambat, ±200–400 ms).
4. Buka URL → **Main Online** → **Buat Ruangan** → kirim kode / tautan ke teman.

## Kontrol
- **HP (landscape)**: geser di sisi kiri layar → joystick muncul di bawah ibu jari (ikut terseret, tidak kehabisan jangkauan). **BOM** & **SOAL** di kanan bawah,
  jawaban & kemampuan di panel kanan. Settings: joystick *Mengambang/Tetap*, ukuran kontrol *Kecil/Sedang/Besar*. Tombol ⛶ = layar penuh (juga mengunci landscape).
- **PC**: WASD atau panah, Spasi/Enter = bom, Q = soal, 1–4 = jawab, Esc = menu (game online tidak berhenti saat menu dibuka).

## Lokal & tes
```bash
node dev-server.js        # http://localhost:3000 (penyimpanan memori)
npm test                  # 13 tes API pensinyalan
python3 test/e2e.py       # 2 browser sungguhan (host desktop + tamu HP) lewat WebRTC (pip install playwright && playwright install chromium)
```

## Batasan
- Host dipercaya untuk bom/ledakan/nyawa; posisi tiap pemain dipercaya dari perangkatnya (cukup untuk duel antar-teman, bukan anti-cheat).
- Tidak ada sambung-ulang di tengah pertandingan: bila koneksi putus, pertandingan berakhir dan kembali ke menu.
- Mode Play Local PvP (satu perangkat, dua pemain) tetap tersedia.
