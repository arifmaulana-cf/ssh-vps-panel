'use strict';

const tls = require('tls');
const config = require('../config');

/**
 * Mesin proksi SSH: membuka channel TCP ke host:port tujuan LEWAT koneksi SSH
 * milik user yang sedang login.
 *
 * Fondasinya persis yang dipakai `ssh -L`: channel direct-tcpip. Perbedaannya
 * hanya bentuknya - tidak ada soket lokal yang perlu di-bind, jadi panel tidak
 * perlu membuka port baru di server sama sekali.
 *
 * Dua lapis yang ditambahkan di atasnya:
 *
 * 1. **TLS di sisi panel.** Browser di dalam iframe hanya boleh membuka ke
 *    asal panel itu sendiri (mixed content), dan mustahil memulai TLS ke host
 *    lain dari dalam sebuah halaman. Jadi channel SSH dibungkus
 *    tls.connect(): panel yang-press-and-speaking dengan HTTPS tujuan, lalu
 *    menyajikan hasilnya sebagai HTML biasa di asalnya sendiri.
 */

const MAX_CHANNELS = 6;
const CHANNEL_TTL_MS = 60_000;
const MAX_TARGET_LEN = 255;

class ProxyError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

// channelId -> { stream, sessionId, target, openedAt }
const channels = new Map();
let seq = 0;

/** Buang channel yang sudah tidak dipakai, supaya tidak menumpuk. */
function sweep() {
  const now = Date.now();
  for (const [id, entry] of channels) {
    if (now - entry.openedAt > CHANNEL_TTL_MS) closeChannel(id);
  }
}

const sweeper = setInterval(sweep, 20_000);
sweeper.unref();

function closeChannel(id) {
  const entry = channels.get(id);
  if (!entry) return false;
  channels.delete(id);
  try { entry.stream.end(); } catch { /* abaikan */ }
  try { entry.stream.destroy(); } catch { /* abaikan */ }
  return true;
}

function closeAllForSession(sessionId) {
  let closed = 0;
  for (const [id, entry] of channels) {
    if (entry.sessionId !== sessionId) continue;
    if (closeChannel(id)) closed += 1;
  }
  return closed;
}

function validateTarget(host, port) {
  const h = String(host || '').trim();
  if (!h || h.length > MAX_TARGET_LEN) {
    throw new ProxyError('Host tujuan tidak valid.');
  }
  // Izinkan nama host, IPv4, IPv6. Menolak karakter lain mencegah penyalahgunaan
  // string tujuan jadi tempat menyisipkan header.
  if (!/^[A-Za-z0-9._:-]+$/.test(h)) {
    throw new ProxyError('Host tujuan hanya boleh berisi huruf, angka, titik, strip, titik dua, dan strip.');
  }
  const p = Number.parseInt(port, 10);
  if (!Number.isInteger(p) || p < 1 || p > 65535) {
    throw new ProxyError('Port tujuan tidak valid.');
  }
  return { host: h, port: p };
}

/**
 * Buka satu channel ke tujuan.
 *
 * @param {object} session  sesi SSH milik user
 * @param {{host: string, port: number}} target
 * @returns {Promise<{id: string, stream: import('stream').Duplex}>}
 */
function openChannel(session, target) {
  if (!session.client || session.closed) {
    return Promise.reject(new ProxyError('Koneksi SSH sudah tertutup.', 410));
  }

  // Batasi per sesi:_forwardOut_ membuka channel di server tujuan, dan server
  // punya batasnya sendiri (MaxSessions). Tanpa pembatas di sini, satu
  // refresh halaman dari iframe yang gagal bisa menghabiskan kuota itu.
  if (channels.size >= MAX_CHANNELS) closeOldest();

  return new Promise((resolve, reject) => {
    session.client.forwardOut('127.0.0.1', 0, target.host, target.port, (err, stream) => {
      if (err) {
        return reject(new ProxyError(
          `Tidak bisa menjangkau ${target.host}:${target.port} dari VPS ini `
          + `(${err.message}). Kalau memang layanan lokal, cek porta dengan "ss -ltn".`,
          502,
        ));
      }
      const id = `px${++seq}${Date.now().toString(36)}`;
      channels.set(id, { stream, sessionId: session.id, target, openedAt: Date.now() });
      stream.on('close', () => channels.delete(id));
      stream.on('error', () => channels.delete(id));
      return resolve({ id, stream });
    });
  });
}

function closeOldest() {
  let oldestId = null;
  let oldestAt = Infinity;
  for (const [id, entry] of channels) {
    if (entry.openedAt < oldestAt) { oldestAt = entry.openedAt; oldestId = id; }
  }
  if (oldestId) closeChannel(oldestId);
}

/**
 * Bungkus stream channel dengan TLS.
 *
 * `rejectUnauthorized: false` itu disengaja dan penting: sertifikat di dalam
 * jaringan internal sering ditandatangani sendiri, dan panel tidak punya cara
 * memverifikasinya tanpa CA milik organisasi. Verifikasi yang sebenarnya
 * terjadi satu lapis di atas: pengguna hanya boleh mencapai apa yang sudah bisa
 * dia capai lewat shell miliknya sendiri.
 *
 * Konsekuensinya harus disebut terbuka: panel tidak memberi peringatan kalau
 * sertifikat server tujuan berubah atau pals. Yang tetap berlaku adalah
 * aturan aksesnya - proksi hanya bisa menjangkau apa yang sudah bisa dicapai
 * lewat shell milik user itu sendiri.
 */
function wrapTls(socket, servername) {
  return new Promise((resolve, reject) => {
    const secure = tls.connect({
      socket,
      servername: /^[A-Za-z0-9.-]+$/.test(servername) ? servername : undefined,
      rejectUnauthorized: false,
    });

    const fail = (err) => {
      try { secure.destroy(); } catch { /* abaikan */ }
      reject(new ProxyError(
        `TLS ke ${servername} gagal (${err.message}). `
        + 'Kalau memang HTTPS, pastikan sertifikatnya valid di server tujuan.',
        502,
      ));
    };

    secure.once('error', fail);
    secure.once('secureConnect', () => {
      secure.removeListener('error', fail);
      resolve(secure);
    });
  });
}

/** Bersihkan semua channel milik sebuah sesi (dipanggil saat sesi diputus). */
function attachToSession(session) {
  const close = () => closeAllForSession(session.id);
  session.client.once('close', close);
  session.client.once('end', close);
  session.on?.('closed', close);
}

module.exports = {
  ProxyError,
  MAX_CHANNELS,
  CHANNEL_TTL_MS,
  openChannel,
  wrapTls,
  closeChannel,
  closeAllForSession,
  attachToSession,
  validateTarget,
  get count() { return channels.size; },
  config,
};