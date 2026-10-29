# DESIGN.md — Arah desain SSH VPS Panel

Dokumen ini adalah sumber kebenaran desain. `antislop.md` adalah filter yang
menegakkan aturan; dokumen ini yang memberi **arah**.

## Identitas

Panel administer server yang seluruhnya ada di browser dan harus terasa seperti
**desktop Ubuntu (GNOME)**: top bar, dock, Activities, dan jendela mengambang.
Bukan dashboard web, bukan panel admin generik. Orang yang terbiasa dengan
panel ini harus merasa sedang mengoperasikan komputer, bukan sedang mengisi
formulir.

**Personality:** alat kerja. Tenang, padat, tidak bergaya. GNOME menghormati pengguna dan tidak perlu memamerkan diri.

**Mood:** tenang dan dapat diandalkan. Tidak mencari sensasi.

## Palet

Aubergine Ubuntu bukan pilihan estetika acak, itu identitas resmi Ubuntu.
Pemakaiannya harus **disiplin**, bukan disebar.

Struktur shell (GNOME) tidak berubah antar tema. Yang berganti hanya **token
warna** — Tampilan boleh berubah, tata letak tidak. Enam belas token
(`--t-base`, `--t-accent`, `--t-text`, dst) ditulis oleh `themes.js` ke
`:root`, dan seluruh stylesheet menurunkannya lewat `color-mix()`. Tidak ada
satu pun hex di luar blok nilai awal.

| Peran | Nilai (tema Ubuntu) | Dipakai untuk |
|---|---|---|
| Identity | `#1b1b1f` → `#242424` | Wallpaper dalam bentuk geometris |
| Surface | `#242424` | Isi jendela |
| Headerbar | `#303030` | Bilah judul jendela |
| Headerbar (tidak aktif) | turunan | Jendela yang tidak terfokus |
| Text | `#deddda` | Teks utama |
| Text redup | `#9a9996` | Label sekunder |
| **Accent** | `#e95420` | Oranye Ubuntu |
| Semaphore | `#4ec9a0` / `#e01b24` / `#f5a623` | State nyata saja |

**Aturan accent:** oranye hanya di tiga tempat: Activities hover, indikator
aplikasi yang jalan di dock, dan hover tombol jendela. Tidak pernah di tombol
aksi, badge, border, atau teks. Kalau oranye ada di mana-mana, ia bukan accent.

### Tema

Sembilan tema, semuanya mengambil palet asli dari proyeknya. Menambah tema
baru berarti menambah satu entri ke `THEMES` di `themes.js`, bukan menulis
ulang CSS.

| Tema | Asal | Terang? | Alasan ada |
|---|---|---|---|
| Ubuntu | GNOME/Ubuntu | gelap | Default. Shell-nya memang Ubuntu, jadi ini yang paling jujur |
| Catppuccin Mocha | paket Catppuccin | gelap | Pastel gelap yang tidak menerik perhatian; enak dipakai berjam-jam |
| Catppuccin Latte | paket Catppuccin | **terang** | Pasangan Mocha untuk ruangan terang |
| Nord | Nord | gelap | Arktik biru-hijau, kontras rendah yang tidak melelahkan |
| Gruvbox Dark | Gruvbox | gelap | Retro hangat; gradasi oranye-krem yang khas |
| Gruvbox Light | Gruvbox | **terang** | Kontras tetap terbaca di bawah sinar matahari langsung |
| Tokyo Night | Tokyo Night | gelap | Biru malam dalam, untuk yang suka kontras lebih rendah |
| Everforest | Everforest | gelap | Hijau lumut, nuansa hutan |
| Rosé Pine | Rosé Pine | gelap | Mawar dan pinus, lembut tanpa jadi tema generik |

**Kenapa ada dua tema terang:** dark mode tanpa alasan adalah keputusan yang
dipaksakan. Dengan tema terang, tema gelap jadi **pilihan**, bukan
kebiasaan — dan panel ini tidak lagi terkunci pada satu jenis ruangan.

**Terminal ikut tema.** Palet 16 warna ANSI diturunkan per tema, jadi mengganti
tema juga mengganti warna shell, bukan cuma kerangka panelnya. Tanpa ini,
sembilan tema akan terasa seperti tidak ada bedanya.

## Tipografi

**UI:** `Ubuntu` → fallback `system-ui`. Bukan Inter/Geist/Space Grotesk,
karena panel ini meniru GNOME dan huruf Ubuntu adalah bagian dari pembacaan itu. Font Ubuntu **tidak** dibundel: panel ini menyajikan sendiri ke klien yang
tidak tentu punya font tersebut, dan metrik layout di sini lebih banyak
bergantung pada ukuran dan jarak daripada warnanya. Memaketkan 40 KB woff2 untuk hostname yang paling sering jatuh ke `system-ui` di semua klien
non-Ubuntu adalah bobot yang tidak dibayar.

**Mono:** `JetBrains Mono` → fallback men system. Dipakai hanya di terminal,
path file, dan kolom angka. Di sini mono bukan gaya, ini memisahkan data dari
antarmuka.

## Bentuk & MATERIAL

### Radius (3 langkah, disengaja)

| Nilai | Untuk |
|---|---|
| `4px` | Tombol kecil, badge status, titik |
| `8px` | Input, kartu, baris menu, isi jendela |
| `12px` | Jendela, dock, sheet modal |

Pill (`999px`) hanya di dua tempat: tab terminal ( bentuknya memang tab)
dan toast (bentuknya memang seperti notifikasi). Bukan default.

### Elevasi (shadow = material di atas workspace)

Hanya empat lapis yang benar-benar melayang:

| Lapis | Shadow |
|---|---|
| Permukaan | tanpa shadow |
| Jendela tidak terfokus | `0 4px 12px rgba(0,0,0,.36)` |
| Jendela terfokus | `0 16px 40px rgba(0,0,0,.52)` + `scale(1.008)` |
| Menu, dock, modal, toast | `0 14px 34px rgba(0,0,0,.55)` |

Tidak ada shadow di dalam jendela. Kartu statistik, baris tabel, tombol, dan
input duduk rata. Kalau semuanya terangkat, tidak ada yang Elevate—dan
elevasi kehilangan artinya.

### Kaca (kuota keras: 2)

Hanya **top bar** dan **dock** yang memakai `backdrop-filter`, karena keduanya
benar-benar melayang di atas konten yang bergerak. Overview memakai scrim
opaque, backdrop memakai scrim opaque. Kalau semua permukaan berkaca, tidak
ada yang maju.

### Glow (kuota keras: 2)

Hanya dua titik status yang bercahaya: `SSH aktif` di top bar dan
`WebSocket tersambung` di tab terminal. Keduanya menandai state nyata. Tidak
ada denyut, tidak ada loop.

## Motif identitas

Sudut 12px yang konsisten + oranye yang sangat sparing + headerbar gelap
dengan judul terpusat + jendela yang membesar 0,8% saat difokuskan. Motifnya adalah **perilaku GNOME**, bukan gambar: jendela yang membesar saat diberi perhatian.

Ikon: garis 16×16, stroke 1.4px, ujung bulat. Digambar sendiri sebagai SVG, **bukan emoji** — bentuk emoji berubah antar platform dan hilang total di klien tanpa font warna, sedangkan panel ini harus tampil sama di mana pun.

## Wallpaper

Aubergine, tapi dalam bentuk **geometris bersudut** seperti wallpaper resmi
Ubuntu, bukan radial glow lembut. Radial glow ungu adalah tanda paling umum
AI generik; bentuk bersudut adalah tanda Ubuntu.

## Dials

```
ENERGY 1 / RHYTHM 1 / MOTION 1
```

**ENERGY 1** — GNOME utilitarian. Tidak ada hero, tidak ada gradient dekoratif, tidak ada badge. Ini alat.

**RHYTHM 1** — seragam, dan itu pilihan sadar. Desktop yang isinya jendela
yang bisa dipindah akan kehilangan strukturnya kalau komposisinya bervariasi.
Semua jendela punya chrome yang sama; yang berubah adalah isinya, dan itu memang fungsinya.

**MOTION 1** — transisi yang menjelaskan, bukan yang denenya movement:
fokus jendela, buka/tutup overview, hover. Tidak ada loop, tidak ada pulse.

## Aturan kredensial

Kredensial adalah hal paling sensitif yang pernah menyentuh panel ini, jadi
aturannya keras dan tidak bisa ditawar:

- **Tidak ada penyimpanan kredensial.** Password maupun private key hanya
  hidup selama satu permintaan lalu dibuang. Tidak ada disk, tidak ada
  `localStorage`, tidak ada vault terenkripsi.
- **Key tidak pernah masuk log.** `audit.record()` memakai whitelist field,
  dan pesan error `body-parser` disanitasi karena bisa memuat potongan body
  yang berisi key.
- **Satu metode per koneksi.** Password dan key tidak pernah dikirim
  bersamaan; kalau keduanya terisi, permintaan ditolak.
- **Validasi sebelum jaringan.** Key dicek format dan passphrase-nya dulu,
  supaya kesalahan tidak muncul sebagai "koneksi gagal" yang tidak berguna.
- **Peringatan jujur di UI.** Halaman unggah key memuat penjelasan bahwa key
  melewati jaringan ke server panel. Menyembunyikan risikonya akan jadi
  kebohongan yang lebih berbahaya.

## Menu bar dan aplikasi shell

### Menubar adalah ciri desktop, bukan hiasan

Panel web hampir selalu berhenti di "jendela di atas peramban". Yang paling
membuat sebuah aplikasi terasa seperti aplikasi desktop justru baris
`Berkas Edit Tampilan Bantuan` di atas - dan itu yang paling sering hilang,
karena butuh arquitetura: aplikasi harus bisa mendaftarkan menu, dan menubar
harus tahu jendela mana yang terfokus.

Tiga aturan yang dipegang:

1. **Tiap butir melakukan sesuatu.** Menu yang ada tapi buta lebih buruk dari
   menu yang jujur tidak ada. Gate check membaca setiap `ctx.setMenus()` dan
   mencari nama fungsi yang dipanggil tapi tidak dideklarasikan.
2. **Urutan: menu aplikasi dulu, baru bawaan.** Menu bawaan ("Berkas" dan
   "Bantuan") diletakkan setelah menu milik aplikasi, supaya tidak ada dua
   judul "Berkas" dan judul tidak pernah dimulai dengan "Bantuan".
3. **Menu bawaan hanya diisi kalau aplikasinya tidak punya.** Kalau selalu
   ditambahkan, setiap aplikasi yang punya "Berkas" sendiri berakhir dengan dua
   judul "Berkas" dengan isi berbeda - sangat membingungkan.

### Fokus punya jalur notifikasi sendiri

Berpindah fokus tidak memanggil `onChange`. `onChange` berarti "daftar jendela
berubah" dan dipakai dock; membangun ulang seluruh isi dock setiap kali user
klik jendela terasa berat dan tidak perlu. `onFocusChange` khusus untuk
menubar.

### Aplikasi shell tidak masuk dock

Pengaturan dan Pengguna tidak muncul di dock, sama seperti Settings di Ubuntu.
Konsekuensinya: `allApps()` (untuk app grid) harus memuat semuanya, sedangkan
`visibleApps()` (untuk dock) tidak. Kalau keduanya disamakan, Settings tidak
akan pernah bisa dicari.

### Menu Ubuntu yang tidak ada, dan kenapa

Lihat tabel di README. Ringkasnya: Suspend/Restart/Matikan adalah perintah
untuk mesin pengguna, bukan untuk panel; Kunci Layar milik peramban; Switch
User butuh dua sesi desktop. Meniru Ubuntu tanpa batas akan membuat panel
terlihat lebih lengkap dari kenyataannya, dan itu berbahaya kalau panel ini
dibagikan ke komunitas.

## Proksi web lewat SSH

Untuk membuka Jenkins atau ArgoCD tanpa tunnel. Yang membuatnya mungkin bukan
SSH, melainkan satu keputusan arsitektur: **panel tidak membuka port listener
tambahan sama sekali.** Semuanya lewat channel `direct-tcpip` yang memang sudah
milik ssh2 - fondasi yang sama dengan `ssh -L`, hanya tanpa bentuknya.

### Batas yang mengikat desain, bukan sekadar fitur

- **Satu request = satu channel.** Sistem target punya `MaxSessions` sendiri,
  jadi channel yang lebih murah berarti pemeriksaan yang lebih sering. Yang
  dipilih: satu channel per request, ditutup lagi setelah selesai.
- **Ada batas channel per sesi** (`MAX_CHANNELS`) plus sweep untuk channel
  yang menggantung. Tanpa itu, satu iframe yang gagal bisa menghabiskan kuota
  channel di server tujuan.
- **Tidak ada listener TCP.** Ini yang membuat fitur ini aman untuk dipakai di
  panel yang diekspos lewat reverse proxy atau tunnel.

### Dua keputusan yang harus diambil secara sadar

**Sandbox iframe tanpa `allow-same-origin`.** Halaman tujuan disajikan pada asal
panel sendiri; dengan `allow-same-origin`, JavaScript di dalamnya bisa membaca
localStorage dan memanggil `/api/*` dengan sesi pengguna. Untuk situs internal
yang kebetulan punya XSS, itu berarti seluruh akun panel ikut hilang. Asal
buram dipilih; cookies target tetap terkirim.

**TLS tanpa verifikasi sertifikat.** Sertifikat di jaringan internal sering
ditandatangani sendiri. Menegakkannya akan membuat fitur ini tidak berguna
persis untuk kasus yang menjadi alasan fitur ini dibuat. Risiko yang tersisa
dinyatakan terbuka di README, bukan disembunyikan.

### Yang tidak ditegakkan

CSP milik situs tujuan dibuang supaya halaman bisa tampil, dan CSP panel sendiri
diganti (default-nya `frame-ancestors 'none'` yang akan membuat hasil proksi
tidak pernah bisa tampil di iframe sama sekali). Konsekuensinya: panel lebih
permissif daripada situs aslinya. Yang membatasi kebocoran bukan header itu,
melainkan sandbox.

## Split screen

Permintaan eksplisit: "jendela mengambang bisa di-split layar seperti di
Windows". GNOME sendiri tidak punya ini tanpa ekstensi, jadi ini satu-satunya
tempat panel ini sengaja menyimpang dari identitas GNOME-nya.

Yang diambil dari Windows: Aero Snap (seret ke tepi), snap ke pojok
(kuarters), snap layout di tombol Perbesar, dan pembagi yang bisa digeser.
Yang dipertahankan: cara kerjakan jendela GNOME - header, snapping 8 arah,
Activities, dock.

### Kenapa grid ternormalisasi, bukan piksel

Layout disimpan sebagai batas dalam fraksi (`cuts.x = [0.5]`), dan jendela
menyimpan petak (`{c, r, cs, rs}`). Alasannya praktis: membuka jendela baru,
menutup jendela, atau mengubah ukuran browser tidak memaksa menghitung ulang
seluruh posisi. Windows melakukan hal yang sama secara internal.

`cs`/`rs` diperlukan karena "kiri" bukan satu petak melainkan satu kolom dan
semua baris - tanpa itu, snap ke kiri pada layout 2x2 hanya akan mengisi
kuarters kiri atas.

### Jendela bertiles kehilangan bayangan

Windows menghilangkan bayangan jendela yang sudah di-*tile*: ia menempel di grid,
bukan melayang di atasnya. Sudut membulat tetap dipertahankan supaya tidak
berputus dari sisa panel, dan jendela terfokus diberi garis aksen supaya batas
petaknya tetap terbaca ketika lebih dari dua jendela mengisi layar.

### Handle resize dimatikan, bukan disembunyikan saja

Ukuran jendela bertiles milik grid. `display: none` sudah cukup untuk
mencegah tarikan mouse, tapi aturan itu diperiksa lagi di WM: satu jalur yang
lolos dari CSS sudah cukup untuk melanggar aturan yang sama.

### Yang tidak diambil dari Windows

- Tidak ada Aero Shake (mengetuk judul untuk maximize yang lain).
- Tidak ada virtual desktop untuk petak; grid hanya satu layar kerja.
- `Super+Bawah` berarti *restore*, bukan separuh bawah, persis seperti
  Windows. Separuh bawah tetap ada lewat drag, pojok, klik kanan judul, dan
  snap layout.

## Multi-user

Panel bisa dipakai lebih dari satu orang. Keputusan di bawah diambil supaya
"masing-masing hanya bisa miliknya sendiri" benar secara teknis, bukan
sekadar tampilan.

### Kepemilikan diikat ke userId, bukan username

`userId` dibuat sekali dan tidak pernah berubah. Username bisa diganti atau
dinonaktifkan suatu hari; kalau kepemilikan dipegang lewat string yang bisa
berubah, sesi lama bisa berpindah tangan. Jadi setiap pembanding memakai
`userId`:

```
resolveSession()   -> session.userId !== req.session.userId  -> 403
/ws/term/:id       -> dicek SEBELUM upgrade                    -> 403
audit              -> user biasa hanya melihat entri dirinya
```

### Otorisasi ditegakkan di server

`requireAdmin` membandingkan `req.session.role`. Menyembunyikan tombol dari UI
bukan tindakan keamanan: siapa pun yang bisa memanggil endpoint secara
langsung tetap akan ditolak di server. Aturan yang dipegang: **tombol
disembunyikan demi kejelasan, bukan demi keamanan.**

### Status akun selalu dicek ulang dari store

Nilai `role` di dalam sesi berasal dari cookie yang berumur panjang. Cookie
bertahan berjam-jam setelah seseorang dinonaktifkan atau diturunkan perannya,
jadi handshake WebSocket membaca ulang status dari `users.json` sebelum
mengizinkan koneksi. Untuk HTTP, setiap operasi yang menurunkan peran sudah
memotong seluruh sesi user itu.

### Mematikan akun memutus segalanya

Nonaktifkan, hapus, ganti password, atau paksa logout: semuanya mencabut sesi
web **dan** koneksi SSH milik orang itu. Kalau hanya sesi web yang mati,
koneksi SSH milik orang yang sudah tidak berhak akan tetap hidup sampai
timeout. Jumlah yang diputus dilaporkan balik ke admin, supaya "akun
dinonaktifkan" tidak menjadi informasi setengah jadi.

### Batas login dibuat berlapis

Ketika panel ini dipakai satu orang, batas 10 percobaan login per 5 menit
masuk akal. Begitu dipakai tim, orang-orang yang berbagi satu IP (kantor,
kampus, operator seluler) saling mengunci: sepuluh login sah sudah cukup.
Maka batas IP dinaikkan, dan tiap lapis diberi tugas yang berbeda:

| Lapis | Kunci | Batas | Menahan |
|---|---|---|---|
| 1 | IP | 40 / 5 mnt | Penypray bervolume dari satu mesin |
| 2 | IP + username | 10 / 5 mnt | Tebakan satu akun dari satu mesin |
| 3 | username | 8 / 10 mnt | Tebakan satu akun dari banyak mesin |
| - | IP + userId | 8 / 15 mnt | Menebak password LAMA saat ganti password |

Lapis 3 yang paling penting. Lapis 1 hanya pelengkap: batasnya sengaja
tinggi supaya satu tim di balik satu proxy tidak saling mengunci, dan
pembuktiannya ada di tes (`5 user berbeda, 1 gagal masing-masing, lalu
berhasil semua`).

### Message login tidak membocorkan user mana yang ada

Pesan untuk "username tidak dikenal" dan "password salah" sengaja identik.
Verifikasi selalu menjalankan bcrypt, termasuk terhadap hash boneka saat
username tidak ada, sehingga waktu responsnya juga seragam.

### Batas yang disengaja dan belum ada

Hal-hal ini **tidak** ada, dan sebaiknya tidak diklaim sebagai ada:

- **RBAC selain dua peran.** Hanya `admin` dan `user`. Tidak ada izin
  per-endpoint.
- **Audit terpusat dan tahan lama.** Jejak audit in-memory, hilang saat
  restart, maks 300 entri.
- **Rekaman sesi.** Tidak ada penyimpanan rekaman terminal.
- **2FA.** Satu password per akun.
- **Penghapusan akun bertingkat.** Menghapus admin terakhir dicegah, tapi
  "pemulihan akun" (mis. email yang lupa) tidak ada.

## Keputusan yang diambil sadar (catatan filter)

Antislop melarang gradient biru-ungu, radial orb, glass berlebihan, radius
seragam, shadow berlebihan, glow berlebihan, dan emoji. Setiap kali salah satu
muncul di desain ini, keputusannya:

| Larangan | Keputusan di sini |
|---|---|
| Purple-and-black / radial orbs | Aubergine = identitas Ubuntu, tapi bentuknya geometris bersudut, bukan glow. Dipakai. |
| Glass berlebihan | 2 dari 4. Top bar + dock. Dipakai separuh. |
| Emoji sebagai dekorasi | 14 glyph diganti SVG buatan sendiri. Dihapus. |
| Radius seragam | 3 langkah + pill untuk 2 bentuk bermakna. Disederhanakan. |
| Shadow berlebihan | 4 lapis, hanya yang melayang. Diredam. |
| Glow berlebihan | 2, keduanya state nyata. Dipakai. |
| Dark mode tanpa alasan | Alasan ada: ini terminal tool, dipakai berjam-jam, dan mengikuti GNOME yang memang gelap. Tapi dipaksa? Tidak — ada dua tema terang yang bisa dipilih, jadi tema gelap jadi pilihan, bukan kebiasaan. Dipakai. |
| Password-only | Tidak cukup untuk AWS EC2. Private key ditambahkan sebagai metode kedua yang saling meniadakan dengan password, bukan sebagai tambahan opsional. |