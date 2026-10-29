'use strict';

const path = require('path');

/**
 * Pembatas akses file system.
 *
 * Default-nya root adalah "/": panel ini memang alat administer server, jadi
 * membatasi ke home direktori hanya akan memaksa penggunaKeluar dari aplikasi
 * saat ingin mengelola /etc/nginx. Yang tetap dijaga adalah input dinormalisasi
 * dan tidak boleh keluar dari root lewat "..".
 */
const FS_ROOT = path.posix.normalize(process.env.FS_ROOT || '/');

class FsError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

/**
 * Terima path dari browser, kembalikan bentuk POSIX yang sudah bersih.
 * Menolak NUL byte, path relatif, dan "../" yang keluar dari FS_ROOT.
 */
function safePath(input) {
  if (typeof input !== 'string' || input === '') throw new FsError('Path tidak boleh kosong.');
  if (input.includes('\0')) throw new FsError('Path tidak valid.');

  // Path relatif dipetakan ke root FS_ROOT supaya UI boleh mengirim "~" atau
  // nama folder tanpa garis miring depan.
  const normalized = path.posix.normalize(path.posix.join(FS_ROOT, input));

  if (!path.posix.isAbsolute(normalized)) throw new FsError('Path harus absolut.');

  // Prefix "/" butuh penanganan khusus: `${'/'}/` jadi "//" dan tidak akan
  // cocok dengan "/etc" atau "/home".
  const prefix = FS_ROOT === '/' ? '/' : `${FS_ROOT}/`;
  if (normalized !== FS_ROOT && !normalized.startsWith(prefix)) {
    throw new FsError(`Akses di luar ${FS_ROOT} ditolak.`, 403);
  }
  return normalized;
}

/** Sama seperti safePath, tapi untuk sepasang path pada operasi rename. */
function bothPaths(from, to) {
  return { from: safePath(from), to: safePath(to) };
}

// Bit S_IFMT pada mode, sesuai POSIX. Objek Stats dari ssh2 tidak mengekspos
// field "type", jadi jenis entri harus diturunkan dari mode.
const S_IFMT = 0o170000;
const TYPE_BY_MODE = {
  0o140000: 'socket',
  0o120000: 'symlink',
  0o100000: 'file',
  0o060000: 'block-device',
  0o040000: 'folder',
  0o020000: 'char-device',
  0o010000: 'fifo',
};

function typeOf(attrs) {
  return TYPE_BY_MODE[attrs.mode & S_IFMT] || 'lainnya';
}

/**
 * Normalisasi hasil SFTP menjadi bentuk yang dipakai UI.
 *
 * Dua bentuk berbeda perlu ditangani:
 *   - readdir  -> { filename, longname, attrs }
 *   - stat     -> Stats langsung (tidak punya filename, hanya `name` dari pemanggil)
 */
function describe(entry, nameOverride) {
  const attrs = entry && typeof entry === 'object' && entry.attrs ? entry.attrs : entry;
  const type = typeOf(attrs);
  const perms = attrs.mode & 0o7777;

  return {
    name: nameOverride ?? entry.filename ?? attrs.filename ?? null,
    type,
    size: Number.isFinite(attrs.size) ? attrs.size : null,
    mode: perms,
    modeText: perms.toString(8).padStart(3, '0'),
    owner: attrs.uid ?? null,
    group: attrs.gid ?? null,
    modified: (attrs.mtime || 0) * 1000,
    isSymlink: type === 'symlink',
  };
}

module.exports = {
  safePath, describe, typeOf, FsError, FS_ROOT, TYPE_BY_MODE,
};