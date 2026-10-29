'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const config = require('../config');

/**
 * Penyimpanan user berbasis berkas JSON.
 *
 * Dipilih bukan database supaya panel tetap bisa dijalankan tanpa satu pun
 * layanan tambahan. Untuk ribuan user ini memang bukan pilihan tepat; untuk
 * panel admin-tools skala tim kecil, satu berkas yang bisa di-backup dengan
 * `cp` jauh lebih berguna daripada setup Postgres.
 *
 * Password hanya pernah disimpan sebagai hash bcrypt. File ditulis dengan
 * mode 0600 dan secara atomik (tulis sementara lalu rename) supaya tidak
 * pernah tertinggal setengah tertulis.
 */

const FILE = path.join(config.DATA_DIR, 'users.json');
const BCRYPT_ROUNDS = 12;

// Hash boneka: tetap dibandingkan meski username tidak ada, agar waktu
// respons tidak membocorkan user mana yang terdaftar.
const DUMMY_HASH = bcrypt.hashSync('tetap-tidak-ada-akun-ini', BCRYPT_ROUNDS);

const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{2,31}$/;

class UserError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

let users = load();

function load() {
  try {
    const parsed = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    const list = Array.isArray(parsed) ? parsed : parsed?.users;
    if (Array.isArray(list)) {
      // Buang entri yang bentuknya salah supaya satu berkas rusak tidak
      // menjatuhkan seluruh panel.
      return list.filter((u) => u && typeof u.id === 'string' && typeof u.username === 'string');
    }
  } catch { /* belum ada / rusak: mulai dari kosong */ }
  return [];
}

function persist() {
  fs.mkdirSync(config.DATA_DIR, { recursive: true });
  const tmp = `${FILE}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  fs.writeFileSync(tmp, `${JSON.stringify({ users }, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, FILE);
  try { fs.chmodSync(FILE, 0o600); } catch { /* filesystem tidak mendukung */ }
}

/**
 * Admin dari .env dimigrasikan ke store saat pertama kali jalan, supaya ada
 * satu sumber kebenaran. Password .env tetap dipakai sebagai nilai awal,
 * lalu bisa diganti dari UI.
 */
function migrateEnvAdmin() {
  if (users.length || !config.ADMIN_USER || !config.ADMIN_PASS) return null;
  const user = {
    id: crypto.randomUUID(),
    username: config.ADMIN_USER.toLowerCase(),
    passwordHash: bcrypt.hashSync(config.ADMIN_PASS, BCRYPT_ROUNDS),
    role: 'admin',
    disabled: false,
    createdAt: Date.now(),
    createdBy: 'env',
  };
  users.push(user);
  persist();
  return user;
}

const normalize = (username) => String(username || '').trim().toLowerCase();

const publicView = (u) => ({
  id: u.id,
  username: u.username,
  role: u.role,
  disabled: Boolean(u.disabled),
  createdAt: u.createdAt,
  createdBy: u.createdBy || null,
  lastPasswordChange: u.lastPasswordChange || null,
});

function listUsers() {
  return users
    .map(publicView)
    .sort((a, b) => (a.createdAt - b.createdAt));
}

const count = () => users.length;

const findById = (id) => {
  const user = users.find((u) => u.id === id);
  return user ? publicView(user) : null;
};

const findRaw = (username) => users.find((u) => u.username === normalize(username)) || null;

/**
 * Verifikasi kredensial. Selalu menjalankan bcrypt, bahkan untuk username
 * yang tidak ada, agar waktu responsnya tidak membocorkan user mana yang
 * terdaftar. Pesan gagalnya pun seragam.
 */
function verify(username, password) {
  if (typeof username !== 'string' || typeof password !== 'string') return null;

  const user = findRaw(username);
  const ok = bcrypt.compareSync(password, user ? user.passwordHash : DUMMY_HASH);
  if (!user || !ok || user.disabled) return null;

  return publicView(user);
}

/** Jumlah akun aktif per peran, untuk ringkasan di UI admin. */
function summary() {
  const active = users.filter((u) => !u.disabled);
  return {
    total: users.length,
    active: active.length,
    disabled: users.length - active.length,
    admins: users.filter((u) => !u.disabled && u.role === 'admin').length,
  };
}

function validateUsername(username) {
  const name = normalize(username);
  if (!USERNAME_RE.test(name)) {
    throw new UserError('Username harus 3-32 karakter: huruf, angka, titik, strip bawah, atau strip.'); 
  }
  if (findRaw(name)) throw new UserError(`Username "${name}" sudah dipakai.`, 409);
  return name;
}

function validatePassword(password) {
  if (typeof password !== 'string' || password.length < 8) {
    throw new UserError('Password minimal 8 karakter.');
  }
  if (typeof password === 'string' && password.length > 200) {
    throw new UserError('Password terlalu panjang (maks 200 karakter).');
  }
  return password;
}

function createUser({ username, password, role = 'user', createdBy }, actor) {
  if (!actor || actor.role !== 'admin') {
    throw new UserError('Hanya admin yang boleh membuat user.', 403);
  }
  const name = validateUsername(username);
  validatePassword(password);
  if (role !== 'admin' && role !== 'user') throw new UserError('Role tidak dikenal.');

  const user = {
    id: crypto.randomUUID(),
    username: name,
    passwordHash: bcrypt.hashSync(password, BCRYPT_ROUNDS),
    role,
    disabled: false,
    createdAt: Date.now(),
    createdBy: actor.username,
    lastPasswordChange: Date.now(),
  };

  users.push(user);
  persist();
  return publicView(user);
}

function setDisabled(id, disabled, actor) {
  if (!actor || actor.role !== 'admin') throw new UserError('Hanya admin yang boleh.', 403);

  const user = users.find((u) => u.id === id);
  if (!user) throw new UserError('User tidak ditemukan.', 404);
  // Menonaktifkan akun sendiri hampir selalu berarti mengunci diri sendiri
  // keluar tanpa ada jalan masuk lagi. Mengaktifkan kembali tidak masalah,
  // jadi penjaga ini hanya berlaku untuk arah yang menonaktifkan.
  if (user.id === actor.id && disabled) {
    throw new UserError('Tidak bisa menonaktifkan akun sendiri.');
  }
  if (disabled && isLastAdmin(user)) {
    throw new UserError('Tidak bisa menonaktifkan admin terakhir.');
  }

  user.disabled = Boolean(disabled);
  persist();
  return publicView(user);
}

function setRole(id, role, actor) {
  if (!actor || actor.role !== 'admin') throw new UserError('Hanya admin yang boleh.', 403);
  if (role !== 'admin' && role !== 'user') throw new UserError('Role tidak dikenal.');

  const user = users.find((u) => u.id === id);
  if (!user) throw new UserError('User tidak ditemukan.', 404);
  if (user.id === actor.id) throw new UserError('Tidak bisa mengubah peran akun sendiri.');
  if (role !== 'admin' && user.role === 'admin' && isLastAdmin(user)) {
    throw new UserError('Harus ada minimal satu admin.');
  }

  user.role = role;
  persist();
  return publicView(user);
}

/** Inti penggantian password; dipakai dua pintu di bawah. */
function setPassword(user, password) {
  validatePassword(password);
  user.passwordHash = bcrypt.hashSync(password, BCRYPT_ROUNDS);
  user.lastPasswordChange = Date.now();
  persist();
  return publicView(user);
}

/** Admin mengganti password user lain. */
function changePassword(id, password, actor) {
  if (!actor || actor.role !== 'admin') throw new UserError('Hanya admin yang boleh.', 403);

  const user = users.find((u) => u.id === id);
  if (!user) throw new UserError('User tidak ditemukan.', 404);
  return setPassword(user, password);
}

/**
 * Pengguna mengganti password-nya sendiri.
 *
 * Password lama WAJIB dibuktikan lebih dulu. Tanpa itu, siapa pun yang berhasil
 * merebut cookie sesi (XSS, cookie curian) akan bisa mengunci pemilik akun
 * selamanya dengan mengganti password.
 */
function changeOwnPassword(id, currentPassword, newPassword) {
  const user = users.find((u) => u.id === id);
  if (!user) throw new UserError('Akun tidak ditemukan.', 404);
  if (user.disabled) throw new UserError('Akun ini dinonaktifkan.', 403);

  const ok = typeof currentPassword === 'string'
    && bcrypt.compareSync(currentPassword, user.passwordHash);
  if (!ok) throw new UserError('Password saat ini salah.', 401);

  return setPassword(user, newPassword);
}

function remove(id, actor) {
  if (!actor || actor.role !== 'admin') throw new UserError('Hanya admin yang boleh.', 403);

  const index = users.findIndex((u) => u.id === id);
  if (index === -1) throw new UserError('User tidak ditemukan.', 404);
  if (users[index].id === actor.id) throw new UserError('Tidak bisa menghapus akun sendiri.');

  const victim = users[index];
  if (victim.role === 'admin' && isLastAdmin(victim)) {
    throw new UserError('Harus ada minimal satu admin.');
  }

  users.splice(index, 1);
  persist();
  return { id, username: victim.username };
}

function isLastAdmin(candidate) {
  return users.filter((u) => !u.disabled && u.role === 'admin' && u.id !== candidate.id).length === 0;
}

module.exports = {
  UserError,
  FILE,
  migrateEnvAdmin,
  list: listUsers,
  count,
  summary,
  findById,
  findRaw: (username) => {
    const user = findRaw(username);
    return user ? publicView(user) : null;
  },
  verify,
  create: createUser,
  setDisabled,
  setRole,
  changePassword,
  changeOwnPassword,
  remove,
  publicView,
};