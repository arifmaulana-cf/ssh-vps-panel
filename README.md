# SSH VPS Panel

Panel web untuk mengelola VPS dari browser. Bentuknya **desktop Ubuntu
(GNOME)**: top bar dengan Activities, dock di tepi kiri dengan penanda aplikasi
yang sedang jalan, Activities overview, dan jendela mengambang yang bisa
digeser, diubah ukurannya, diminimalkan, atau dimaksimalkan.

```
Browser (GNOME shell + xterm.js)  <--WebSocket-->  Express + ws  <--ssh2-->  VPS
   top bar · dock · window manager · 6 aplikasi         1 koneksi SSH per sesi
```

## Tampilan

Shell-nya mengikuti bahasa desain GNOME:

| Elemen | Detail |
|---|---|
| **Top bar** | Tinggi 32px, semi-transparan + blur. Kiri: Activities lalu **menu aplikasi** (Berkas / Edit / Tampilan / Bantuan) yang menukar isinya mengikuti jendela yang difokuskan. Tengah: judul jendela aktif. Kanan: status sesi, jam, menu sistem |
| **Dock** | Tepi kiri, blur. **Aplikasi yang dipasang** selalu ada; yang lain dipisah garis dan hanya muncul selagi berjalan. Titik oranye di kiri ikon menandai yang jalan. Klik kanan ikon untuk memasang/melepas |
| **Jendela** | Sudut 12px, headerbar gelap dengan judul terpusat, 3 tombol bulat ala GNOME, bayangan dalam, jendela aktif sedikit membesar, jendela tidak aktif meredup |
| **Activities** | Tekan **Super** atau tombol Activities: seluruh jendela di-scale jadi pratinjau di atas latar gelap, klik salah satu untuk memfokuskan |
| **App grid** | Tekan **Super**: daftar **semua** aplikasi dengan kategori di kiri dan kotak pencarian. Mencari tidak ikut difilter kategori, jadi mengetik "peng" tetap menemukan Pengaturan |
| **Quick settings** | Klik **jam**: kalender, daftar sesi SSH beserta metode autentikasinya, dan pintasan ke Tema/Putuskan/Keluar |
| **Menu klik kanan** | Klik kanan desktop memakai kalimat Ubuntu asli: Buka Terminal, Folder baru di beranda, **Pengaturan Layar**, **Ganti Latar**, **Pengaturan**, Semua Aplikasi, Tampilkan Jendela, Putuskan Sesi, Koneksi Baru |
| **Split screen** | Seret jendela ke tepi atau pojok untuk mengunci ke petak. Beberapa jendela bisa mengisi layar bersamaan, dan **pembagi antar petaknya bisa digeser** |
| **Snap layout** | Tahan kursor di tombol **Perbesar** → enam tata letak ala Windows 11 (2 kolom, 2 baris, 3 kolom, 3×2, 4 kolom). Klik petak mana pun untuk melompat ke sana |
| **Proksi** | Lihat bagian [Proksi web lewat SSH](#proksi-web-lewat-ssh) - termasuk batasnya yang jujur |
| **Menu snap** | Klik kanan pada judul jendela: layar penuh, kiri/kanan/atas/bawah, keempat pojok, pilih tata letak, atau lepas dari petak |
| **Ikon** | SVG buatan sendiri, viewBox 16×16, stroke 1.4px. Bukan emoji, karena bentuk emoji berubah antar platform dan hilang di klien tanpa font warna |
| **Ukuran ikon** | Selalu dari CSS, tidak pernah dari atribut. SVG `icons.js` sengaja dibuat tanpa `width`/`height`; diletakkan di tempat tanpa aturan seperti `.icon-btn svg`, ikon tampil sebesar elemen terganti default - yaitu raksasa |
| **Palet** | Ubuntu dark — oranye `#e95420`, aubergine, permukaan `#242424` |

### Arah desain

Arah visual, alasan di balik setiap keputusan, dan catatan respecteks terhadap
filter antislop ada di [`DESIGN.md`](./DESIGN.md). Ringkasnya: radius tiga
langkah, elevasi hanya pada yang benar-benar melayang, kuota dua permukaan
kaca, kuota dua glow, dan wallpaper geometris bersudut (bukan radial glow).

### Tema

Sembilan tema, semuanya memakai palet asli dari proyeknya: **Ubuntu**,
**Catppuccin** (Mocha & Latte), **Nord**, **Gruvbox** (Dark & Light),
**Tokyo Night**, **Everforest**, dan **Ros Pine**.

Shell tetap GNOME di semua tema — yang berubah hanya token warnanya. **Terminal
ikut tema**, jadi warna shell ikut berganti, bukan cuma kerangka panelnya.

Tema tersimpan di `localStorage` dan diterapkan sebelum halaman dirender, jadi
tidak ada kedipan warna saat dimuat.

```
Menu sistem (ikon gerigi di kanan atas) → Tema
```

### Pintasan papan tik

| Pintasan | Aksi |
|---|---|
| `Super` | Buka app grid (daftar aplikasi + pencarian) |
| `Escape` | Tutup app grid, quick settings, menu, atau overview |
| `Ctrl+Alt+T` | Terminal baru |
| `Alt`+`←` `→` `↑` `↓` | Sama seperti `Super`+panah (cadangan bila OS memakan `Super`) |
| `Alt+F4` | Tutup jendela yang terfokus |
| `Alt+Tab` | Pindah antar jendela |
| `Super`+`←` / `→` | Snap jendela terfokus ke kiri atau kanan |
| `Super`+`↑` | Perbesar jendela |
| `Super`+`↓` | Kembalikan ke ukuran sebelumnya / lepas dari petak |

Pintasan snap juga jalan dengan `Alt` sebagai pengganti `Super`, karena
beberapa sistem operasi memakan `Super` sebelum browser menerimanya.

### `allow-same-origin` pada iframe proksi

Ini keputusan yang membalikkan keputusan sebelumnya, dan alasannya sebaiknya
dibaca sebelum mengubahnya lagi.

Awalnya iframe proksi memakai sandbox **tanpa** `allow-same-origin`, dengan
alasan: halaman target disajikan pada asal panel, jadi JavaScript di dalamnya
seharusnya tidak bisa membaca `localStorage` panel atau memanggil `/api/*`
sebagai pengguna. Alasannya benar. Akibatnya tidak diperhitungkan:

- Tanpa token itu dokumen iframe mendapat **asal buram** (opaque origin).
- Setiap `fetch()` dari JavaScript situs tujuan menjadi lintas asal. Route
  proksi tidak mengirim `Access-Control-Allow-Origin`, sehingga browser
  menolak setiap permintaan.
- Cookie juga tidak ikut, karena `fetch` bawaan memakai `credentials:
  'same-origin'` yang otomatis gagal untuk asal buram.

Yang tampil bukan halaman error. Dokumen HTML, CSS, dan JS tetap termuat, lalu
tidak ada satu pun data yang bisa diambil — **Jenkins muncul sebagai halaman
kosong**, karena seluruh UI-nya dibangun dari XHR (`/api/json`,
`crumbIssuer`). Halaman kosong tanpa pesan adalah gejala yang paling mahal
untuk didiagnosis, dan itulah yang terjadi.

Jadi `allow-same-origin` dipulihkan. Konsekuensinya, dinyatakan terbuka:

| Yang berubah | Akibatnya |
|---|---|
| Halaman target berbagi asal dengan panel | JS target bisa membaca `localStorage` panel dan memanggil `/api/*` sebagai Anda |
| Cookie sesi target ikut diteruskan | Login Jenkins/ArgoCD akhirnya bisa bertahan |

**Yang terekspos jika target dipakai untuk menyerang:** `POST /api/users`
(membuat akun), `POST /api/auth/password` (mengubah password Anda),
`POST /api/ssh/connect` (membuka sesi SSH), dan `PUT /api/ssh/file/:id`
(menulis berkas di VPS). Jadi, target yang punya XSS berarti sesi panel ikut
hilang.

Yang **tidak** terekspos: `localStorage` panel hanya berisi tema, dock
favorit, riwayat target, dan `{host, port, username}` untuk server yang
disimpan. Password dan private key tidak pernah masuk `localStorage` maupun
berkas mana pun di sisi panel.

**Sandbox bukan batas yang dapat diandalkan di sini.** Selama halaman ber-asal
sama dengan panel, `allow-same-origin` tidak bisa memisahkannya.
Satu-satunya pemulihan pemisahan yang benar adalah menyajikan proksi dari
**asal sendiri** — asal berbeda berarti `localStorage`, cookie, dan CORS
terpisah secara otomatis. Itu memerlukan hostname kedua, yang bisa diperoleh
dari Tailscale (alamat berbeda) atau Cloudflare named tunnel (subdomain).

### Cookie: kenapa tidak bisa disaring berdasarkan Path

Penyaringan cookie memakai **nama**, bukan `Path`. Atribut `Path` hanya ada di
`Set-Cookie`; header `Cookie` pada request hanya berisi `nama=nilai` tanpa
informasi path. Versi yang mencoba memfilter dengan `Path` karena itu membuang
seluruh cookie — termasuk milik target.

Nama cookie target dicatat di sesi ketika `Set-Cookie`-nya ditulis ulang, dan
hanya nama itu yang diteruskan. Cookie sesi panel (`panel.sid`) tidak pernah
diteruskan; kalau target mengembalikan cookie dengan nama yang sama, `Set-Cookie`
-nya diabaikan dan dicatat di log, karena meneruskannya akan membuat panel
mengirim cookie sesinya sendiri.

## Menu Ubuntu yang sengaja tidak ada

Bagian ini sengaja ada, karena meniru Ubuntu tanpa batas bisa membuat panel
terlihat lebih lengkap dari kenyataannya. Yang berikut **tidak ada**, dan alasannya:

| Menu Ubuntu asli | Kenapa tidak ada |
|---|---|
| **Suspend / Restart / Matikan** | Ketiganya perintah untuk mesin tempat panel berjalan - yaitu komputer Anda, bukan panel. Panel juga tidak bisa menyalakan dirinya sendiri tanpa supervisor. Dialog "Matikan / Keluar" hanya menawarkan **Keluar** dan menjelaskan kenapa tiga tombol itu absen. |
| **Kunci Layar (Lock)** | Sinya peramban. Yang sebenarnya dilindungi adalah cookie sesi, dan itu sudah punya masa berlaku plus pemutusan sesi dari sisi server. |
| **Ganti Pengguna (Switch User)** | Butuh dua sesi desktop di satu tab; panel memakai satu sesi per tab. |
| **Panel Displays / Keyboard Layout / Mouse** | Panel ini bukan kendali mesin. Padanan yang jujur adalah **Pengaturan Layar** = snap layout jendela, yang memang bekerja. |
| **Panel Accessibility** | Bisa berupa ukuran font dan kontras; pengaruhnya nyata, tapi belum ada - jadi tombolnya pun belum. |
| **Notifikasi aplikasi** | Panel tidak punya perangkat notifikasi OS yang bisa dipakai andal lintas peramban. Toast internal yang ada sekarang bukan pengganti itu, dan tidak diklaim sebagainya. |

Sebaliknya, **menu yang ada semuanya berfungsi**. Ada gate check yang membaca
setiap `ctx.setMenus()` lalu mencari nama fungsi yang dipanggil tapi tidak
dideklarasikan di berkas yang sama - supaya tidak mungkin ada butir menu yang
biru.

### Catatan teknis: split screen

Layout tiling disimpan sebagai **batas ternormalisasi** (fraksi 0..1), bukan
piksel: `cuts.x = [0.5]` berarti satu batas vertikal di tengah. Jendelanya
menyimpan `{c, r, cs, rs}`, jadi "kiri" adalah 1 kolom tapi semua baris.

Yang perlu diketahui saat mengubahnya:

- **Ubah jumlah kolom/baris akan menghitung ulang batas jadi sama rata.**
  Memilih tata letak 3 kolom setelah 2 kolom akan undistribusi jendela, bukan
  memotongnya. Ini yang Windows lakukan juga.
- **Pembagi punya jarak minimum antar batas.** Kalau batas ke-2 ditarik ke kiri
  sampai batas ke-1, keduanya tidak boleh menyatu - hasilnya nol dan tidak ada
  yang bisa diklik.
- **Berpindah petak tidak selalu menukar.** Kalau jendela pengganti punya ukuran
  petak yang sama, keduanya bertukar posisi (kasus umum dua jendela). Kalau
  tidak, jendela yang tersingkir dilepas jadi jendela bebas - "mendorong keluar"
  tanpa memberi tempat yang bisa diprediksi akan membuat jendela hilang dari
  pandangan.
- **Jendela bertiles tidak punya handle resize.** Ukurannya milik grid. Handle-nya
  disembunyikan lewat CSS **dan** diperiksa ulang di WM, supaya tidak ada jalur
  tersembunyi yang tetap bisa mengubah ukuran.
- **Menyeret jendela yang sedang di petak akan melepasnya**, begitu pula
  jendela layar penuh. Tanpa itu, snap dari layar penuh hanya bisa lewat
  pintasan papan tik.

### Catatan teknis: lapisan z-index

`z-index` jendela naik setiap kali difokuskan, sementara top bar dan menu
sistem punya angka tetap (900 dan 950). Kalau keduanya berada di satu stacking
context, jendela akan menutupi menu setelah cukup banyak interaksi.

Karena itu **area kerja diberi `isolation: isolate`**: ia menjadi stacking
context sendiri, sehingga z-index jendela hanya bersaing dengan jendela lain
dan **tidak pernah bisa menutupi lapisan shell**. Selain itu z-index-nya dihitung
ulang secara berkala supaya tidak tumbuh tanpa batas.

## Aplikasi

| Aplikasi | Butuh SSH | Fungsi |
|---|---|---|
| **Terminal** | ya | Shell interaktif, multi-tab. Tiap tab = satu channel shell pada **koneksi SSH yang sama**. |
| **File Manager** | ya | Jelajah folder, buka file, buat/hapus/rename, upload (tombol atau drag & drop), download. |
| **Text Editor** | ya | Buka & edit teks, simpan atomik (tulis sementara lalu `mv`), peringatan kalau ditutup tanpa disimpan. |
| **System Monitor** | ya | Kartu OS / uptime / core / RAM / disk + grafik riwayat. |
| **Process Viewer** | ya | Daftar proses (`ps`), bisa diurutkan kolom mana pun, refresh otomatis. |
| **Disk Usage** | ya | Kapasitas tiap mount + folder terbesar (`du`), bisa diklik untuk menelusuri. |
| **Pengguna** | tidak | *Khusus admin.* Daftar akun, jumlah sesi SSH tiap orang, buat/nonaktifkan/hapus, ganti password, paksa logout. |
| **Pengaturan** | tidak | Lima bagian: Tampilan, Sesi & Koneksi, Akun, Papan Tik, Tentang. |
| **Browser** | ya | Proksi web lewat SSH. Buka Jenkins, ArgoCD, Grafana, atau apa pun yang berjalan di VPS tanpa membuka tunnel. |

Dua aplikasi terakhir bekerja pada panel itu sendiri, bukan pada VPS, jadi tidak
butuh koneksi SSH. Keduanya juga **tidak ada di dock** - persis seperti
Settings di Ubuntu - tapi bisa dicari lewat app grid.

### Menu bar aplikasi

Menubar di top bar adalah bagian yang paling sering hilang di panel web, dan
justru yang paling membuat sebuah aplikasi terasa seperti aplikasi desktop. Ada
di Terminal, File Manager, Text Editor, System Monitor, Process Viewer, Disk
Usage, Pengguna, dan Pengaturan.

Setiap butirnya benar-benar menjalankan sesuatu. Menu yang tidak punya
implementasi nyata tidak ditampilkan sama sekali - lihat bagian
[Menu Ubuntu yang sengaja tidak ada](#menu-ubuntu-yang-sengaja-tidak-ada).


## Multi-user

Panel bisa dipakai lebih dari satu orang. Yang dijamin: **tiap orang hanya
bisa melihat dan memakai sesinya sendiri.**

### Membuat akun

Menu sistem (ikon gerigi, kanan atas) → **Pengguna** → **Buat akun**.
Entri ini hanya muncul kalau Anda admin. Dari sana juga bisa melihat berapa
akun yang sudah dibuat, siapa yang membuat siapa, dan berapa koneksi SSH
yang sedang hidup untuk tiap orang.

Menu **Ganti password saya** ada untuk semua user, bukan cuma admin.

### Yang terisolasi, dan bagaimana

| Hal | Pemeriksaan | Mekanisme |
|---|---|---|
| Sesi SSH | Dipisah per user | `resolveSession()` membandingkan `userId`; beda user → `403` |
| Terminal (WebSocket) | Ditolak **sebelum** upgrade | `403` di handler `upgrade`, jadi socket-nya tidak pernah terbuka |
| Berkas di VPS | Ditolak | Endpoint SFTP semuanya lewat `resolveSession()` |
| Jejak audit | Dipisah | User biasa hanya melihat entri dirinya; admin melihat semua |
| Daftar akun | Admin saja | `requireAdmin` di server |

Kuncinya `userId`, bukan username: `userId` dibuat sekali dan tidak pernah
berubah, sedangkan username bisa diganti atau dinonaktifkan.

### Mematikan akses satu orang

Nonaktifkan, hapus, ganti password, atau **Putuskan** — semuanya memutus sesi
web **dan** koneksi SSH milik orang itu, seketika, bukan menunggu timeout.
Jumlah sesi yang diputus dilaporkan balik ke admin.

Dua pengaman yang tidak bisa dilewati: Anda tidak bisa menonaktifkan,
menghapus, atau menurunkan peran **akun sendiri**, dan tidak bisa
menonaktifkan admin terakhir.

### Akun admin awal

Saat pertama kali jalan, `ADMIN_USER` / `ADMIN_PASS` dari `.env` dijadikan
akun admin di `data/users.json`. **Itu hanya terjadi sekali.** Setelah itu
`.env` tidak lagi dipakai untuk login.

> **Jangan hapus `data/users.json` untuk "mulai bersih".** Panel akan membuat
> ulang admin dari `.env`, dan itu **menghidupkan kembali password lama** —
> bukan password yang sudah Anda ganti lewat UI. Pakai menu Pengguna saja.

### Batas multi-user yang perlu diketahui

- Hanya dua peran: `admin` dan `user`. Tidak ada RBAC per-endpoint.
- Jejak audit in-memory, maks 300 entri, hilang saat restart.
- Tidak ada rekaman sesi terminal.
- Tidak ada 2FA. Kalau panel ini dijangkau lewat internet publik, satu
  password per akun adalah seluruh benteng Anda — pasang HTTPS, atau
 Batasi aksesnya.

## Proksi web lewat SSH

Untuk melihat Jenkins, ArgoCD, atau Grafana **tanpa harus membuat tunnel**:
menu aplikasi → **Browser**, lalu ketik `localhost:8080` atau
`https://argocd.internal:8443`.

Yang bekerja: panel membuka channel `direct-tcpip` ke `host:port` tujuan
**lewat koneksi SSH milikmu sendiri**, berbicara HTTP di atasnya, lalu
menyajikan hasilnya di iframe. **Tidak ada port baru yang dibuka di server**,
dan tidak perlu konfigurasi di peramban.

Preset yang disediakan: Jenkins (`:8080`), ArgoCD (`:443`), Grafana (`:3000`),
Portainer (`:9000`). Alamat lain bisa disimpan sendiri.

### Yang otomatis diperbaiki

Halaman asli perlu sedikit "penyesuaian" supaya bisa hidup di iframe:

| Masalah | Yang dilakukan panel |
|---|---|
| `X-Frame-Options` / CSP `frame-ancestors` dari Jenkins atau ArgoCD | Dibuang - kalau tidak, halaman menolak tampil di iframe sama sekali |
| Aset absolut (`/static/app.js`) | Ditulis ulang ke prefix proksi. **`<base>` saja tidak cukup** - URL berawalan `/` mengabaikan `<base>` dan selalu memakai asal halaman |
| Aset relatif (`logo.png`) | `<base>` disisipkan |
| Redirect absolut (`Location: http://10.0.0.5:8080/`) | Diterjemahkan ke URL proksi lengkap |
| `Set-Cookie` dari target | `Domain` dibuang, `Path` diarahkan ke prefix proksi |
| Cookie sesi panel | Tidak pernah dikirim ke situs tujuan |
| Gzip | Diminta `identity` - sedikit lebih besar, tapi tidak perlu dekompresi |

### Batasnya, dinyatakan terbuka

Ini bukan peramban, dan tidak berpura-pura jadi peramban:

- **Satu request = satu channel SSH.** Sistem target punya batas channel
  (`MaxSessions`); halaman dengan 200 aset akan sering kena batas itu.
- **Penulisan ulang asal di dalam JS/CSS.** Jenkins 2.5x menjawab 403 dengan
  halaman bootstrap ~991 byte yang memuat `redirect.js`, dan `redirect.js` itu
  berisi URL **absolut** ke dirinya sendiri
  (`window.location.replace("http://localhost:8080/login")`). Penulisan ulang
  HTML tidak menangkapnya, karena URL-nya ada di dalam berkas JavaScript.
  Akibatnya iframe mendarat di port 8080 komputer Anda — yang tidak ada
  tunnelnya — dan jadi **kosong tanpa pesan**.

  Perbaikan: asal target ditulis ulang di dalam badan JS, CSS, JSON, dan teks.
  Kalau target diketik `127.0.0.1:8080` tapi Jenkins membalas dengan
  `localhost:8080`, keduanya ditulis ulang — keduanya menunjuk layanan yang
  sama. Ejaan loopback yang lain tidak ikut, karena `127.0.0.2` bukan layanan
  yang sama.

- **Batasnya: skrip yang membangun URL saat runtime.** `fetch("/api/json")`
  relatif sudah aman karena `<base>` berlaku. Tapi
  `fetch("http://" + host + ":" + port)` tidak bisa ditulis ulang, karena URL
  baru ada setelah skrip berjalan.
- **CSP situs tujuan tidak ditegakkan.** Header-nya dibuang supaya halaman bisa
  tampil. Kalau sebuah situs bergantung pada CSP-nya sendiri, ia akan berjalan
  lebih longgar di sini.
- **CSS/JS yang meng-hardcode URL absolut ke host lain** akan gagal dimuat.
- **Service worker tidak berjalan** (proksi selalu membuat channel baru).
- **`SameSite=Strict` pada cookie target tidak terkirim di dalam iframe.** Kalau
  login Jenkins tidak "nempel", ini penyebabnya.
- **Bukan peramban**: tidak ada ekstensi, bookmark per situs, atau riwayat
  antar-target yang bertahan.

### Dua keputusan keamanan yang perlu Anda tahu

**1. Iframe-nya tidak diberi `allow-same-origin`.**

Halaman tujuan disajikan pada asal panel sendiri. Kalau `allow-same-origin`
diberikan, JavaScript di dalamnya berjalan sewenang-wenang di asal panel: bisa
membaca localStorage, memanggil `/api/*` dengan sesimu, dan membaca
responsnya. Untuk Jenkins atau ArgoCD yang kebetulan punya celah XSS, itu
berarti **seluruh akun panel ikut hilang**. Jadi asal buram dipilih; cookies
target tetap terkirim, login di dalam iframe tetap bekerja.

**2. Sertifikat HTTPS target tidak diverifikasi.**

Sertifikat di jaringan internal sering ditandatangani sendiri, dan panel
tidak punya CA organisasi untuk memverifikasinya. Jadi `rejectUnauthorized`
dimatikan. Artinya: panel tidak memberi peringatan kalau sertifikat server
tujuan berubah atau pals. Yang tetap berlaku adalah aturan aksesnya - proksi
hanya bisa menjangkau apa yang sudah bisa dicapai lewat shell milikmu sendiri.

### Batas wewenang

Proksi memakai sesi SSH milik pemanggil dan **hanya itu**. User lain yang
menggunakan id sesi milikmu mendapat `403` (ada tesnya). Setiap target yang
dicoba dicatat di jejak audit bersama pelakunya.

Kalau memang butuh sesi SSH milik orang lain, itu fitur yang disengaja tidak
ada.

## Beban server

Shell desktop (top bar, dock, jendela) murni CSS/JS di browser, jadi **nol
beban server**. Yang dikirim ke VPS hanya permintaan kecil:

| Aksi | Ukuran |
|---|---|
| Membuka window / menggeser jendela | 0 byte |
| Membuka satu folder | ~3 KB (1 round-trip SFTP) |
| Refresh Process Viewer | ~8 KB (1 `ps`) |
| Refresh System Monitor | ~1 KB tiap 10 detik |
| Terminal streaming | hanya yang ini yang terus mengalir |

## Fitur lain

- **Host key verification** gaya Trust-On-First-Use: sidik jari host dicatat
  saat koneksi pertama dan diperiksa lagi pada koneksi berikutnya.
- **Sesi login in-memory**, cookie `httpOnly` + `SameSite=Strict`.
- Batas jumlah sesi, masa berlaku sesi, dan rate limit pada percobaan koneksi.
- **Audit log** untuk setiap operasi yang mengubah server (tulis, hapus, upload,
  rename) — dicetak ke stdout dan tersedia lewat `GET /api/ssh/audit`.

## Menjalankan

```bash
npm install
npm start
```

Saat dijalankan pertama kali, aplikasi membuat file `.env` sendiri dan
mencetak kredensial admin acak di terminal:

```
  SSH VPS Panel aktif
  -> alamat    : http://localhost:3000
  -> user      : admin
  -> password  : <password-acak-yang-dicetak-terminal>
  -> batas     : 5 sesi / 30 menit
```

Buka `http://localhost:3000`, masuk dengan kredensial tersebut, lalu isi form
koneksi (host, port, username, password).

Untuk mode pengembangan dengan auto-reload:

```bash
npm run dev
```

## Konfigurasi

Semua opsi ada di `.env` (lihat `.env.example`):

| Variabel | Default | Keterangan |
|---|---|---|
| `PORT` | `3000` | Port HTTP/HTTPS panel |
| `HOST` | `0.0.0.0` | Antarmuka yang di-bind |
| `ADMIN_USER` | `admin` | Username admin awal. **Hanya dipakai sekali**, saat `data/users.json` masih kosong |
| `ADMIN_PASS` | (acak) | Password admin awal. **Hanya dipakai sekali**; setelah itu ganti lewat menu **Pengguna** |
| `SESSION_SECRET` | (acak) | Kunci penanda tangan cookie sesi |
| `SESSION_TTL_MINUTES` | `480` | Masa berlaku cookie sesi login |
| — | — | Jumlah user, peran, dan status aktif dikelola lewat `data/users.json` + UI, bukan lewat `.env` |
| `SSH_TTL_MINUTES` | `30` | Masa berlaku satu sesi SSH |
| `MAX_SESSIONS_PER_USER` | `5` | Jumlah sesi SSH aktif maksimal |
| `CONNECT_TIMEOUT_MS` | `20000` | Batas waktu koneksi ke VPS tujuan |
| `TRUST_HOST_KEY` | `tofu` | `tofu` atau `false` |
| `FS_ROOT` | `/` | Batas akses File Manager, mis. `/home/ubuntu` |
| `MAX_UPLOAD_BYTES` | `67108864` | Maksimum ukuran upload (64 MB) |

## Endpoint

| Method | Endpoint | Fungsi |
|---|---|---|
| `POST` | `/api/auth/login` | Login, set cookie sesi |
| `GET` | `/api/auth/session` | Status login saat ini |
| `POST` | `/api/auth/logout` | Hapus sesi |
| `GET` | `/api/ssh/sessions` | Daftar sesi SSH aktif milik user |
| `POST` | `/api/ssh/connect` | Buat sesi SSH baru (password atau private key) |
| `POST` | `/api/ssh/validate-key` | Periksa private key + passphrase tanpa koneksi |
| `POST` | `/api/ssh/disconnect/:id` | Tutup sesi SSH |
| `POST` | `/api/ssh/tabs/:id` | Buka tab shell baru pada sesi yang ada |
| `DELETE` | `/api/ssh/tabs/:id/:tabId` | Tutup satu tab |
| `POST` | `/api/ssh/resize/:id` | Sinkronkan ukuran terminal (`cols`, `rows`, `tabId`) |
| `GET` | `/api/ssh/metrics/:id` | OS, uptime, CPU, RAM, disk |
| `GET` | `/api/ssh/processes/:id` | Daftar proses ter-parse |
| `GET` | `/api/ssh/diskusage/:id` | Kapasitas mount + `du` |
| `GET` | `/api/ssh/files/:id` | Isi folder |
| `POST` | `/api/ssh/mkdir/:id` | Buat folder |
| `POST` | `/api/ssh/rename/:id` | Ganti nama |
| `DELETE` | `/api/ssh/files/:id` | Hapus file atau folder (rekursif) |
| `GET` | `/api/ssh/file/:id` | Baca file teks (maks 2 MB) |
| `PUT` | `/api/ssh/file/:id` | Simpan file teks |
| `POST` | `/api/ssh/upload/:id` | Upload biner (body mentah + header `X-File-Name`) |
| `GET` | `/api/ssh/download/:id` | Download file |
| `GET` | `/api/ssh/audit` | Jejak audit operasi (user biasa: miliknya sendiri; admin: semuanya) |
| `WS` | `/ws/term/:id/:tabId` | Bridge terminal dua arah |
| `POST` | `/api/auth/password` | Ganti password sendiri (butuh password lama) |

### Endpoint proksi

Semua memakai `resolveSession`: hanya bisa dipakai dengan sesi SSH milik
user yang sedang login.

| Method | Endpoint | Fungsi |
|---|---|---|
| `GET` | `/api/proxy/:sessionId/probe?host=&port=&secure=` | Cek apakah target bisa dijangkau dari VPS |
| `GET` | `/api/proxy/:sessionId/*?host=&port=&secure=&path=` | Ambil halaman dari target, sudah ditulis ulang header-nya |

### Endpoint akun (khusus admin)

Semua menolak non-admin dengan `403`, dicek di server — bukan hanya dengan
menyembunyikan tombol.

| Method | Endpoint | Fungsi |
|---|---|---|
| `GET` | `/api/users` | Daftar akun + ringkasan + jumlah sesi SSH tiap user |
| `POST` | `/api/users` | Buat akun (`username`, `password`, `role`) |
| `PATCH` | `/api/users/:id` | Ubah `disabled` atau `role` |
| `PUT` | `/api/users/:id/password` | Admin mengganti password user lain |
| `DELETE` | `/api/users/:id` | Hapus akun (tidak bisa menghapus akun sendiri) |
| `POST` | `/api/users/:id/revoke` | Paksa logout + putuskan sesi SSH |

## Catatan keamanan

Panel ini memberi akses shell, jadi perlakukan seperti aplikasi admin, bukan
seperti landing page publik.

- **Selalu pasang di belakang HTTPS** (reverse proxy nginx/Caddy) saat diakses
  dari jaringan publik. Kredensial SSH dikirim lewat koneksi ke panel — tanpa
  TLS, password bisa dicuri di tengah jalan.
- **Ganti `ADMIN_PASS`** yang di-generate otomatis sebelum panel dipakai serius.
  Setelah akun pertama dibuat, ganti lewat menu **Pengguna** atau
  `Ganti password saya`. Perubahan di situ tidak akan ditimpa `.env`.
- **Kredensial VPS hanya ada di memori server**, tidak pernah ditulis ke disk
  maupun dikirim balik ke browser. Yang tersimpan permanen hanya sidik jari
  host key di `data/known_hosts.json`.
- **Rate limit login dibuat berlapis**, karena panel ini bisa dipakai banyak
  orang yang berbagi satu IP:

  | Lapis | Kunci | Batas |
  |---|---|---|
  | 1 | alamat IP | 40 / 5 menit |
  | 2 | IP + username | 10 / 5 menit |
  | 3 | username | 8 / 10 menit |

  Batas IP sengaja dinaikkan dari 10: dengan batas lama, sepuluh orang yang
  login sah dari satu kantor akan saling mengunci.
- Panel sudah memakai rate limit (login berlapis di atas, koneksi 20×/menit) dan
  memvalidasi `host`/`username` agar tidak bisa disisipkan argumen SSH.
- **Membuka lebih dari `MAX_SESSIONS_PER_USER` akan ditolak**, bukan memutus
  sesi lama — terminal yang sedang Anda pakai tidak akan dibunuh diam-diam.
- Cookie sesi bersifat `httpOnly` + `SameSite=Strict`. Untuk HTTPS, set
  `FORCE_SECURE_COOKIE=1` agar cookie memakai flag `Secure`.
- **`FS_ROOT` membatasi jalur File Manager.** Default-nya `/` karena panel ini
  alat administer server, bukan alat berbagi file. Kalau panel ini diteruskan
  ke orang lain, set `FS_ROOT=/home/user-mereka` supaya mereka tidak bisa
  menyentuh `/etc/shadow` lewat File Manager.
- **Upload dan Simpan menulis lewat berkas sementara lalu `mv -f`**, jadi file
  asli tidak pernah tertinggal setengah tertulis. Upload dibatasi 64 MB
  (`MAX_UPLOAD_BYTES`); file yang diedit di editor dibatasi 2 MB.
- Sesi login disimpan in-memory (`express-session` + `MemoryStore`), jadi semua
  user keluar saat server restart. Untuk multi-user atau banyak instance,
  ganti ke `connect-redis`/`connect-mongo`.

### Verifikasi host key

Saat pertama kali terhubung ke `host:port`, sidik jari SHA256 host key disimpan
ke `data/known_hosts.json`. Koneksi berikutnya ke host yang sama akan
dibandingkan, dan akan ditolak bila berbeda. Ini sinyal adanya kemungkinan
serangan MITM:

```
Host key berubah untuk 203.0.113.10:22.
  tersimpan : SHA256:abc...
  diterima  : SHA256:def...
Hapus entri di data/known_hosts.json bila Anda yakin ini host yang sama.
```

File itu dibaca ulang otomatis ketika berubah, jadi menghapus entri langsung
berlaku tanpa restart server.

## Autentikasi

Panel mendukung dua metode, dipilih per koneksi:

| Metode | Kapan dipakai |
|---|---|
| **Password** | Server VPS biasa, atau user dengan login password |
| **Private key** | AWS EC2, GCP Compute Engine, DigitalOcean, dan sebagian besar VPS modern |

### Private key

Format yang diterima (sudah diuji terhadap sshd sungguhan):

- RSA PKCS#1 — `-----BEGIN RSA PRIVATE KEY-----`, format default AWS EC2
- ED25519 — `-----BEGIN OPENSSH PRIVATE KEY-----`, juga didukung AWS EC2
- Keduanya **boleh terenkripsi**; isi field passphrase bila ada

**Key tidak pernah disimpan.** Tidak ditulis ke disk server, tidak masuk
`localStorage`, tidak masuk audit log, dan tidak ikut terkirim di respons mana
pun. Ia hanya hidup selama satu permintaan koneksi lalu dibuang dari memori.
Untuk itu setiap kali Anda perlu memilih file lagi.

Tombol **Periksa key** memvalidasi key tanpa menyentuh jaringan sama sekali,
sehingga passphrase yang salah ketahuan sebelum Anda menunggu koneksi gagal.

Preset username AWS tersedia di form: `ubuntu` (Ubuntu), `ec2-user` (Amazon
Linux), `admin` (Debian), `root`.

### Risiko yang perlu Anda sadari

Mengunggah private key ke web server **bukan hal yang sama dengan password**.
Password bisa dirotasi kalau bocor; private key tidak bisa dirotasi tanpa
membuat key pair baru di provider dan menggantinya di setiap instance.

Karena itu:

- Jangan gunakan panel ini lewat URL publik tanpa HTTPS
- Ganti password admin sebelum memakai key sungguhan
- Panel ini hanya untuk server yang memang Anda miliki sendiri
- Kalau memang dipakai bersama, beri tiap orang akun sendiri. Membagikan satu
  akun admin ke banyak orang membuat jejak audit tidak berguna: semua baris
  akan tercatat atas nama yang sama, dan tidak ada yang bisa dicabut
  per orang

Kalau tidak ingin memakai private key sama sekali, **AWS Session Manager (SSM)**
memberi Anda shell tanpa key sama sekali — tapi itu lewat `aws-cli`, bukan
SSH, dan di luar cakupan panel ini.

## Struktur proyek

```
server/
  index.js            bootstrap HTTP + upgrade WebSocket (rute per tab)
  app.js              konfigurasi Express, helmet, session, rute statis
  config.js           pembacaan .env (lengkap dengan generator otomatis)
  routes/auth.js      login / logout / ganti password sendiri / rate limit berlapis
  routes/ssh.js       sesi, tab, system monitor, file, transfer, audit
  routes/users.js     administrasi akun (admin-only) + pemutusan sesi
  routes/proxy.js     proksi web lewat channel SSH: rewrite header + <base>
  lib/user-store.js   akun persisten: bcrypt, peran, status, guard admin terakhir
  lib/session-store.js store sesi berbasis berkas (bertahan lintas restart)
  lib/ssh-manager.js  pembungkus ssh2: connect, shell per tab, exec
  lib/ssh-proxy.js    channel direct-tcpip + batas channel untuk proksi web
  lib/sessions.js     store sesi SSH in-memory + TTL + batas jumlah
  lib/sftp.js         operasi file & transfer lewat channel SFTP
  lib/fs-paths.js     normalisasi path + tipe entri dari bit mode
  lib/sysinfo.js      parser `ps`, `df`, `du`
  lib/metrics.js      probe OS/uptime/CPU/RAM/disk
  lib/host-keys.js    Trust-On-First-Use untuk host key
  lib/audit.js        jejak operasi yang mengubah server
  middleware/auth.js  verifikasi kredensial + penjaga rute
public/
  index.html          kerangka halaman
  css/style.css       komponen dasar (login, modal, tombol)
  css/desktop.css     GNOME shell: top bar, dock, overview, window chrome
  js/desktop.js       bootstrap: login, sesi, dock, menu sistem, pemilih tema
  js/themes.js        katalog tema + token warna (skrip klasik, boot sinkron)
  js/icons.js         31 ikon SVG 16x16 milik sendiri
  js/wm.js            window manager (drag, resize, min/max, Activities overview)
  js/api.js           seluruh panggilan HTTP + URL WebSocket
  js/ui.js            helper: el(), toast, dialog, tabel, menu konteks
  js/tiling.js        split screen: grid ternormalisasi, snapping, pembagi geser
  js/menubar.js       menubar aplikasi: judul yang bisa diklik, dropdown, navigasi panah
  js/apps/*.js        satu berkas per aplikasi desktop (users.js admin-only, settings.js, browser.js)
data/                 users.json, sessions.json, known_hosts.json (otomatis, mode 0600)
```

## Menjalankan di belakang reverse proxy

```nginx
server {
  listen 443 ssl http2;
  server_name panel.example.com;

  location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Upgrade    $http_upgrade;   # wajib untuk WebSocket
    proxy_set_header Connection "upgrade";
    proxy_set_header Host       $host;
    proxy_set_header X-Real-IP  $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
  }
}
```

`trust proxy` sudah aktif di aplikasi, sehingga `express-rate-limit` memakai IP
asli pengunjung, bukan IP proxy.

## Troubleshooting

**Desktop tidak muncul / jendela tidak terbuka.** — buka console browser (F12).
Semua modul frontend adalah ES module; bila ada error import, muat ulang dengan
hard refresh (`Ctrl+Shift+R`).

**Ikon tidak muncul.** — ikon adalah SVG yang digambar sendiri, bukan emoji,
jadi tidak bergantung font apa pun. Kalau kosong, berarti modul
`public/js/icons.js` gagal dimuat; cek console browser.

**Tema tidak tersimpan setelah refresh.** — `localStorage` diblokir (mode
privat/penyaringan). Panel tetap jalan dengan tema bawaan; cek izin penyimpanan
browser.

**Scaling atau blur di layar Retina terasa berlebihan.** — panel ini memakai
`backdrop-filter` hanya di dua permukaan (top bar dan dock) sesuai kuota di
`DESIGN.md`. Kalau GNOME di mesin Anda tidak memakai blur, dua permukaan itu
yang paling mungkin perlu disesuaikan.

**"Terlalu banyak percobaan login."** — rate limit 10 percobaan / 5 menit dari
satu IP. Tunggu, atau restart server (limit disimpan in-memory).

**"Batas N sesi aktif tercapai."** — semua aplikasi memakai satu sesi SSH, jadi
cukup tutup sesi lama lewat tombol **Putuskan** di menubar.

**File Manager tidak bisa membuat folder / menyimpan.** — cek permission di
server. Pesan "Akses ditolak oleh server" berarti kredensial SSH Anda memang
tidak punya hak tulis di lokasi tersebut.

**File besar tidak bisa dibuka di editor.** — batas editor 2 MB. Pakai tombol
**Download**, atau naikkan `MAX_TEXT_BYTES` di `server/lib/sftp.js`.

**Tunnel / reverse proxy memutus WebSocket.** — header `Upgrade` dan
`Connection` harus diteruskan. cloudflared sudah melakukannya, nginx perlu
blok `proxy_set_header` di atas.

**"Passphrase salah untuk private key ini."** — passphrase tidak cocok dengan key
yang terenkripsi. Tekan **Periksa key** untuk memastikan sebelum mencoba connect.

**"Server menolak private key ini."** — public key pasangannya belum ada di
`~/.ssh/authorized_keys` server, atau usernamenya keliru.

**"Koneksi timeout"** — untuk AWS EC2, penyebab paling umum adalah Security
Group yang belum mengizinkan port 22 dari IP Anda.

**"Autentikasi ditolak: username atau password salah."** — kredensial VPS yang
salah, atau user tersebut memang tidak boleh login via password (cek
`PasswordAuthentication yes` di `/etc/ssh/sshd_config` sisi VPS).

**"Koneksi ditolak oleh server".** — port salah atau daemon SSH belum jalan di
VPS tujuan.

**"Host key berubah".** — VPS memang di-reinstall/swap, atau ada orang di tengah
jalur koneksi. Jangan langsung dihapus; pastikan dulu alasannya.

**Terminal kosong / freeze.** — periksa console browser (F12). Bila WS terputus,
panel otomatis mencoba menyambung ulang setiap 3 detik. Shell yang benar-benar
sudah selesai tidak di-reconnect, dan jendela perlu dibuat ulang.

**`EADDRINUSE` saat start.** — port `PORT` sudah dipakai proses lain. Ubah di
`.env` atau hentikan proses yang memakai port tersebut.

## Batasan yang perlu diketahui

Bagian ini sengaja jujur. Ini alat untuk server milik sendiri, bukan
produk bastion/audit untuk tim yang diatur orang lain.

### Autentikasi VPS

- Yang didukung: **password** dan **private key** (RSA, ED25519, termasuk
  yang terenkripsi dengan passphrase). Keduanya pernah diimplementasikan.
- **Ini bukan OpenSSH.** Panel memakai `ssh2`, reimplementasi protokol SSH
  dalam JavaScript. Konsekuensinya nyata dan sebaiknya diketahui sebelum
  dipakai serius:
  - tidak membaca `~/.ssh/config`
  - tidak ada ProxyJump / bastion chaining
  - tidak ada agent forwarding, PKCS#11, atau security key FIDO2
  - dukungan sertifikat host terbatas
  - algoritma yang ditambahkan OpenSSH belakangan tidak otomatis tersedia
- Kalau Anda butuh paritas OpenSSH penuh, pakai `ssh` langsung. Panel ini
  menang di soal tidak perlu memasang apa pun di klien.

### Panel

- **Tidak ada 2FA.** Satu password per akun adalah seluruh lapisan
  autentikasinya. Behind HTTPS, atau batasi aksesnya.
- **Tidak ada HTTPS bawaan.** Panel benar-benar HTTP; TLS diserahkan ke
  reverse proxy.
- Hanya dua peran, `admin` dan `user`. Tidak ada RBAC per-endpoint, tidak
  ada tim yang bisa diberikan izin sebagian.
- **Jejak audit in-memory**: maks 300 entri, hilang saat restart, tidak
  ada jejak yang bisa dikirim ke server terpisah.
- **Tidak ada rekaman sesi terminal.** Kalau audit untuk kepatuhan
  dibutuhkan, panel ini bukan alatnya.
- **Proksi web tidak memverifikasi sertifikat HTTPS target** dan tidak
  menegakkan CSP situs tujuan. Alasannya ada di bagian
  [Proksi web lewat SSH](#proksi-web-lewat-ssh); ringkasnya: keduanya
  diperlukan supaya halaman internal bisa tampil di iframe, dan keduanya
  berarti panel lebih permissif daripada situs aslinya.

### Server

- Statistik, `ps`, `df`, dan `du` diambil lewat utilitas Linux, jadi
  **hanya untuk Linux**. Di server non-Linux nilainya akan kosong atau nol.
- **Penghapusan folder memakai `rm -rf`**, bukan SFTP rekursif. Path-nya sudah
  dinormalisasi dan dibatasi `FS_ROOT`, tapi ini tetap lebih berisiko daripada
  SFTP murni.
- xterm.js dan addon-nya disajikan dari `node_modules` (tanpa CDN), jadi panel
  tetap berfungsi di server tanpa akses internet keluar.

### Penyimpanan

- **Sesi login bertahan lintas restart** (`data/sessions.json`, mode 0600).
  Sesi **SSH tidak**: restart memutus semua koneksi ke VPS dan harus dibuat
  ulang. Ini disengaja — menyimpan kredensial atau state shell agar bisa
  di-*resume* setelah restart berarti menyimpan rahasia yang belum terpecahkan.
- **Tidak pernah diaudit**, satu maintainer, belum ada proses CVE. Perlakukan
  sesuai ukumnya.

### Yang belum ada

Tidak ada virtual workspace (GNOME punya 1/2/3), tidak ada beberapa VPS
sekaligus di satu layar (sesi dipilih satu per satu), dan tidak ada pencarian
aplikasi di luar app grid.
