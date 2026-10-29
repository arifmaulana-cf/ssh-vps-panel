'use strict';

const { Client } = require('ssh2');
const { parseKey } = require('ssh2/lib/protocol/keyParser');
const config = require('../config');
const hostKeys = require('./host-keys');
const sessions = require('./sessions');
const proxy = require('./ssh-proxy');

/** Direktori home user remote, dipakai sebagai titik awal File Manager. */
async function resolveHome(session) {
  try {
    // eslint-disable-next-line global-require
    const { openSftp } = require('./sftp');
    const sftp = await openSftp(session.client);
    return await new Promise((resolve) => {
      sftp.realpath('.', (err, resolved) => resolve(err ? null : resolved));
    });
  } catch {
    return null;
  }
}

const DEFAULT_TAB = 'main';

class SshError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

/**
 * Batas private key. Key RSA-2048 sekitar 1,7 KB, RSA-4096 sekitar 3,2 KB,
 * ED25519 di bawah 500 byte, jadi 64 KB longgar tanpa menjadi celah.
 */
const MAX_KEY_BYTES = 64 * 1024;

// Header blok yang bisa dibaca ssh2. Memeriksa di sini supaya file yang
// salah (mis. .pub, sertifikat, atau teks acak) ditolak dengan pesan jelas
// alih-alih kegagalan handshake yang membingungkan.
const KEY_BLOCK = /^-----BEGIN (RSA |DSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/m;

/**
 * Validasi input dari browser sebelum menyentuh jaringan.
 *
 * Dua metode autentikasi yang saling meniadakan: password ATAU private key.
 * Keduanya tidak pernah disimpan — private key hanya hidup selama satu
 * permintaan dan dibuang bersama objek request-nya.
 */
function normalize(input = {}) {
  const host = String(input.host || '').trim();
  const username = String(input.username || '').trim();
  const port = Number.parseInt(input.port, 10) || 22;

  if (!host) throw new SshError('Host wajib diisi.');
  if (!username) throw new SshError('Username wajib diisi.');
  if (!/^[a-zA-Z0-9._:-]+$/.test(host)) throw new SshError('Format host tidak valid.');
  if (!/^[a-zA-Z0-9._-]+$/.test(username)) throw new SshError('Format username tidak valid.');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new SshError('Port tidak valid.');

  const method = input.authMethod === 'key' ? 'key' : 'password';
  const password = typeof input.password === 'string' ? input.password : '';
  const privateKey = typeof input.privateKey === 'string' ? input.privateKey.trim() : '';
  const passphrase = typeof input.passphrase === 'string' ? input.passphrase : '';

  if (method === 'password') {
    if (!password) throw new SshError('Password wajib diisi.');
    // Key dan password bersamaan ditolak agar tidak ada Materi kredensial
    // yang menggantung tanpa alasan.
    if (privateKey) throw new SshError('Isi privateKey saat metode password. Pilih salah satu metode.');
    return { method, host, username, port, password, privateKey: '', passphrase: '' };
  }

  if (!privateKey) {
    throw new SshError('Private key wajib diisi: unggah file .pem atau tempel isinya.');
  }
  if (password) throw new SshError('Isi password saat metode private key. Pilih salah satu metode.');

  const keyBytes = Buffer.byteLength(privateKey, 'utf8');
  if (keyBytes > MAX_KEY_BYTES) {
    throw new SshError(
      `Private key terlalu besar (${Math.round(keyBytes / 1024)} KB, batas ${MAX_KEY_BYTES / 1024} KB). `
      + 'Pastikan yang diunggah adalah file private key, bukan public key.',
      413,
    );
  }
  if (!KEY_BLOCK.test(privateKey)) {
    throw new SshError(
      'Format private key tidak dikenali. Harus diawali "-----BEGIN ... PRIVATE KEY-----". '
      + 'Kalau ini file .pub, itu public key dan tidak bisa dipakai untuk login.',
    );
  }

  return { method, host, username, port, password: '', privateKey, passphrase };
}

/** Label format key dari header blok PEM, dipakai di pesan error. */
function describeKeyFormat(privateKey) {
  const header = String(privateKey).match(/-----BEGIN (?:(RSA|DSA|EC|OPENSSH|ENCRYPTED) )?PRIVATE KEY-----/);
  const label = header?.[1] || 'PRIVATE';
  return label === 'OPENSSH' ? 'format OpenSSH' : `format ${label}`;
}

/** Pesan error ssh2 dibersihkan agar informatif namun tidak membocorkan detail internal. */
function friendlyError(err, context = {}) {
  const msg = String(err?.message || err || 'Gagal terhubung.');
  const viaKey = context.method === 'key';

  // Urutan penting: parse error lebih spesifik harus dicek sebelum
  // 'semua metode auth gagal', karena ssh2 kadang melaporkan keduanya.
  if (/Bad passphrase|bad passphrase|Cannot decrypt|Malformed OpenSSH private key/i.test(msg) && /passphrase|decrypt|Malformed/i.test(msg)) {
    return new SshError('Passphrase salah untuk private key ini.', 401);
  }
  if (/Cannot parse privateKey|Unsupported key format|malformed (OpenSSH )?private key/i.test(msg)) {
    return new SshError(
      `Private key tidak bisa dibaca (${describeKeyFormat(context.privateKey || '')}). `
      + 'Pastikan file lengkap, tidak terpotong, dan bukan public key.',
      400,
    );
  }
  if (/All configured authentication methods failed/i.test(msg)) {
    return new SshError(
      viaKey
        ? 'Server menolak private key ini. Cek username, dan pastikan public key pasangannya ada di ~/.ssh/authorized_keys server.'
        : 'Autentikasi ditolak: username atau password salah.',
      401,
    );
  }
  if (/getaddrinfo|ENOTFOUND|EAI_AGAIN/i.test(msg)) return new SshError('Host tidak dapat diresolv.', 502);
  if (/ECONNREFUSED/i.test(msg)) return new SshError('Koneksi ditolak oleh server (port salah atau SSH mati).', 502);
  if (/ETIMEDOUT|readyTimeout/i.test(msg)) {
    return new SshError(
      'Koneksi timeout: server tidak menjawab dalam batas waktu. '
      + 'Kalau ini AWS EC2, pastikan Security Group mengizinkan port 22 (atau port yang dipilih) dari IP Anda.',
      504,
    );
  }
  if (/Handshake failed|no matching (key exchange|cipher|mac|host key)/i.test(msg)) {
    return new SshError('Handshake SSH gagal: algoritma tidak cocok atau ditolak server.', 502);
  }
  return new SshError(`Koneksi SSH gagal: ${msg.slice(0, 200)}`, 502);
}

function connect(raw) {
  const target = normalize(raw);

  return new Promise((resolve, reject) => {
    const client = new Client();
    const verifier = hostKeys.makeVerifier(target.host, target.port);
    let settled = false;

    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      fn(value);
    };

    client.once('ready', () => finish(resolve, { client, target }));
    client.once('error', (err) => {
      // Utamakan alasan host key yang sudah dipoles, bukan pesan bawaan ssh2.
      const reason = verifier.getFailure();
      finish(reject, reason ? new SshError(reason, 502) : friendlyError(err, target));
    });
    client.once('end', () => finish(reject, new SshError('Server menutup koneksi.', 502)));

    // Hanya satu metode autentikasi yang dikirim ke ssh2. Password kosong
    // dan privateKey kosong tidak pernah ikut Build, supaya ssh2 tidak
    // mencoba metode yang tidak dimaksud.
    const auth = target.method === 'key'
      ? { privateKey: target.privateKey, passphrase: target.passphrase || undefined }
      : { password: target.password };

    try {
      client.connect({
        host: target.host,
        port: target.port,
        username: target.username,
        ...auth,
        readyTimeout: config.CONNECT_TIMEOUT_MS,
        keepaliveInterval: 30_000,
        keepaliveCountMax: 3,
        hostVerifier: verifier,
      });
    } catch (err) {
      finish(reject, friendlyError(err, target));
    }
  });
}

/**
 * Periksa private key tanpa menyentuh jaringan: bisa di-parse, dan bila
 * terenkripsi, passphrase-nya harus benar.
 *
 * Tujuannya supaya kesalahan ketik tidak muncul sebagai "koneksi gagal"
 * yang tidak informatif. Tidak ada outbound traffic sama sekali di sini.
 */
function validateKey(raw = {}) {
  const privateKey = typeof raw.privateKey === 'string' ? raw.privateKey.trim() : '';
  const passphrase = typeof raw.passphrase === 'string' ? raw.passphrase : '';

  if (!privateKey) throw new SshError('Private key belum diisi.');
  if (!KEY_BLOCK.test(privateKey)) {
    throw new SshError(
      'Format private key tidak dikenali. Harus diawali "-----BEGIN ... PRIVATE KEY-----". '
      + 'Kalau ini file .pub, itu public key dan tidak bisa dipakai untuk login.',
    );
  }
  const bytes = Buffer.byteLength(privateKey, 'utf8');
  if (bytes > MAX_KEY_BYTES) {
    throw new SshError(
      `Private key terlalu besar (${Math.round(bytes / 1024)} KB, batas ${MAX_KEY_BYTES / 1024} KB).`,
      413,
    );
  }

  // Format "ENCRYPTED" hanya ada di PKCS#1; format OpenSSH selalu terenkripsi
  // dan baru ketahuan saat di-parse.
  const looksEncrypted = /ENCRYPTED PRIVATE KEY/.test(privateKey)
    || /Proc-Type:\s*4,ENCRYPTED/.test(privateKey);

  const parsed = parseKey(privateKey, passphrase);
  if (parsed instanceof Error) {
    const message = parsed.message || '';
    if (/passphrase|decrypt|Malformed/i.test(message)) {
      throw new SshError('Passphrase salah untuk private key ini.', 401);
    }
    throw new SshError(`Private key tidak bisa dibaca: ${message.slice(0, 160)}`, 400);
  }

  return {
    ok: true,
    type: parsed.type || 'unknown',
    format: describeKeyFormat(privateKey),
    encrypted: looksEncrypted || /ENCRYPTED/i.test(parsed.comment || ''),
    bytes,
  };
}

/**
 * Buka shell interaktif pada channel baru.
 *
 * ssh2 mengizinkan banyak channel pada satu koneksi SSH, jadi setiap tab
 * terminal mendapat stream-nya sendiri tanpa perlu koneksi tambahan ke VPS.
 */
async function openShell(session, tabId, { cols = 80, rows = 24 } = {}) {
  const stream = await new Promise((resolve, reject) => {
    session.client.shell({ term: 'xterm-256color', cols, rows }, (err, shell) => {
      if (err) reject(friendlyError(err));
      else resolve(shell);
    });
  });

  const terminal = { stream, sockets: new Set(), closed: false };
  session.terminals.set(tabId, terminal);

  const notify = (payload) => {
    for (const socket of terminal.sockets) {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(payload));
    }
  };

  stream.on('data', (chunk) => {
    session.lastActivity = Date.now();
    notify({ type: 'data', data: chunk.toString('utf8') });
  });

  stream.stderr.on('data', (chunk) => {
    notify({ type: 'data', data: `\u001b[31m${chunk.toString('utf8')}\u001b[0m` });
  });

  stream.once('close', (code, signal) => {
    terminal.closed = true;
    notify({ type: 'exit', code, signal });
  });

  // Shell yang ditutup pengguna dianggap pemakaian channel sudah selesai.
  stream.once('end', () => session.terminals.delete(tabId));

  session.client.once('close', () => {
    for (const term of session.terminals.values()) {
      term.closed = true;
      for (const socket of term.sockets) {
        if (socket.readyState === socket.OPEN) {
          socket.send(JSON.stringify({ type: 'exit', code: 0, reason: 'koneksi ditutup' }));
        }
      }
    }
  });

  return terminal;
}

/** Kutip path untuk dipakai di shell: bungkus single-quote, escape kutip internal. */
function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

/** Jalankan perintah sekali jalan, kembalikan stdout+stderr sebagai teks. */
function exec(client, command, timeoutMs = 15_000) {
  return new Promise((resolve, reject) => {
    client.exec(command, (err, stream) => {
      if (err) return reject(friendlyError(err));

      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => {
        stream.close();
        reject(new SshError('Perintah melewati batas waktu.', 504));
      }, timeoutMs);

      stream.on('data', (d) => { stdout += d.toString('utf8'); });
      stream.stderr.on('data', (d) => { stderr += d.toString('utf8'); });
      stream.on('close', (code) => {
        clearTimeout(timer);
        resolve(`${stdout}${stderr}`);
      });
      stream.once('error', (e) => {
        clearTimeout(timer);
        reject(friendlyError(e));
      });
    });
  });
}

/**
 * @param {object} raw  kredensial dari form (tidak pernah disimpan)
 * @param {{id: string, username: string}} owner pemilik sesi ini
 *
 * Owner disimpan sebagai userId sekaligus username: userId yang dipakai untuk
 * pembanding kepemilikan, username hanya untuk ditampilkan di audit dan UI.
 */
async function createSession(raw, owner) {
  // Cek kapasitas sebelum membuka koneksi, supaya tidak membuang waktu dan
  // koneksi jaringan hanya untuk kemudian ditolak.
  if (!sessions.hasCapacity(owner.id)) {
    throw new SshError(
      `Batas ${sessions.MAX_PER_USER} sesi aktif tercapai. Putuskan salah satu sesi sebelum membuka yang baru.`,
      429,
    );
  }

  const { client, target } = await connect(raw);
  const session = sessions.add({
    id: sessions.createId(),
    userId: owner.id,
    username: owner.username,
    host: target.host,
    port: target.port,
    remoteUser: target.username,
    // Hanya metode yang disimpan. Materi kredensial (password maupun private
    // key) tidak pernah masuk ke objek sesi, sehingga tidak bisa bocor lewat
    // serialisasi, audit, atau log.
    authMethod: target.method,
    client,
    // tabId -> { stream, sockets, closed }. Satu tab dibuat otomatis saat
    // sesi dibuat supaya UI selalu punya shell yang siap dibuka.
    terminals: new Map(),
    closed: false,
    createdAt: Date.now(),
    lastActivity: Date.now(),
  });

  // Channel proksi ikut dibersihkan bersama sesi. Kalau tidak, iframe yang
  // masih terbuka akan memakai channel milik sesi yang sudah tertutup.
  proxy.attachToSession(session);

  await openShell(session, DEFAULT_TAB);
  session.home = await resolveHome(session);
  return session;
}

/** Buat tab terminal tambahan pada sesi yang sudah ada (channel baru). */
async function openTab(session, tabId, size = {}) {
  if (session.terminals.has(tabId)) throw new SshError('Tab sudah ada.', 409);
  await openShell(session, tabId, size);
  return tabId;
}

/** Tutup satu tab terminal tanpa menutup sesi. */
function closeTab(session, tabId) {
  const terminal = session.terminals.get(tabId);
  if (!terminal) return false;
  session.terminals.delete(tabId);
  try { terminal.stream.end(); } catch { /* abaikan */ }
  for (const socket of terminal.sockets) {
    try { socket.close(1000, 'Tab ditutup'); } catch { /* abaikan */ }
  }
  return true;
}

module.exports = {
  connect, openShell, openTab, closeTab, exec, createSession, normalize, shellQuote,
  validateKey, SshError, MAX_KEY_BYTES, DEFAULT_TAB,
};