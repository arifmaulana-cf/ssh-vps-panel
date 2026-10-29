'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Store } = require('express-session');
const config = require('../config');

/**
 * Store express-session berbasis berkas JSON.
 *
 * MemoryStore bawaan kehilangan semua sesi saat proses restart. Untuk panel
 * yang dipakai banyak orang, itu berarti setiap deploy memutus semua orang
 * yang sedang bekerja di terminal mereka.
 *
 * Yang disimpan di sini adalah sisi server dari sesi (id, userId, loginAt).
 * Kunci session id sendiri ada di cookie httpOnly + signed, jadi berkas ini
 * tidak cukup untuk diserang dari luar. Mode 0600 tetap dipasang sebagai
 * lapisan kedua.
 *
 * Batasnya jelas dan sengaja: ini satu proses, satu berkas, ditulis penuh
 * setiap perubahan. Untuk ribuan sesi aktif dibutuhkan store sungguhan
 * (redis, sqlite). Panel ini untuk belasan pengguna, jadi berkas sudah
 * cukup dan jauh lebih mudah di-backup dengan `cp`.
 */

const FILE = path.join(config.DATA_DIR, 'sessions.json');
const FLUSH_DELAY_MS = 250;

let data = {};
let dirty = false;
let timer = null;

function load() {
  try {
    const parsed = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
  } catch { /* belum ada / rusak: mulai dari kosong */ }
  return {};
}

/** Buang sesi kedaluwarsa agar berkas tidak tumbuh tanpa batas. */
function sweep() {
  const now = Date.now();
  let removed = 0;
  for (const [sid, entry] of Object.entries(data)) {
    if (entry?.expires && entry.expires <= now) {
      delete data[sid];
      removed += 1;
    }
  }
  if (removed) dirty = true;
}

function flush() {
  timer = null;
  if (!dirty) return;
  dirty = false;
  try {
    fs.mkdirSync(config.DATA_DIR, { recursive: true });
    const tmp = `${FILE}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
    fs.writeFileSync(tmp, `${JSON.stringify(data)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, FILE);
  } catch (err) {
    console.error('[session-store] gagal menulis:', err.message);
  }
}

/** Tulis tertunda supaya satu login yang involves beberapa set hanya menulis sekali. */
function scheduleFlush() {
  dirty = true;
  if (timer) return;
  timer = setTimeout(flush, FLUSH_DELAY_MS);
  timer.unref();
}

class FileSessionStore extends Store {
  constructor() {
    super();
    data = load();
    sweep();
    setInterval(() => { sweep(); if (dirty) flush(); }, 60_000).unref();
  }

  get(sid, callback) {
    const entry = data[sid];
    if (!entry) return callback(null, null);
    if (entry.expires && entry.expires <= Date.now()) {
      delete data[sid];
      scheduleFlush();
      return callback(null, null);
    }
    return callback(null, entry.session || null);
  }

  set(sid, session, callback) {
    const expires = session?.cookie?.expires
      ? new Date(session.cookie.expires).getTime()
      : null;

    data[sid] = { session, expires, savedAt: Date.now() };
    scheduleFlush();
    return callback(null);
  }

  /**
   * express-session memakai touch() hanya untuk memperpanjang masa hidup
   * cookie yang slid. Kalau store menulis ulang seluruh entry tiap touch,
   * satu pengguna yang aktif mengetik akan menulis berkas berkali-kali.
   * Yang perlu disimpan cukup expiry barunya saja.
   */
  touch(sid, session, callback) {
    const entry = data[sid];
    if (entry && session?.cookie?.expires) {
      entry.expires = new Date(session.cookie.expires).getTime();
      entry.session = session;
      scheduleFlush();
    }
    return callback(null);
  }

  destroy(sid, callback) {
    if (data[sid]) {
      delete data[sid];
      scheduleFlush();
    }
    return callback(null);
  }

  all(callback) {
    sweep();
    return callback(null, Object.values(data).map((e) => e.session).filter(Boolean));
  }

  length(callback) {
    return this.all((err, list) => callback(err, list.length));
  }

  clear(callback) {
    data = {};
    dirty = true;
    flush();
    return callback(null);
  }

  /** Dipakai saat boot: buang sesi milik user yang sudah dinonaktifkan/dihapus. */
  destroyWhere(predicate) {
    let removed = 0;
    for (const [sid, entry] of Object.entries(data)) {
      if (predicate(entry?.session)) {
        delete data[sid];
        removed += 1;
      }
    }
    if (removed) { dirty = true; flush(); }
    return removed;
  }

  flushNow() {
    if (timer) { clearTimeout(timer); timer = null; }
    flush();
  }
}

/**
 * Satu instance dipakai seluruh aplikasi, supaya app.js (middleware) dan
 * routes (mis. saat memotong sesi semua orang) menulis ke berkas yang sama.
 */
let instance = null;

function getStore() {
  if (!instance) instance = new FileSessionStore();
  return instance;
}

module.exports = { FileSessionStore, getStore, FILE };