'use strict';

const express = require('express');
const rateLimit = require('express-rate-limit');
const ssh = require('../lib/ssh-manager');
const metrics = require('../lib/metrics');
const sessions = require('../lib/sessions');
const sftp = require('../lib/sftp');
const sysinfo = require('../lib/sysinfo');
const audit = require('../lib/audit');
const { safePath, FsError, FS_ROOT } = require('../lib/fs-paths');
const { requireAuth } = require('../middleware/auth');
const { DEFAULT_TAB } = require('../lib/ssh-manager');

const router = express.Router();

// Pembatas koneksi: mencegah panel dipakai memindai jaringan atau jadi relay.
const connectLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 20,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Terlalu banyak percobaan koneksi. Tunggu sebentar.' },
});

/**
 * Aplikasi desktop memukul endpoint file dan sistem cukup sering (System
 * Monitor tiap 10 detik, navigasi folder saat drag & drop). Rate limit generously
 * tapi tetap menjaga supaya tidak berubah jadi proxy.
 */
const desktopLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 600,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Terlalu banyak permintaan. Tunggu sebentar.' },
});

/**
 * Pastikan sesi ada, milik user yang sedang login, dan masih hidup.
 *
 * Pembandingnya userId, bukan username. Sesi SSH yang orang lain buat tidak
 * akan pernah terlihat di sini: id-nya harus diketahui lebih dulu, dan
 * percobaan dengan userId yang berbeda tetap ditolak 403.
 */
function resolveSession(req, res, next) {
  const session = sessions.get(req.params.id);
  if (!session) return res.status(404).json({ error: 'Sesi tidak ditemukan atau sudah berakhir.' });
  if (session.userId !== req.session.userId) return res.status(403).json({ error: 'Akses ditolak.' });
  if (session.closed) return res.status(410).json({ error: 'Koneksi SSH sudah tertutup.' });
  req.sshSession = session;
  return next();
}

/** Batas request; cukup untuk form dan private key (RSA-4096 sekitar 3 KB). */
const JSON_LIMIT = '256kb';

// Route credential punya batas sendiri supaya pesan error yang muncul
// bukan 413 mentah dari body-parser global.
/**
 * Bungkus handler async agar error-nya jadi JSON, bukan unhandled rejection.
 */
const wrap = (handler) => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);

// Body dibaca ulang dengan limit yang lebih longgar hanya untuk dua route
// di bawah. express.json() global tidak bisa diubah per-route, jadi dua ini
// memasang middleware sendiri di depan router global.
const credentialBody = express.json({ limit: JSON_LIMIT });

const publicShape = (s) => ({
  id: s.id,
  host: s.host,
  port: s.port,
  username: s.remoteUser,
  createdAt: s.createdAt,
  fsRoot: FS_ROOT,
  // Metode autentikasi ikut ditampilkan supaya pengguna tahu sesi ini
  // sedang pakai key. Materi key-nya sendiri tidak pernah ada di sini.
  authMethod: s.authMethod || 'password',
  // Direktori home remote; dipakai File Manager sebagai titik awal.
  home: s.home || FS_ROOT,
});

// ================================================================== sesi
router.get('/sessions', requireAuth, (req, res) => {
  res.json({ sessions: sessions.listByUser(req.session.userId).map(publicShape) });
});

// Tidak ada outbound traffic di route ini: hanya mem-parse key, jadi
// kesalahan passphrase ketahuan tanpa harus menunggu koneksi gagal.
router.post('/validate-key', requireAuth, desktopLimiter, credentialBody, wrap(async (req, res) => {
  res.json(ssh.validateKey(req.body));
}));

router.post('/connect', requireAuth, connectLimiter, credentialBody, wrap(async (req, res) => {
  const actor = { id: req.session.userId, username: req.session.username };
  const session = await ssh.createSession(req.body, actor);
  // Yang dicatat hanya metode, tujuannya, dan siapa yang melakukannya. Materi
  // kredensial tidak pernah sampai ke sini, dan scrubDetail() menjaga agar
  // tidak bisa ikut maupun kalau ada penambahan di masa depan.
  audit.record('session.connect', `${session.remoteUser}@${session.host}:${session.port}`, {
    authMethod: session.authMethod,
  }, actor);
  res.status(201).json({ session: publicShape(session) });
}));

router.post('/disconnect/:id', requireAuth, (req, res) => {
  const session = sessions.get(req.params.id);
  if (session && session.userId !== req.session.userId) {
    return res.status(403).json({ error: 'Akses ditolak.' });
  }
  sessions.destroy(req.params.id);
  audit.record('session.disconnect', session ? `${session.remoteUser}@${session.host}` : req.params.id, {
    authMethod: session?.authMethod,
  }, { id: req.session.userId, username: req.session.username });
  return res.json({ ok: true });
});

// ============================================================== terminal
// Setiap tab = satu channel shell pada koneksi SSH yang sama.
router.post('/tabs/:id', requireAuth, desktopLimiter, resolveSession, wrap(async (req, res) => {
  const tabId = String(req.body?.tabId || '');
  if (!/^[\w-]{1,32}$/.test(tabId)) throw new FsError('Id tab tidak valid.');

  const cols = Number.parseInt(req.body?.cols, 10);
  const rows = Number.parseInt(req.body?.rows, 10);

  await ssh.openTab(req.sshSession, tabId, {
    cols: Number.isInteger(cols) ? cols : 80,
    rows: Number.isInteger(rows) ? rows : 24,
  });
  res.status(201).json({ tabId });
}));

router.delete('/tabs/:id/:tabId', requireAuth, resolveSession, (req, res) => {
  res.json({ ok: ssh.closeTab(req.sshSession, req.params.tabId) });
});

router.post('/resize/:id', requireAuth, resolveSession, (req, res) => {
  const cols = Number.parseInt(req.body?.cols, 10);
  const rows = Number.parseInt(req.body?.rows, 10);
  if (!Number.isInteger(cols) || !Number.isInteger(rows)) {
    return res.status(400).json({ error: 'Ukuran terminal tidak valid.' });
  }

  const tabId = typeof req.body?.tabId === 'string' ? req.body.tabId : DEFAULT_TAB;
  const terminal = req.sshSession.terminals.get(tabId);
  if (!terminal) return res.status(404).json({ error: 'Tab terminal tidak ditemukan.' });

  try {
    terminal.stream.setWindow(rows, cols, 0, 0);
    req.sshSession.lastActivity = Date.now();
  } catch { /* stream mungkin sudah tertutup */ }
  return res.json({ ok: true, cols, rows, tabId });
});

// ========================================================== system monitor
router.get('/metrics/:id', requireAuth, resolveSession, wrap(async (req, res) => {
  const result = await metrics.collect((cmd) => ssh.exec(req.sshSession.client, cmd));
  req.sshSession.lastActivity = Date.now();
  res.json({ ...result, uptimeText: metrics.formatUptime(result.uptimeSeconds) });
}));

router.get('/processes/:id', requireAuth, desktopLimiter, resolveSession, wrap(async (req, res) => {
  const result = await sysinfo.processes(req.sshSession);
  req.sshSession.lastActivity = Date.now();
  res.json(result);
}));

router.get('/diskusage/:id', requireAuth, desktopLimiter, resolveSession, wrap(async (req, res) => {
  const target = typeof req.query.path === 'string' ? req.query.path : '/';
  const result = await sysinfo.diskUsage(req.sshSession, target);
  req.sshSession.lastActivity = Date.now();
  res.json(result);
}));

// ================================================================= file
router.get('/files/:id', requireAuth, desktopLimiter, resolveSession, wrap(async (req, res) => {
  const dir = typeof req.query.path === 'string' ? req.query.path : '/';
  const result = await sftp.list(req.sshSession, dir);
  req.sshSession.lastActivity = Date.now();
  res.json(result);
}));

router.post('/mkdir/:id', requireAuth, desktopLimiter, resolveSession, wrap(async (req, res) => {
  res.json(await sftp.mkdir(req.sshSession, req.body?.path));
}));

router.post('/rename/:id', requireAuth, desktopLimiter, resolveSession, wrap(async (req, res) => {
  res.json(await sftp.rename(req.sshSession, req.body?.from, req.body?.to));
}));

router.delete('/files/:id', requireAuth, desktopLimiter, resolveSession, wrap(async (req, res) => {
  res.json(await sftp.remove(req.sshSession, req.query.path));
}));

// ============================================================ text editor
router.get('/file/:id', requireAuth, desktopLimiter, resolveSession, wrap(async (req, res) => {
  const result = await sftp.readText(req.sshSession, req.query.path);
  req.sshSession.lastActivity = Date.now();
  res.json(result);
}));

router.put('/file/:id', requireAuth, desktopLimiter, resolveSession, wrap(async (req, res) => {
  res.json(await sftp.writeText(req.sshSession, req.body?.path, req.body?.content));
}));

// ================================================================ transfer
// Body dibaca sebagai biner mentah (bukan multipart) supaya tidak perlu
// dependensi tambahan. Nama file dikirim lewat header X-File-Name.
router.post('/upload/:id', requireAuth, desktopLimiter, resolveSession, express.raw({
  type: () => true,
  limit: sftp.MAX_UPLOAD_BYTES,
}), wrap(async (req, res) => {
  const name = req.get('X-File-Name');
  if (!name) throw new FsError('Nama file tidak terkirim.');

  const target = typeof req.query.path === 'string' && req.query.path !== ''
    ? `${req.query.path.replace(/\/+$/, '')}/${name}`
    : name;

  res.json(await sftp.upload(req.sshSession, target, req.body));
}));

router.get('/download/:id', requireAuth, resolveSession, wrap(async (req, res) => {
  await sftp.download(req.sshSession, req.query.path, res);
}));

// ================================================================== audit
// User biasa hanya melihat jejak aksinya sendiri. Admin melihat semuanya.
router.get('/audit', requireAuth, (req, res) => {
  res.json({
    entries: audit.list(Number.parseInt(req.query.limit, 10) || 100, {
      userId: req.session.userId,
      isAdmin: req.session.role === 'admin',
    }),
  });
});

module.exports = router;
module.exports.safePath = safePath;