'use strict';

const express = require('express');
const rateLimit = require('express-rate-limit');
const users = require('../lib/user-store');
const { getStore } = require('../lib/session-store');
const { verifyCredentials, sessionUser, clientUser, requireAuth } = require('../middleware/auth');

const router = express.Router();

/**
 * Pembatas login, tiga lapis dengan tugas yang berbeda.
 *
 * Limiter 10 permintaan / 5 menit per IP yang lama hanya masuk akal saat panel
 * ini dipakai satu orang. Begitu dipakai tim, orang-orang yang berbagi satu
 * IP (kantor, kampus, operator seluler) saling mengunci: sepuluh orang yang
 * login sah sudah cukup untuk membuat orang ke-sembilan gagal tanpa sebab.
 *
 * Jadi batas IP dinaikkan, dan tugas tiap lapis dikembalikan ke tempat yang
 * tepat sasaran:
 *
 *   1. per-IP, batas tinggi  - menahan penypray bervolume dari satu mesin,
 *                              dan tetap menyisakan ruang untuk satu tim
 *                              yang berbagi alamat.
 *   2. per-(IP + username)  - menahan tebak-terus-terusan satu akun dari satu
 *                              mesin, tanpa menyentuh akun lain di IP itu.
 *   3. per-username (di bawah, tanpa IP) - menahan tebakan tersebar dari
 *                              banyak mesin ke satu akun.
 *
 * Lapis 3 adalah yang paling penting untuk keamanan; lapis 1 hanyalah
 * pelengkap yang menahan penypray yang menyisir banyak username sekaligus.
 */
const LOGIN_WINDOW_MS = 5 * 60 * 1000;

const byIp = rateLimit({
  windowMs: LOGIN_WINDOW_MS,
  limit: 40,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Terlalu banyak percobaan login dari alamat ini. Coba lagi dalam 5 menit.' },
});

const byIpAndUser = rateLimit({
  windowMs: LOGIN_WINDOW_MS,
  limit: 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  // Kunci hitungan menggabungkan IP dan username. express-rate-limit
  // memperingatkan soal keyGenerator kustom pada IPv6; peringatan itu tidak
  // relevan di sini karena hasilnya hanya kunci Map, bukan identitas yang
  // perlu dianotasi atau di-hash.
  keyGenerator: (req) => `${req.ip}:${String(req.body?.username || '').trim().toLowerCase()}`,
  message: { error: 'Terlalu banyak percobaan untuk username ini dari alamat ini. Coba lagi dalam 5 menit.' },
});

/**
 * Limiter khusus ganti password.
 *
 * Ditempelkan limiter login di sini pernah jadi bug: limiter itu ikut menghitung
 * POST login yang sah, sehingga setelah beberapa kali login dari satu IP,
 * penggantian password ikut terkunci padahal tidak ada yang menebak apa pun.
 * Yang perlu dibatasi di route ini hanya menebak password LAMA, jadi
 * kuncinya user + IP.
 */
const passwordChangeLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 8,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: (req) => `${req.ip}:${req.session?.userId || 'anon'}`,
  message: { error: 'Terlalu banyak percobaan ganti password. Coba lagi dalam 15 menit.' },
});

const loginLimiter = [byIp, byIpAndUser];

const PER_USER_WINDOW_MS = 10 * 60 * 1000;
const PER_USER_LIMIT = 8;
const perUserAttempts = new Map();

function perUserBlocked(username) {
  const key = String(username || '').trim().toLowerCase();
  if (!key) return false;

  const entry = perUserAttempts.get(key);
  if (!entry || Date.now() - entry.first > PER_USER_WINDOW_MS) return false;
  return entry.count >= PER_USER_LIMIT;
}

function noteFailure(username) {
  const key = String(username || '').trim().toLowerCase();
  if (!key) return;

  const entry = perUserAttempts.get(key);
  if (!entry || Date.now() - entry.first > PER_USER_WINDOW_MS) {
    perUserAttempts.set(key, { first: Date.now(), count: 1 });
    return;
  }
  entry.count += 1;
}

/** Pembersih, supaya Map tidak tumbuh tanpa batas dari username sembarangan. */
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of perUserAttempts) {
    if (now - entry.first > PER_USER_WINDOW_MS) perUserAttempts.delete(key);
  }
}, 60_000).unref();

/**
 * Catat percobaan login.
 *
 * Sebelumnya TIDAK ADA satu baris pun untuk login - sukses maupun gagal. Saat
 * user melaporkan "tidak bisa login", log tidak punya apa pun untuk dibaca, dan
 * saya bahkan tidak bisa memastikan apakah permintaannya sampai ke server.
 * Itu lubang pengamatan yang sama seperti yang saya temukan di proksi.
 *
 * Yang dicatat: hasil, alasan, dan IP. Password maupun isinya TIDAK pernah.
 */
function logAuth(req, result, detail = '') {
  const who = String(req.body?.username || '(kosong)').slice(0, 40);
  console.log(`[auth] ${result.padEnd(14)} ${who}  ip=${req.ip}${detail ? `  | ${detail}` : ''}`);
}

router.post('/login', loginLimiter, (req, res) => {
  const { username, password } = req.body || {};

  if (perUserBlocked(username)) {
    logAuth(req, 'DITOLAK', 'kena limiter per-username');
    return res.status(429).json({
      error: 'Terlalu banyak percobaan untuk username ini. Coba lagi dalam 10 menit.',
    });
  }

  const user = verifyCredentials(username, password);

  if (!user) {
    noteFailure(username);
    // Pesan sama untuk username tidak dikenal maupun password salah, supaya
    // tidak bisa dipakai memetakan user mana yang terdaftar.
    logAuth(req, 'GAGAL', 'kredensial tidak cocok');
    return res.status(401).json({ error: 'Username atau password salah.' });
  }

  // Tidak ada cabang "akun dinonaktifkan" di sini: verifyCredentials sudah
  // mengembalikan null untuk user.disabled, jadi cabang seperti itu tidak akan
  // pernah dieksekusi - kode mati yang menyesatkan.
  logAuth(req, 'BERHASIL', `peran=${user.role}`);
  perUserAttempts.delete(String(username).trim().toLowerCase());

  // regenerate() membuang id sesi lama sebelum memberi yang baru, supaya id
  // yang sempat bocor tidak bisa dipakai ulang (session fixation).
  return req.session.regenerate((err) => {
    if (err) return res.status(500).json({ error: 'Gagal membuat sesi.' });

    Object.assign(req.session, sessionUser(user), {
      authenticated: true,
      loginAt: Date.now(),
    });

    return res.json({ ok: true, user: clientUser(user) });
  });
});

router.get('/session', (req, res) => {
  if (!req.session?.authenticated) {
    return res.json({ authenticated: false, user: null });
  }
  return res.json({
    authenticated: true,
    user: {
      id: req.session.userId,
      username: req.session.username,
      role: req.session.role,
    },
    loginAt: req.session.loginAt || null,
  });
});

/**
 * Ganti password sendiri.
 *
 * Setelah berhasil, SEMUA sesi milik user itu dimatikan, termasuk yang sedang
 * dipakai. Ini disengaja: kalau ada cookie lama yang sudah dicuri, ia harus
 * ikut mati, dan memaksa login ulang satu kali jauh lebih murah daripada
 * membaca "~password lama masih berlaku di perangkat lain".
 */
/**
 * Laporan error dari sisi peramban.
 *
 * Kegagalan JavaScript di klien sebelumnya buta sama sekali: login bisa
 * mengembalikan 200, semua endpoint berikutnya 200, dan halamannya tetap
 * diam - tidak ada jejak di server dan tidak ada pesan di layar. Satu-satunya
 * cara memastikan adalah meminta user membuka F12, yang tidak selalu bisa.
 *
 * Endpoint ini membuat kegagalan itu terlihat di log. Isinya dipotong dan
 * dibersihkan: yang berguna adalah pesan dan lokasi kesalahannya, bukan
 * seluruh halaman.
 *
 * Tidak butuh auth, karena error bisa terjadi SEBELUM login berhasil. Itu juga
 * sebabnya isinya tidak pernah dipakai sebagai keputusan keamanan - hanya
 * dicatat.
 */
/**
 * Penanda tahap boot dari peramban.
 *
 * Memberi jawaban untuk "login sudah 200 tapi layarnya tidak berubah" tanpa
 * harus meminta user membuka F12: kita lihat sendiri tahap mana yang sudah
 * dilewati dan mana yang berhenti.
 */
router.post('/client-event', (req, res) => {
  const phase = String(req.body?.phase || '?').slice(0, 40);
  const detail = String(req.body?.detail || '').slice(0, 120);
  console.log(`[tahap] ${phase.padEnd(22)} ip=${req.ip}${detail ? `  | ${detail}` : ''}`);
  return res.status(204).end();
});

router.post('/client-error', (req, res) => {
  const body = req.body || {};
  const where = String(body.where || '').slice(0, 120);
  const message = String(body.message || '(tanpa pesan)').slice(0, 300);
  const stack = String(body.stack || '').split('\n').slice(0, 4)
    .map((line) => line.trim().slice(0, 120)).join(' <- ');

  console.log(`[client] ${where || '(tanpa lokasi)'}  ip=${req.ip}`);
  console.log(`[client]   ${message}`);
  if (stack) console.log(`[client]   ${stack}`);

  // 204: pelapor tidak butuh jawaban, dan tidak boleh gagal sendiri.
  return res.status(204).end();
});

router.post('/password', requireAuth, passwordChangeLimiter, (req, res) => {
  const { currentPassword, newPassword } = req.body || {};

  try {
    users.changeOwnPassword(req.session.userId, currentPassword, newPassword);
  } catch (err) {
    return res.status(err.status || 400).json({ error: err.message });
  }

  const store = getStore();
  store.destroyWhere((s) => s?.userId === req.session.userId);
  store.flushNow();

  // Sesi browser ini ikut dihapus dari store, jadi cookie sekarang sudah mati
  // walau browser masih memegangnya.
  return res.json({ ok: true, relogin: true });
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

module.exports = router;