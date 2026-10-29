'use strict';

const crypto = require('crypto');
const config = require('../config');

const sessions = new Map();

const TTL_MS = config.SSH_TTL_MINUTES * 60 * 1000;
const MAX_PER_USER = config.MAX_SESSIONS_PER_USER;

function createId() {
  return crypto.randomBytes(24).toString('base64url');
}

function touch(session) {
  session.lastActivity = Date.now();
}

function add(session) {
  sessions.set(session.id, session);
  touch(session);
  return session;
}

function get(id) {
  const session = sessions.get(id);
  if (!session) return undefined;
  if (Date.now() - session.lastActivity > TTL_MS) {
    destroy(id);
    return undefined;
  }
  return session;
}

/**
 * Sesi dikunci ke userId, bukan username.
 *
 * Username suatu hari bisa diganti atau dinonaktifkan, dan kalau kepemilikan
 * dipegang lewat string yang bisa berubah maka sesi lama bisa berpindah
 * tangan. userId dibuat sekali dan tidak pernah berubah, jadi inilah yang
 * dipakai untuk pembanding.
 */
function listByUser(userId) {
  return [...sessions.values()].filter((s) => s.userId === userId);
}

function destroy(id) {
  const session = sessions.get(id);
  if (!session) return false;
  sessions.delete(id);

  for (const terminal of session.terminals?.values() || []) {
    try { terminal.stream.end(); } catch { /* abaikan */ }
    for (const socket of terminal.sockets || []) {
      try { socket.close(); } catch { /* abaikan */ }
    }
  }

  try { session.client?.end(); } catch { /* abaikan */ }
  return true;
}

/**
 * Putuskan semua sesi SSH milik seorang user.
 *
 * Mengembalikan jumlahnya supaya pemanggil bisa melapor ke admin: "akun
 * dinonaktifkan" tanpa tahu berapa koneksi yang ikut terputus adalah informasi
 * yang setengah jadi.
 */
function destroyByUser(userId) {
  const owned = listByUser(userId);
  for (const session of owned) destroy(session.id);
  return owned.length;
}

/** Jumlah sesi hidup milik seorang user. */
function countByUser(userId) {
  return listByUser(userId).length;
}

/**
 * Ringkasan jumlah sesi per userId, untuk dasbor admin.
 * Dihitung sekali di dalam satu lintasan supaya tidak O(n*m) saat daftar user
 * bertambah.
 */
function countByUserIds(userIds) {
  const wanted = new Set(userIds);
  const counts = new Map();
  for (const session of sessions.values()) {
    if (wanted.has(session.userId)) counts.set(session.userId, (counts.get(session.userId) || 0) + 1);
  }
  return counts;
}

/**
 * Waitlist or reject when the user is at the cap.
 * Deliberately rejects the *new* connection instead of killing the oldest
 * session: a live terminal the user is typing in must not be terminated
 * silently behind their back.
 */
function hasCapacity(userId) {
  return countByUser(userId) < MAX_PER_USER;
}

setInterval(() => {
  const now = Date.now();
  for (const session of [...sessions.values()]) {
    if (now - session.lastActivity > TTL_MS) destroy(session.id);
  }
}, 60_000).unref();

module.exports = {
  createId, add, get, destroy, destroyByUser, listByUser, countByUser, countByUserIds, hasCapacity,
  get MAX_PER_USER() { return MAX_PER_USER; },
};