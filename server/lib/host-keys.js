'use strict';

const fs = require('fs');
const crypto = require('crypto');
const config = require('../config');

/**
 * Trust-On-First-Use untuk host key SSH.
 * Sidik jari host disimpan di data/known_hosts.json agar koneksi berikutnya
 * ke host yang sama dapat mendeteksi perubahan kunci (indikasi MITM).
 *
 * File dimuat ulang otomatis ketika mtime-nya berubah di disk, sehingga
 * mengedit known_hosts.json (mis. menghapus entri yang mencurigakan) langsung
 * berlaku tanpa perlu restart server.
 */
let store = load();
let loadedMtime = mtime();

function load() {
  try {
    const parsed = JSON.parse(fs.readFileSync(config.KNOWN_HOSTS_FILE, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function mtime() {
  try {
    return fs.statSync(config.KNOWN_HOSTS_FILE).mtimeMs;
  } catch {
    return 0;
  }
}

function sync() {
  const current = mtime();
  if (current === loadedMtime) return;
  store = load();
  loadedMtime = current;
}

function save() {
  fs.writeFileSync(config.KNOWN_HOSTS_FILE, `${JSON.stringify(store, null, 2)}\n`);
  loadedMtime = mtime();
}

/** Sidik jari SHA256 dari blob host key mentah (format OpenSSH). */
function fingerprint(key) {
  const digest = crypto.createHash('sha256').update(key).digest('base64').replace(/=+$/, '');
  return `SHA256:${digest}`;
}

/**
 * @param {Buffer} key blob host key dari ssh2
 * @param {{host: string, port: number}} target
 * @returns {{ok: true, isNew?: boolean} | {ok: false, reason: string}}
 */
function verify(key, target) {
  sync();

  if (config.TRUST_HOST_KEY === 'false' || config.TRUST_HOST_KEY === 'off') {
    return { ok: true };
  }

  const id = `${target.host}:${target.port}`;
  const actual = fingerprint(key);
  const known = store[id];

  if (!known) {
    store[id] = actual;
    save();
    return { ok: true, isNew: true };
  }

  if (known === actual) return { ok: true };

  return {
    ok: false,
    reason:
      `Host key berubah untuk ${id}.\n` +
      `  tersimpan : ${known}\n` +
      `  diterima  : ${actual}\n` +
      'Hapus entri di data/known_hosts.json bila Anda yakin ini host yang sama.',
  };
}

/**
 * Dibuat ulang untuk setiap percobaan koneksi agar mengetahui host tujuan.
 * ssh2 hanya menerima boolean dari callback dan memunculkan pesan
 * "Host denied (verification failed)", jadi alasan yang lebih berguna
 * disimpan di sini supaya bisa ditampilkan ke pengguna.
 */
function makeVerifier(host, port) {
  let failure = null;

  const verifier = (key, callback) => {
    const result = verify(key, { host, port });

    if (result.ok && result.isNew) {
      console.log(`  [host-key] host baru dicatat: ${host}:${port}`);
    } else if (!result.ok) {
      failure = result.reason;
    }

    callback(result.ok, result);
  };

  verifier.getFailure = () => failure;
  return verifier;
}

module.exports = { makeVerifier, fingerprint, reload: sync };