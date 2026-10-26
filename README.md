# NUMBER BOMBER · Online

Versi online dari *NUMBER BOMBER* (Bomberman + soal matematika), 1 vs 1 dengan **kode ruangan** seperti math-duel.
Satu perangkat = satu pemain. Host = P1, tamu = P2.

## Kenapa terasa tanpa delay
Gameplay **tidak lewat server**. Dua perangkat tersambung langsung (WebRTC DataChannel), jadi latensi = jarak jaringan kedua HP saja.
- Gerakan, soal matematika, dan amunisi bom **dihitung di perangkat pemain sendiri** → respons sentuhan instan.
- Dunia bersama (bom, ledakan, peti, power-up, nyawa, timer ronde) diputuskan **host**, disiarkan sebagai kejadian andal + snapshot 10×/dtk.
- Bom tamu muncul seketika (prediksi lokal) lalu dikonfirmasi host. Lawan digambar dengan interpolasi + ekstrapolasi dari paket 30×/dtk.
- Server Vercel + Upstash Redis hanya dipakai untuk membuat/gabung ruangan, bertukar SDP/ICE, dan **relay cadangan** bila koneksi langsung gagal
  (badge kiri-bawah menampilkan `LANGSUNG · xx ms` atau `RELAY`).

## Mekanika amunisi bom
- Tiap ronde pemain mulai dengan **3 bom** (`CONFIG.AMMO_START`). Memasang bom memakai 1 amunisi; amunisi **tidak kembali** saat bom meledak.
- Untuk mengisi ulang, jawab soal matematika: **benar = +1 bom**; salah / waktu habis / soal ditutup = tidak dapat bom. Simpanan maksimal 6 (`CONFIG.AMMO_MAX`); soal tidak bisa dibuka bila sudah penuh.
- Math Energy, kemampuan (Fire Range, Bomb Capacity, Speed, Shield, Remote) serta power-up Bomb Capacity & Math Crystal dinonaktifkan. Power-up Speed Boots, Fire Range, dan Shield dari peti tetap ada.
- Online: amunisi dipegang perangkat masing-masing pemain (host tidak memeriksa amunisi tamu); bom tamu yang ditolak host mengembalikan amunisinya.

## Deploy ke Vercel
1. Taruh folder ini di GitHub → **Add New → Project** di Vercel (preset "Other", tanpa build command).
2. **Storage / Marketplace → Upstash Redis** → hubungkan ke proyek (mengisi `KV_REST_API_URL`/`KV_REST_API_TOKEN` atau `UPSTASH_REDIS_REST_*`). **Redeploy**.
3. *(Disarankan)* Tambahkan server **TURN** lewat env `ICE_SERVERS` (lihat `.env.example`). Tanpa TURN, sebagian jaringan seluler dengan NAT ketat
   tidak bisa langsung P2P dan jatuh ke relay (lebih lambat, ±200–400 ms).
4. Buka URL → **Main Online** → **Buat Ruangan** → kirim kode / tautan ke teman.

## Room Master (penonton)
Satu orang ketiga bisa **menonton** P1 vs P2 secara langsung: masuk lewat **Masuk sebagai Room Master** + kode ruangan, atau tautan **Tautan Room Master** dari host.
Ia tersambung langsung ke host (P2P, relay bila gagal), jadi tidak menambah beban jaringan antar-pemain. Hanya satu kursi Room Master; bisa masuk di tengah pertandingan
(arena langsung disinkronkan) dan bisa diganti orang lain bila keluar. Ia tidak punya kontrol maupun panel soal, dan tidak bisa memulai/menghentikan pertandingan.

## TURN dengan Metered
Tambahkan env di Vercel (Settings → Environment Variables), lalu Redeploy: `METERED_APP_NAME` (mis. `namaapp` dari `namaapp.metered.live`), `METERED_API_KEY`, dan opsional `METERED_REGION` (mis. `singapore`).
Server memanggil `https://NAMAAPP.metered.live/api/v1/turn/credentials?apiKey=…` dan meneruskan daftar ICE ke klien (cache 5 menit; bila Metered gagal jatuh ke `ICE_SERVERS` lalu STUN publik).
Cek: buka `/api/room?action=ice` — daftar harus berisi entri `turn:` dengan `username`/`credential`. Di game, badge kiri-bawah `LANGSUNG` = berhasil tersambung (lewat P2P atau lewat TURN); `RELAY` = jatuh ke relay Redis.

## Kontrol
- **HP (landscape)**: geser di sisi kiri layar → joystick muncul di bawah ibu jari (ikut terseret, tidak kehabisan jangkauan). **BOM** (menampilkan sisa amunisi) & **SOAL** di kanan bawah,
  pilihan jawaban di panel kanan. Settings: joystick *Mengambang/Tetap*, ukuran kontrol *Kecil/Sedang/Besar*. Tombol ⛶ = layar penuh (juga mengunci landscape).
- **PC**: WASD atau panah, Spasi/Enter = bom, Q = soal, 1–4 = jawab, Esc = menu (game online tidak berhenti saat menu dibuka).

## Lokal & tes
```bash
node dev-server.js        # http://localhost:3000 (penyimpanan memori)
npm test                  # 17 tes API pensinyalan
python3 test/e2e.py       # 2 browser sungguhan (host desktop + tamu HP + Room Master) lewat WebRTC (pip install playwright && playwright install chromium)
```

## Batasan
- Host dipercaya untuk bom/ledakan/nyawa; posisi tiap pemain dipercaya dari perangkatnya (cukup untuk duel antar-teman, bukan anti-cheat).
- Tidak ada sambung-ulang di tengah pertandingan: bila koneksi putus, pertandingan berakhir dan kembali ke menu.
- Mode Play Local PvP (satu perangkat, dua pemain) tetap tersedia.
