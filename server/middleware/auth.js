'use strict';

const users = require('../lib/user-store');

/**
 * Verifikasi kredensial lewat user store.
 *
 * user-store sudah menjalankan bcrypt terhadap hash boneka saat username tidak
 * ditemukan, sehingga waktu responsnya seragam dan penyerang tidak bisa
 * menebak user mana yang terdaftar.
 */
function verifyCredentials(username, password) {
  return users.verify(username, password);
}

/**
 * Bentuk user yang disimpan di req.session. Sengaja tanpa passwordHash.
 *
 * Namanya `userId`, bukan `id`, karena objek Session milik express-session
 * sudah punya properti `id` yang hanya-baca; menimpanya akan melempar
 * TypeError dan menggagalkan login.
 */
function sessionUser(user) {
  return { userId: user.id, username: user.username, role: user.role };
}

/**
 * Bentuk user yang dikirim ke klien: `{ id, username, role }`.
 *
 * Dipisah dari sessionUser karena nama field harus berbeda di sisi server dan
 * sisi klien. Kalau keduanya sama, klien akan membandingkan `ctx.me.id` dengan
 * daftar akun yang mengirim `id`, dan perbandingan itu selalu salah tanpa
 * error yang mencolok: lencana "kamu" simplemente tidak pernah muncul.
 */
function clientUser(user) {
  return { id: user.id, username: user.username, role: user.role };
}

function requireAuth(req, res, next) {
  if (req.session?.authenticated) return next();
  return res.status(401).json({ error: 'Belum terautentikasi.' });
}

/**
 * Penjaga admin.
 *
 * Pemeriksaan ini ada di server, bukan sekadar menyembunyikan tombol dari UI.
 */
function requireAdmin(req, res, next) {
  if (!req.session?.authenticated) {
    return res.status(401).json({ error: 'Belum terautentikasi.' });
  }
  if (req.session.role !== 'admin') {
    return res.status(403).json({ error: 'Hanya admin yang boleh.' });
  }
  return next();
}

module.exports = { verifyCredentials, sessionUser, clientUser, requireAuth, requireAdmin };