'use strict';

const express = require('express');
const session = require('express-session');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');

const config = require('./config');
const authRoutes = require('./routes/auth');
const sshRoutes = require('./routes/ssh');
const userRoutes = require('./routes/users');
const proxyRoutes = require('./routes/proxy');
const users = require('./lib/user-store');
const { getStore } = require('./lib/session-store');

// Admin dari .env dipromosikan jadi akun di store kalau ini proses pertama
// kali jalan. Setelah itu store adalah satu-satunya sumber kebenaran, jadi
// perubahan password lewat UI tidak ditimpa kembali oleh nilai .env.
const migrated = users.migrateEnvAdmin();
if (migrated) {
  console.log(`  user store: "${migrated.username}" dimigrasikan dari .env`);
}

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');

app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'", 'ws:', 'wss:'],
        fontSrc: ["'self'", 'data:'],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
      },
    },
    crossOriginEmbedderPolicy: false,
  }),
);

app.use(express.json({ limit: '16kb' }));

// Store dibuat eksplisit (bukan default MemoryStore express-session) supaya
// handshake websocket bisa memverifikasi cookie sesi tanpa memakai
// middleware Express penuh.
//
// Dipakai yang berbasis berkas, bukan MemoryStore: dengan banyak pengguna,
// restart server akan memutus semua orang yang sedang mengetik di terminal
// mereka.
const sessionStore = getStore();
app.set('sessionStore', sessionStore);

app.use(
  session({
    name: 'panel.sid',
    secret: config.SESSION_SECRET,
    store: sessionStore,
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: {
      httpOnly: true,
      sameSite: 'strict',
      secure: !!process.env.FORCE_SECURE_COOKIE,
      maxAge: config.SESSION_TTL_MINUTES * 60 * 1000,
    },
  }),
);

app.use('/api', rateLimit({ windowMs: 60 * 1000, limit: 600, standardHeaders: 'draft-7', legacyHeaders: false }));

/**
 * Catat setiap panggilan /api yang gagal atau tidak wajar.
 *
 * Tanpa ini, "user tidak bisa login" tidak dapat dibedakan dari "permintaannya
 * tidak pernah sampai": keduanya sama-sama tidak meninggalkan apa pun di log.
 * Yang terjadi nyata: user melaporkan tidak bisa login sementara panel mencatat
 * nol permintaan - jadi tidak jelas apakah masalahnya di sisi mereka, di
 * jaringan, atau di server.
 *
 * Yang dicatat hanya yang anomali: status >= 400, dan endpoint bermuatan kata
 * 'login'. Request yang berhasil dan wajar tidak dicatat, supaya log tetap
 * terbaca dan tidak jadi kabut.
 */
app.use('/api', (req, res, next) => {
  const started = Date.now();
  res.on('finish', () => {
    const status = res.statusCode;
    const suspect = String(req.originalUrl).includes('login') || status >= 400;
    if (!suspect) return;
    const who = req.session?.username
      || (req.body && typeof req.body.username === 'string' ? req.body.username : null)
      || '-';
    console.log(`[api] ${String(req.method).padEnd(4)} ${status} ${who.padEnd(14)} `
      + `${req.originalUrl.slice(0, 72)}  ${Date.now() - started}ms  ip=${req.ip}`);
  });
  return next();
});

app.use('/api/auth', authRoutes);
app.use('/api/ssh', sshRoutes);
app.use('/api/users', userRoutes);
app.use('/api/proxy', proxyRoutes);

// 413 dari body-parser juga bisa menyertakan potongan body, jadi pesannya
// diganti dengan yang generik agar tidak ada materi request ikut ke log.
app.use((err, req, res, next) => {
  if (err?.type !== 'entity.too.large') return next(err);
  return res.status(413).json({ error: 'Permintaan terlalu besar untuk server ini.' });
});

/**
 * Health check.
 *
 * Endpoint ini juga dipakai sebagai TES JARINGAN: kalau panel bisa dijangkau
 * tapi satu pun request tidak pernah masuk dari IP orang yang seharusnya,
 * masalahnya ada di antara peramban dan server - bukan di panel.
 *
 * Karena itu alamat/IP ALWAYS dicatat di sini, dan biasanya sangat sepi.
 */
/**
 * Catat pemuatan DOKUMEN (bukan aset).
 *
 * Access log hanya menutup /api, jadi "halaman sudahDimuat atau belum" tidak
 * pernah terlihat - padahal itu justru yang perlu diketahui ketika user
 * melaporkan "stuck di halaman login". Aset (js/css/gambar) sengaja tidak
 * dicatat agar log tetap terbaca.
 */
app.use((req, res, next) => {
  if (req.method === 'GET' && !req.path.startsWith('/api')
      && !req.path.startsWith('/js/') && !req.path.startsWith('/css/')
      && !req.path.startsWith('/vendor/') && !req.path.startsWith('/icons/')) {
    console.log(`[page] ${req.path.slice(0, 40).padEnd(22)} ip=${req.ip}  `
      + `ua=${String(req.headers['user-agent'] || '?').slice(0, 45)}`);
  }
  return next();
});

app.get('/api/health', (req, res) => {
  const mark = req.query.cek ? `  cek=${String(req.query.cek).slice(0, 30)}` : '';
  console.log(`[health] ip=${req.ip}  ua=${String(req.headers['user-agent'] || '?').slice(0, 60)}${mark}`);
  return res.json({ ok: true, uptime: process.uptime(), serverTime: new Date().toISOString() });
});

// Aset xterm.js disajikan langsung dari node_modules (bundel lokal, tanpa
// CDN). Versinya terkunci di package-lock, jadi aman diberi cache panjang.
const vendor = path.join(config.ROOT, 'node_modules/@xterm');
app.use('/vendor/xterm/lib', express.static(path.join(vendor, 'xterm/lib'), { maxAge: '30d', immutable: true }));
app.use('/vendor/xterm/css', express.static(path.join(vendor, 'xterm/css'), { maxAge: '30d', immutable: true }));
app.use('/vendor/xterm-addon-fit', express.static(path.join(vendor, 'addon-fit/lib'), { maxAge: '30d', immutable: true }));

// File aplikasi sendiri sering berubah saat pengembangan, jadi hanya pakai
// ETag (revalidasi 304) tanpa maxAge agar browser tidak menyimpan versi lama.
app.use(express.static(config.PUBLIC_DIR, { extensions: ['html'], etag: true, lastModified: true, maxAge: 0 }));

app.use('/api', (req, res) => res.status(404).json({ error: 'Endpoint tidak ditemukan.' }));
app.use((req, res) => res.sendFile(path.join(config.PUBLIC_DIR, 'index.html')));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  const status = err.status || 500;

  // body-parser menyertakan potongan body yang gagal di-parse ke dalam pesan
  // errornya. Kalau body itu berisi private key, pesan tersebut akan bocor
  // ke log server.
  //
  // Penyaratnya harus spesifik ke `type` milik body-parser, BUKAN status 400:
  // SshError dari validasi input juga memakai status 400, dan pesan aslinya
  // justru yang berguna untuk ditampilkan ke pengguna.
  const fromParser = typeof err?.type === 'string' && err.type.startsWith('entity.');
  const message = fromParser
    ? 'Body permintaan tidak valid atau melebihi batas ukuran.'
    : (err.message || 'Terjadi kesalahan pada server.');

  if (status >= 500) console.error('[error]', err);
  res.status(status).json({ error: message });
});

module.exports = app;
module.exports.migrated = migrated;
module.exports.userStore = users;
