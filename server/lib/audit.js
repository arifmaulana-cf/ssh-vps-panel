'use strict';

/**
 * Jejak audit untuk operasi yang mengubah server (tulis/hapus/upload/rename).
 * Disimpan di ring buffer in-memory supaya bisa dilihat dari UI tanpa perlu
 * database, dan ikut dicetak ke stdout agar tidak hilang saat restart.
 */
const LIMIT = 300;
const entries = [];

/**
 * @param {string} action
 * @param {string} target
 * @param {object} [detail]   hanya field yang ada di ALLOWED_SCALAR
 * @param {{id: string, username: string}} [actor] pelaku, untuk penyaringan
 */
function record(action, target, detail, actor) {
  const safeDetail = scrubDetail(detail);
  const entry = {
    at: Date.now(),
    action,
    target,
    ...(actor ? { userId: actor.id, actor: actor.username } : {}),
    ...(safeDetail ? { detail: safeDetail } : {}),
  };

  entries.unshift(entry);
  if (entries.length > LIMIT) entries.length = LIMIT;

  const where = target || '';
  const who = actor ? `${actor.username}` : 'system';
  console.log(`[audit] ${who} ${action} ${where}${safeDetail?.bytes ? ` (${safeDetail.bytes} B)` : ''}`);
  return entry;
}

/**
 * Hanya nama field yang boleh masuk detail, dan nilainya harus sederhana.
 * Dipakai untuk mencatat fakta tanpa membiarkan materi kredensial ikut.
 */
const ALLOWED_SCALAR = new Set(['bytes', 'authMethod', 'to', 'path', 'recursive']);

/** Buang apa pun yang bukan field yang diizinkan atau bukan nilai sederhana. */
function scrubDetail(detail) {
  if (!detail || typeof detail !== 'object') return undefined;
  const out = {};
  for (const [key, value] of Object.entries(detail)) {
    if (!ALLOWED_SCALAR.has(key)) continue;
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      out[key] = value;
    }
  }
  return Object.keys(out).length ? out : undefined;
}

/**
 * @param {number} limit
 * @param {{userId?: string, isAdmin?: boolean}} scope
 *
 * Isolasi per user diterapkan di sini, di sisi server. Ordinary user hanya
 * melihat jejak aksinya sendiri; admin melihat semuanya.
 */
function list(limit = 100, scope = {}) {
  const max = Math.min(limit, LIMIT);
  const visible = (!scope.userId || scope.isAdmin)
    ? entries
    : entries.filter((e) => e.userId === scope.userId);

  return visible.slice(0, max);
}

const clear = () => { entries.length = 0; };

module.exports = { record, list, clear, scrubDetail, LIMIT };