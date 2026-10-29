'use strict';

const { shellQuote } = require('./ssh-manager');

/**
 * Pengambil data untuk aplikasi desktop (Process Viewer, Disk Usage, System
 * Monitor). Semua memakai exec() pada koneksi SSH yang sama dengan terminal,
 * jadi tidak ada koneksi tambahan per aplikasi.
 *
 * Setiap perintah dibungkus marker supaya stdout bisa dipotong dengan aman,
 * dan dibatasi supaya tidak membanjiri memori panel.
 */

const LIMITS = {
  maxOutputBytes: 512 * 1024,
  timeoutMs: 20_000,
};

async function run(session, command, timeoutMs = LIMITS.timeoutMs) {
  const { exec } = require('./ssh-manager');
  return exec(session.client, command, timeoutMs);
}

/** Potong output yang terlalu besar dan beri tanda, jangan diam-diam dipotong. */
function cap(text, limit = LIMITS.maxOutputBytes) {
  const buffer = Buffer.from(text, 'utf8');
  if (buffer.length <= limit) return text;
  return `${buffer.subarray(0, limit).toString('utf8')}\n… (output dipotong pada ${Math.round(limit / 1024)} KB)`;
}

// ---------------------------------------------------------------- processes
async function processes(session) {
  const output = await run(session, 'ps -eo pid,ppid,user,%cpu,%mem,rss,etime,stat,args --sort=-%cpu 2>/dev/null || ps aux');
  return { processes: parsePs(output), truncated: output.length > 512 * 1024 };
}

/**
 * Parser output `ps`. Format GNU dan BSD punya urutan kolom berbeda (mis. PID
 * ada di kolom 0 pada `ps -eo`, kolom 1 pada `ps aux`), jadi kolom dicari
 * berdasarkan nama di header, bukan indeks tetap.
 */
function parsePs(text) {
  const lines = text.split('\n').filter(Boolean);
  if (lines.length < 2) return [];

  const header = lines[0].trim().split(/\s+/).map((h) => h.toLowerCase());

  // Kolom args/command boleh mengandung spasi, jadi dipotong dari depan.
  const argsIndex = header.findIndex((h) => h === 'args' || h === 'command');
  if (argsIndex === -1) return [];

  const num = (parts, ...names) => {
    for (const name of names) {
      const i = header.indexOf(name);
      if (i !== -1) {
        const value = parseFloat(parts[i]);
        if (Number.isFinite(value)) return value;
      }
    }
    return null;
  };
  const str = (parts, ...names) => {
    for (const name of names) {
      const i = header.indexOf(name);
      if (i !== -1 && parts[i] !== undefined) return parts[i];
    }
    return null;
  };

  return lines.slice(1)
    .map((line) => {
      const parts = line.trim().split(/\s+/);
      return {
        pid: num(parts, 'pid'),
        ppid: num(parts, 'ppid'),
        user: str(parts, 'user', 'uid') || '-',
        cpu: num(parts, '%cpu', 'c') ?? 0,
        mem: num(parts, '%mem', '%mem') ?? 0,
        rss: (num(parts, 'rss') ?? 0) * 1024,
        elapsed: str(parts, 'etime', 'start', 'started') || '-',
        state: str(parts, 'stat', 'state') || '-',
        command: parts.slice(argsIndex).join(' '),
      };
    })
    .filter((row) => row.pid && row.pid > 0);
}

// -------------------------------------------------------------------- disk
async function diskUsage(session, target = '/') {
  const quoted = shellQuote(target);
  const output = await run(session, `du -x -h --max-depth=1 ${quoted} 2>/dev/null | sort -h | tail -20`);

  const mount = await run(session, 'df -h 2>/dev/null || df');
  return { usage: parseDu(output), mounts: parseDf(mount), path: target };
}

function parseDu(text) {
  return text
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const match = line.trim().match(/^([\d.]+[KMGTP]?)\s+(.*)$/i);
      if (!match) return null;
      return { size: toBytes(match[1]), sizeText: match[1], name: match[2] };
    })
    .filter(Boolean)
    .reverse(); // urut dari yang paling besar
}

function parseDf(text) {
  const lines = text.split('\n').filter(Boolean);
  if (lines.length < 2) return [];

  return lines.slice(1).map((line) => {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 6) return null;
    const [, total, used, available, percent, mount] = cols;
    return {
      mount,
      totalBytes: toBytes(total),
      usedBytes: toBytes(used),
      availableBytes: toBytes(available),
      usedPercent: parseInt(percent, 10) || 0,
    };
  })
    .filter(Boolean)
    // Mount/tmpfs yang kecil akan menyesatkan kalau muncul lebih dulu;
    // akar "/" hampir selalu yang paling relevan.
    .sort((a, b) => b.totalBytes - a.totalBytes);
}

/** "12G" -> byte. Indeks 'BKMGTP' == pangkat 1024. */
function toBytes(value) {
  const match = /^([\d.]+)([BKMGTP]?)/i.exec(String(value || '').trim());
  if (!match) return 0;
  return Math.round((parseFloat(match[1]) || 0) * 1024 ** 'BKMGTP'.indexOf(match[2].toUpperCase()));
}

module.exports = { processes, diskUsage, parsePs, parseDu, parseDf, toBytes, run, cap, LIMITS };