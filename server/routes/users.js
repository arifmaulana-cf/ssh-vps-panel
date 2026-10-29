'use strict';

const express = require('express');
const rateLimit = require('express-rate-limit');
const users = require('../lib/user-store');
const sessions = require('../lib/sessions');
const audit = require('../lib/audit');
const { getStore } = require('../lib/session-store');
const { requireAuth, requireAdmin } = require('../middleware/auth');

const router = express.Router();

/**
 * Semua route di file ini admin-only. requireAdmin membandingkan
 * req.session.role, dan nilainya hanya bisa diisi server saat login, jadi
 * tidak ada jalan bagi user biasa untuk menandainya sendiri sebagai admin.
 */
router.use(requireAuth, requireAdmin);

/**
 * Mutasi user lebih sensitif daripada request biasa: satu bug di sini bisa
 * mengunci semua orang. Batasnya dibuat lebih ketat daripada limiter global.
 */
const mutationLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 30,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Terlalu banyak perubahan user. Tunggu sebentar.' },
});

/**
 * Identitas pelaku dari req.session.
 *
 * `role` ikut dibawa karena user-store memeriksanya di setiap mutasi.ISI ini
 * bukan sumber kebenaran tepercaya: nilainya berasal dari cookie yang bisa
 * menua, jadi operasi yang mengubah peran (menurunkan admin ke user biasa)
 * tetap memotong semua sesinya.
 */
const actorOf = (req) => ({
  id: req.session.userId,
  username: req.session.username,
  role: req.session.role,
});

/**
 * Matikan seluruh sesi web milik seorang user.
 *
 * Dipakai dua kali: saat akun dinonaktifkan/dihapus, dan saat admin memaksa
 * logout. Sesi SSH miliknya ikut diputus, karena kalau tidak koneksi ke VPS
 * milik orang itu akan tetap hidup meski akunnya sudah tidak berlaku.
 */
function revokeUserSessions(userId) {
  const web = getStore().destroyWhere((s) => s?.userId === userId);
  const ssh = sessions.destroyByUser(userId);
  return { web, ssh };
}

// ================================================================ daftar
/**
 * Satu panggilan untuk seluruh kebutuhan dasbor admin: daftar akun,
 * jumlahnya, dan aktivitas tiap orang. Memisahkannya jadi tiga endpoint
 * hanya menambah.round-trip tanpa menambah keamanan.
 */
router.get('/', (req, res) => {
  const list = users.list();
  const sshCounts = sessions.countByUserIds(list.map((u) => u.id));

  res.json({
    users: list.map((u) => ({ ...u, liveSessions: sshCounts.get(u.id) || 0 })),
    summary: users.summary(),
    sessionCap: sessions.MAX_PER_USER,
  });
});

// =============================================================== membuat
router.post('/', mutationLimiter, (req, res) => {
  const { username, password, role } = req.body || {};

  try {
    const created = users.create(
      { username, password, role: role === 'admin' ? 'admin' : 'user' },
      actorOf(req),
    );
    audit.record('user.create', created.username, undefined, actorOf(req));
    return res.status(201).json({ user: { ...created, liveSessions: 0 } });
  } catch (err) {
    return res.status(err.status || 400).json({ error: err.message });
  }
});

// ===================================================== status & peran
router.patch('/:id', mutationLimiter, (req, res) => {
  const { id } = req.params;
  const body = req.body || {};
  const actor = actorOf(req);

  try {
    let updated;
    let revoked = null;

    // Dua perubahan diterapkan berurutan, dan setDisabled/setRole sudah
    // menolak perubahan yang tidak sah lebih dulu, jadi tidak ada keadaan
    // setengah jadi di tengah jalan.
    if (typeof body.disabled === 'boolean') {
      updated = users.setDisabled(id, body.disabled, actor);
      if (body.disabled) revoked = revokeUserSessions(id);
    }
    if (typeof body.role === 'string') {
      updated = users.setRole(id, body.role, actor);
      // Peran turun dari admin ke user: sesi lamanya harus mati supaya tidak
      // ada token lama yang masih memegang hak admin.
      if (updated.role !== 'admin') revoked = revokeUserSessions(id);
    }

    if (!updated) {
      return res.status(400).json({ error: 'Tidak ada perubahan yang diminta.' });
    }

    audit.record('user.update', updated.username, undefined, actor);
    return res.json({ user: updated, revoked });
  } catch (err) {
    return res.status(err.status || 400).json({ error: err.message });
  }
});

// ======================================================== ganti password
router.put('/:id/password', mutationLimiter, (req, res) => {
  const { id } = req.params;

  try {
    const updated = users.changePassword(id, req.body?.password, actorOf(req));
    const revoked = revokeUserSessions(id);
    audit.record('user.password', updated.username, undefined, actorOf(req));
    return res.json({ user: updated, revoked });
  } catch (err) {
    return res.status(err.status || 400).json({ error: err.message });
  }
});

// ================================================================ hapus
router.delete('/:id', mutationLimiter, (req, res) => {
  const { id } = req.params;
  const actor = actorOf(req);

  try {
    const removed = users.remove(id, actor);
    const revoked = revokeUserSessions(id);
    audit.record('user.delete', removed.username, undefined, actor);
    return res.json({ ok: true, removed, revoked });
  } catch (err) {
    return res.status(err.status || 400).json({ error: err.message });
  }
});

// ================================================== paksa logout satu user
router.post('/:id/revoke', mutationLimiter, (req, res) => {
  const target = users.findById(req.params.id);
  if (!target) return res.status(404).json({ error: 'User tidak ditemukan.' });

  const revoked = revokeUserSessions(target.id);
  audit.record('user.revoke', target.username, undefined, actorOf(req));
  return res.json({ ok: true, revoked });
});

module.exports = router;