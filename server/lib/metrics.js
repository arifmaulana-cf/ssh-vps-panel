'use strict';

/**
 * Satu perintah gabungan supaya semua metrik diambil dalam satu round-trip.
 * Bagian diberi delimiter agar bisa dipotong dengan aman di sisi server.
 */
const PROBE = [
  'echo "__SYS_OS__"; cat /etc/os-release 2>/dev/null; echo "__SYS_KERNEL__"; uname -srmo 2>/dev/null; uname -v 2>/dev/null',
  'echo "__SYS_UPTIME__"; cat /proc/uptime 2>/dev/null || uptime',
  'echo "__SYS_LOAD__"; cat /proc/loadavg 2>/dev/null || echo "0.00 0.00 0.00"',
  'echo "__SYS_CPU__"; (nproc 2>/dev/null || getconf _NPROCESSORS_ONLN 2>/dev/null || echo 1)',
  'echo "__SYS_MEM__"; cat /proc/meminfo 2>/dev/null | head -4',
  'echo "__SYS_DISK__"; df -h / 2>/dev/null | tail -1',
  'echo "__SYS_END__"',
].join('; ');

/**
 * @param {(cmd: string) => Promise<string>} exec
 */
async function collect(exec) {
  const raw = await exec(PROBE);
  return parse(raw);
}

function parse(raw) {
  const s = splitSections(raw);

  // /proc/loadavg = "0.01 0.08 0.08 2/258 1577527"; hanya tiga nilai pertama
  // yang merupakan load average (1, 5, dan 15 menit).
  const load = (s.LOAD || '').trim().split(/\s+/).slice(0, 3)
    .map(Number).filter(Number.isFinite);

  return {
    os: parseOs(s.OS, s.KERNEL),
    uptimeSeconds: parseFloat(s.UPTIME) || 0,
    load,
    cpuCores: parseInt(s.CPU, 10) || 1,
    mem: parseMem(s.MEM),
    disk: parseDisk(s.DISK),
    raw: raw.slice(0, 4000),
  };
}

function splitSections(raw) {
  const out = {};
  const re = /__SYS_([A-Z]+)__\r?\n([\s\S]*?)(?=__SYS_[A-Z]+__|$)/g;
  let match;
  while ((match = re.exec(raw)) !== null) out[match[1]] = match[2].trim();
  return out;
}

function parseOs(osRelease, kernelBlock) {
  const fields = Object.fromEntries(
    (osRelease || '')
      .split('\n')
      .map((line) => line.split('='))
      .filter((parts) => parts.length >= 2)
      .map(([k, ...rest]) => [k.trim(), rest.join('=').replace(/^"|"$/g, '')]),
  );

  return {
    name: fields.PRETTY_NAME || fields.NAME || 'Unknown',
    id: fields.ID || '',
    version: fields.VERSION_ID || '',
    kernel: (kernelBlock || '').split('\n')[0] || '',
  };
}

function parseMem(memInfo) {
  const fields = Object.fromEntries(
    (memInfo || '')
      .split('\n')
      .map((line) => line.split(':'))
      .filter((parts) => parts.length === 2)
      .map(([k, v]) => [k.trim(), parseFloat(v) || 0]),
  );

  const total = fields.MemTotal || 0;
  const available = fields.MemAvailable ?? fields.MemFree ?? 0;
  const used = Math.max(total - available, 0);

  return {
    totalBytes: total * 1024,
    usedBytes: used * 1024,
    availableBytes: available * 1024,
    usedPercent: total ? Math.round((used / total) * 100) : 0,
  };
}

/** "12G" / "512M" / "1.5T" -> byte. Indeks 'BKMGTP' == pangkat 1024. */
function toBytes(value) {
  const match = /^([\d.]+)([BKMGTP]?)/i.exec(String(value || '').trim());
  if (!match) return 0;
  const amount = parseFloat(match[1]) || 0;
  const exponent = 'BKMGTP'.indexOf(match[2].toUpperCase());
  return Math.round(amount * 1024 ** exponent);
}

/**
 * Format `df -h /`: Filesystem Size Used Available Use% Mounted-on
 * Dipisah dengan regex whitespace agar spasi kolom yang tidak rata tidak
 * menggeser posisi kolom.
 */
function parseDisk(dfLine) {
  const cols = (dfLine || '').trim().split(/\s+/);
  if (cols.length < 6) return null;

  const [, total, used, available, usePercent, mount] = cols;
  const totalBytes = toBytes(total);
  const usedBytes = toBytes(used);
  const percent = usePercent.endsWith('%') ? parseInt(usePercent, 10) : 0;

  return {
    mount: mount || '/',
    totalBytes,
    usedBytes,
    availableBytes: toBytes(available),
    usedPercent: percent || (totalBytes ? Math.round((usedBytes / totalBytes) * 100) : 0),
  };
}

function formatUptime(seconds) {
  const s = Math.max(Math.floor(seconds || 0), 0);
  const days = Math.floor(s / 86400);
  const hours = Math.floor((s % 86400) / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  if (days) return `${days} hari ${hours} jam`;
  if (hours) return `${hours} jam ${minutes} menit`;
  return `${minutes} menit`;
}

module.exports = { collect, parse, formatUptime, PROBE };