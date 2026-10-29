'use strict';

const path = require('path');
const { safePath, describe, typeOf, FS_ROOT, FsError } = require('./fs-paths');
const audit = require('./audit');
const { exec, shellQuote } = require('./ssh-manager');

const MAX_TEXT_BYTES = 2 * 1024 * 1024; // batas file yang boleh diedit di editor
const MAX_DOWNLOAD_BYTES = 64 * 1024 * 1024;
const MAX_UPLOAD_BYTES = 64 * 1024 * 1024;

/** Ubah error SFTP yang kaku menjadi pesan yang bisa ditampilkan di UI. */
function translate(err, fallback) {
  if (err instanceof FsError) return err;
  const msg = String(err?.message || err || fallback);
  if (/No such file|ENOENT/i.test(msg)) return new FsError('Tidak ditemukan.', 404);
  if (/Permission denied|EACCES/i.test(msg)) return new FsError('Akses ditolak oleh server.', 403);
  if (/Failure|EEXIST|already exists/i.test(msg)) return new FsError('Gagal: nama sudah dipakai atau tidak didukung server.', 409);
  if (/not empty|ENOTEMPTY/i.test(msg)) return new FsError('Folder tidak kosong.', 409);
  if (/is a directory|EISDIR/i.test(msg)) return new FsError(' itu sebuah folder.', 400);
  if (/not a directory|ENOTDIR/i.test(msg)) return new FsError(' bukan sebuah folder.', 400);
  return new FsError(`${fallback}: ${msg.slice(0, 160)}`, 400);
}

function rejecter(reject, fallback) {
  return (err) => reject(translate(err, fallback));
}

// ------------------------------------------------------------ channel SFTP
function openSftp(client) {
  if (client._sftp) return Promise.resolve(client._sftp);

  return new Promise((resolve, reject) => {
    client.sftp((err, sftp) => {
      if (err) return reject(translate(err, 'Gagal membuka channel SFTP'));
      client._sftp = sftp;
      sftp.once('close', () => { client._sftp = null; });
      return resolve(sftp);
    });
  });
}

const withSftp = (session, fn) => openSftp(session.client).then(fn);

/** Bungkus callback-api ssh2 menjadi promise, dengan pesan error terbaca. */
function call(sftp, method, ...args) {
  const fallback = method;
  return new Promise((resolve, reject) => {
    sftp[method](...args, (err, result) => {
      if (err) return reject(translate(err, `Gagal ${fallback}`));
      return resolve(result);
    });
  });
}

// ------------------------------------------------------------------- baca
async function list(session, dirInput) {
  const dir = safePath(dirInput);
  const sftp = await openSftp(session.client);
  const entries = await call(sftp, 'readdir', dir);

  // Dibungkus panah: map() akan mengirim (entry, index, array), dan index
// akan ikut terisi sebagai nameOverride kalau describe dipanggil langsung.
const items = entries.map((entry) => describe(entry));
  // Folder dulu, lalu file; di dalam tiap kelompok diurutkan berdasarkan nama.
  items.sort((a, b) => {
    const rankA = a.type === 'folder' ? 0 : 1;
    const rankB = b.type === 'folder' ? 0 : 1;
    return rankA - rankB || a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
  });

  return {
    path: dir,
    // null berarti sudah di puncak yang boleh diakses.
    parent: dir === FS_ROOT ? null : path.posix.dirname(dir),
    items,
  };
}

async function stat(session, target) {
  const p = safePath(target);
  const sftp = await openSftp(session.client);
  const attrs = await call(sftp, 'stat', p);
  return { path: p, ...describe(attrs, path.posix.basename(p)) };
}

async function readText(session, target) {
  const p = safePath(target);
  const sftp = await openSftp(session.client);
  const attrs = await call(sftp, 'stat', p);

  if (attrs.isDirectory()) throw new FsError(' itu sebuah folder.', 400);
  if (attrs.size > MAX_TEXT_BYTES) {
    throw new FsError(
      `File terlalu besar untuk diedit (${formatBytes(attrs.size)}). Gunakan download.`, 413,
    );
  }

  const buffer = await new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    const stream = sftp.createReadStream(p);

    stream.on('data', (chunk) => {
      size += chunk.length;
      // Pengaman kedua kalau file tumbuh saat dibaca.
      if (size > MAX_TEXT_BYTES) { stream.destroy(); return; }
      return chunks.push(chunk);
    });
    stream.on('error', rejecter(reject, 'Gagal membaca file'));
    stream.on('end', () => resolve(Buffer.concat(chunks, size)));
  });

  return {
    path: p,
    content: buffer.toString('utf8'),
    size: buffer.length,
    modified: attrs.mtime * 1000,
    binary: isBinary(buffer),
  };
}

// ------------------------------------------------------------------ tulis
/**
 * Tulis ke berkas sementara lalu pindahkan ke tempatnya, supaya file asli
 * tidak pernah tertinggal setengah tertulis bila koneksi terputus di tengah.
 *
 * Pindahkannya memakai `mv -f` lewat SSH, bukan SFTP RENAME: protokol SFTP v3
 * (yang dipakai OpenSSH) mengembalikan FAILURE bila berkas tujuan sudah ada,
 * sehingga tidak bisa menimpa file yang sudah ada - persis kasus "Save" di
 * text editor. `mv` di sistem yang sama bersifat atomik.
 */
async function writeText(session, target, content) {
  const p = safePath(target);
  if (typeof content !== 'string') throw new FsError('Isi file tidak valid.');

  const data = Buffer.from(content, 'utf8');
  if (data.length > MAX_TEXT_BYTES) {
    throw new FsError('Isi file terlalu besar untuk disimpan lewat editor.', 413);
  }

  const sftp = await openSftp(session.client);
  const tmp = `${p}.panel-tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;

  try {
    await new Promise((resolve, reject) => {
      const stream = sftp.createWriteStream(tmp);
      stream.on('error', rejecter(reject, 'Gagal menyimpan file'));
      stream.on('close', resolve);
      stream.end(data);
    });

    await exec(session.client, `mv -f -- ${shellQuote(tmp)} ${shellQuote(p)}`);
  } catch (err) {
    await exec(session.client, `rm -f -- ${shellQuote(tmp)}`).catch(() => {});
    throw err;
  }

  audit.record('file.write', p, { bytes: data.length });
  return { path: p, size: data.length, modified: Date.now() };
}

async function mkdir(session, target) {
  const p = safePath(target);
  const sftp = await openSftp(session.client);
  await call(sftp, 'mkdir', p);
  audit.record('fs.mkdir', p);
  return { path: p };
}

async function rename(session, fromInput, toInput) {
  const from = safePath(fromInput);
  const to = safePath(toInput);
  const sftp = await openSftp(session.client);
  await call(sftp, 'rename', from, to);
  audit.record('fs.rename', from, { to });
  return { from, to };
}

/**
 * Hapus file atau folder. Folder perlu dihapus rekursif, dan SFTP tidak punya
 * API rekursif, jadi memakai rm lewat koneksi SSH yang sama. Path sudah
 * dinormalisasi dan diberi kutip shell ganda ('...'), bukan string biasa.
 */
async function remove(session, target) {
  const p = safePath(target);
  const sftp = await openSftp(session.client);
  const attrs = await call(sftp, 'lstat', p);

  if (typeOf(attrs) === 'folder' && !attrs.isSymbolicLink()) {
    await exec(session.client, `rm -rf -- ${shellQuote(p)}`);
    audit.record('fs.rmdir', p);
    return { path: p, recursive: true };
  }

  await call(sftp, 'unlink', p);
  audit.record('fs.unlink', p);
  return { path: p, recursive: false };
}

// ----------------------------------------------------------------- transfer
async function download(session, target, res) {
  const p = safePath(target);
  const sftp = await openSftp(session.client);
  const attrs = await call(sftp, 'stat', p);

  if (attrs.isDirectory()) throw new FsError('Folder tidak bisa didownload.', 400);
  if (attrs.size > MAX_DOWNLOAD_BYTES) {
    throw new FsError(`File terlalu besar (${formatBytes(attrs.size)}).`, 413);
  }

  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Length', attrs.size);
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(p.split('/').pop())}`);

  await new Promise((resolve, reject) => {
    const stream = sftp.createReadStream(p);
    stream.on('error', (err) => {
      res.destroy();
      reject(translate(err, 'Gagal mengirim file'));
    });
    stream.on('end', () => {
      audit.record('file.download', p, { bytes: attrs.size });
      resolve();
    });
    stream.pipe(res);
  });
}

async function upload(session, target, buffer) {
  const p = safePath(target);
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new FsError('Tidak ada isi file.');
  }
  if (buffer.length > MAX_UPLOAD_BYTES) {
    throw new FsError(`File terlalu besar (maks ${formatBytes(MAX_UPLOAD_BYTES)}).`, 413);
  }

  const sftp = await openSftp(session.client);
  await new Promise((resolve, reject) => {
    const stream = sftp.createWriteStream(p);
    stream.on('error', rejecter(reject, 'Gagal menyimpan file'));
    stream.on('close', resolve);
    stream.end(buffer);
  });

  audit.record('file.upload', p, { bytes: buffer.length });
  return { path: p, size: buffer.length };
}

// ------------------------------------------------------------------ utilitas
function isBinary(buffer) {
  const limit = Math.min(buffer.length, 4096);
  for (let i = 0; i < limit; i += 1) if (buffer[i] === 0) return true;
  return false;
}

function formatBytes(n) {
  if (!n) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(Math.floor(Math.log(n) / Math.log(1024)), units.length - 1);
  return `${(n / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

module.exports = {
  list, stat, readText, writeText, mkdir, rename, remove, download, upload,
  formatBytes, isBinary, openSftp, MAX_TEXT_BYTES, MAX_UPLOAD_BYTES, MAX_DOWNLOAD_BYTES,
};