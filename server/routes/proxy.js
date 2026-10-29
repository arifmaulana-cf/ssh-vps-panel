'use strict';

const http = require('http');
const express = require('express');
const { WebSocketServer } = require('ws');

const sessions = require('../lib/sessions');
const proxy = require('../lib/ssh-proxy');
const audit = require('../lib/audit');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

/**
 * Proksi web lewat SSH.
 *
 * Alurnya satu request = satu channel SSH baru, dibuat lalu ditutup lagi.
 * Itu boros secara channel, tapi jauh lebih sederhana dan lebih aman daripada
 * menyimpan kanal yang bisa menggantung: kalau ada yang macet,Fpenghammer
 * dibersihkan oleh sweep dan tidak ada kebocoran yang bisa bertahan.
 */

const CONNECT_TIMEOUT_MS = 12_000;
const IDLE_TIMEOUT_MS = 45_000;
const MAX_HEADER_BYTES = 96 * 1024;

// Header yang tidak boleh ikut disalin ke/from tujuan. Sebagian adalah
// "hop-by-hop" (tidak boleh diteruskan sama sekali), sebagian karena
// akan membuat browser menolak menampilkannya di dalam iframe.
const REQUEST_DROP = new Set([
  'host', 'connection', 'keep-alive', 'proxy-connection', 'transfer-encoding',
  'upgrade', 'te', 'trailer', 'accept-encoding',
  'authorization', 'origin', 'referer', 'sec-fetch-mode',
]);

/**
 * Nama cookie milik panel. Tidak boleh pernah diteruskan ke layanan tujuan.
 */
const PANEL_COOKIES = new Set(['panel.sid']);

/**
 * Cookie milik TARGET harus diteruskan; cookie milik PANEL dibuang.
 *
 * Kenapa ini penting: versi pertama membuang header 'cookie' secara TOTAL
 * (needle ada di REQUEST_DROP). Akibatnya JSESSIONID Jenkins tidak pernah
 * sampai ke Jenkins - login mustahil bertahan, dan gejalanya "selalu diminta
 * login lagi" yang sangat mudah disalahartikan sebagai cookie kedaluwarsa.
 *
 * Kenapa tidak bisa menyaring berdasarkan Path: atribut Path hanya ada di
 * Set-Cookie. Cookie pada request http hanya berisi "nama=nilai", tanpa
 * informasi path sama sekali. Versi kedua mencoba memfilter dengan Path dan
 * karena itu membuang SELURUH cookie - termasuk milik target - karena tidak
 * ada yang punya Path untuk diperiksa.
 *
 * Jadi penyaringan dilakukan berdasarkan NAMA: nama target dicatat di sesi
 * ketika Set-Cookie-nya ditulis ulang, dan hanya nama-nama itu yang diteruskan.
 * Cookie yang belum pernah dicatat dianggap milik panel atau milik situs lain,
 * dibuang.
 */
function forwardCookies(header, allowed) {
  // Header Cookie pada request adalah SATU string dengan beberapa pasangan
  // dipisah tanda titik koma - bentuknya berbeda dari Set-Cookie yang berupa
  // array. Mengiterate stringnya langsung hanya menghasilkan satu COOKIE utuh
  // bernama "panel.sid; JSESSIONID; lain", yang tidak cocok dengan apa pun.
  const list = String(header || '').split(';')
    .map((pair) => pair.trim())
    .filter(Boolean);

  const forward = [];
  const dropped = [];

  for (const one of list) {
    const name = String(one).split('=')[0].trim();
    if (PANEL_COOKIES.has(name)) { dropped.push(name); continue; }
    if (allowed && allowed.has(name)) { forward.push(one); continue; }
    dropped.push(name);
  }

  return { forward, dropped };
}

/**
 * Catat nama cookie yang datang dari target, supaya bisa diteruskan
 * pada permintaan berikutnya.
 *
 * Kalau target memakai nama yang sama dengan cookie panel, nama itu tidak
 * dicatat. Kalau dicatat, Set-Cookie dari target akan membuat panel
 * meneruskan cookie sesinya sendiri pada permintaan berikutnya.
 */
function noteTargetCookie(session, name) {
  if (PANEL_COOKIES.has(name)) {
    logProxy({ session: { username: '?' } }, {
      status: 409, path: '-', note: `nama cookie target bentrok dengan panel: ${name} (tidak diteruskan)`,
    });
    return false;
  }
  if (!session.proxyCookies) session.proxyCookies = new Set();
  session.proxyCookies.add(name);
  return true;
}


/**
 * CSP untuk halaman hasil proksi.
 *
 * CSP bawaan helmet memakai frame-ancestors 'none', yang membuat hasil proksi
 * tidak akan PERNAH bisa tampil di dalam iframe - termasuk iframe panel
 * sendiri. Jadi untuk route ini CSP diganti, dan CSP milik target dibuang
 * (sudah ada di RESPONSE_DROP).
 *
 * Konsekuensi yang harus disebut terbuka: panel tidak menegakkan CSP milik
 * situs tujuan, jadi halaman yang mengandalkan CSP-nya akan berjalan lebih
 * longgar di sini. Yang membatasi kebocoran bukan header ini, tapi pilihan
 * asal untuk iframe.
 */
const PROXY_CSP = [
  "frame-ancestors 'self'",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval' data: blob:",
  "style-src 'self' 'unsafe-inline' data:",
  "img-src * data: blob:",
  "font-src * data:",
  "connect-src *",
  "media-src *",
  "frame-src *",
  "object-src 'none'",
].join('; ');

const RESPONSE_DROP = new Set([
  'connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'trailer',
  'content-encoding', 'content-length',
  // Tiga baris di bawah inilah yang menyuruh browser tidak menaruh halaman
  // tujuan di dalam iframe. Karena halaman ini memang harus ditampilkan di
  // dalam iframe, tiga aturan itu justru harus dibuang.
  'content-security-policy', 'content-security-policy-report-only',
  'x-frame-options', 'x-content-type-options',
]);

/** Header yang hanya valid untuk permintaan bergaya CONNECT, bukan HTTP biasa. */
const isHtml = (type = '') => /^text\/html|^application\/xhtml/i.test(type);


/* ------------------------------------------------------------------ url */

/**
 * Bentuk path proksi untuk sebuah URL absolut.
 *
 * Semua aset halaman tujuan harus dipetakan ulang ke dalam prefix proksi,
 * karena browser menyelesaikan URL relatif terhadap asal panel. Prefix-nya
 * membawa session id, jadi dua tab yang membuka target berbeda tidak saling
 * menimpa.
 */
/**
 * Path proksi. Skema ikut di dalam path, bukan di query.
 *
 * Alasannya: aset halaman diambil browser sebagai URL yang DITULIS ULANG oleh
 * rewriteHtml, dan penulisan itu tidak pernah menyertakan query string. Kalau
 * host, port, dan skema hanya ada di query, setiap aset akan datang tanpa
 * mereka dan ditolak dengan "host tujuan tidak valid".
 */
function proxyPath(sessionId, target, path = '/') {
  const scheme = target.secure ? 'https' : 'http';
  return `/api/proxy/${encodeURIComponent(sessionId)}/${scheme}`
    + `/${encodeURIComponent(target.host)}/${target.port}`
    + `${path.startsWith('/') ? path : `/${path}`}`;
}

/**
 * URL lengkap untuk prefix proksi, termasuk query.
 *
 * Bentuk path saja (proxyPath) cukup untuk <base>, tapi TIDAK cukup untuk
 * Location: route proksi membaca host/port dari query, jadi redirect yang
 * hanya mengembalikan path akan mendarat di 400 dan seluruh halaman di dalam
 * iframe rusak begitu saja.
 */
function proxyLink(sessionId, target, path = '/') {
  return `${proxyPath(sessionId, target, path)}`;
}

/** Ubah Location dari server tujuan menjadi URL proksi. */
function rewriteLocation(location, sessionId, target) {
  if (typeof location !== 'string' || !location) return location;
  try {
    // location bisa absolut (http://host:port/x) maupun path-only (/x).
    const url = new URL(location, `http://${target.host}:${target.port}`);
    return proxyLink(sessionId, target, `${url.pathname}${url.search}`);
  } catch { return location; }
}

/**
 * Set-Cookie milik server tujuan harus dibatasi ke prefix proksi.
 *
 * Tanpa ini, cookie Jenkins/ArgoCD akan ikut attaches ke origin panel dan
 * terkirim pada setiap permintaan panel - termasuk ke endpoint login.
 */
function rewriteSetCookie(cookie, sessionId, target) {
  const parts = String(cookie).split(';');
  const keep = [parts[0]];
  // SameSite, Secure, dan HttpOnly dari tujuan dipertahankan; yang diubah hanya
  // Domain dan Path supaya tidak keluar dari prefix proksi.
  for (const attr of parts.slice(1)) {
    const name = attr.split('=')[0].trim().toLowerCase();
    if (name === 'domain') continue;
    if (name === 'path') continue;
    keep.push(attr);
  }
  keep.push(`Path=${proxyPath(sessionId, target).replace(/\/[^/]*$/, '')}`);
  return keep.join(';');
}

/* --------------------------------------------------------------- helper */

/**
 * Pastikan sesi SSH milik pengguna yang sedang meminta.
 *
 * Kegagalan di sini Returning JSON mentah dulu, padahal request ini datang dari
 * iframe browser. Browser tidak menampilkan halaman error HTTP di dalam iframe,
 * jadi hasilnya layar kosong - gejala yang sama persis dengan "Jenkins tidak
 * tampil", tapi penyebabnya sama sekali berbeda. Sekarang navigasi menerima
 * HTML yang terbaca; aset tetap JSON supaya tidak merusak CSS atau skrip.
 */
function resolve(req, res, next) {
  const session = sessions.get(req.params.id);
  const nav = isNavigation(req);

  if (!session) {
    logProxy(req, { status: 404, path: '-', note: 'sesi SSH tidak ada' });
    return fail(res, req, nav, 404, 'Sesi SSH tidak ditemukan',
      'Tidak ada sesi SSH dengan id itu di panel ini.\n\n'
      + 'Penyebab yang paling sering: sesi sudah habis batas 30 menit, atau '
      + 'jendela Browser dibuka tanpa koneksi SSH.\n\n'
      + 'Buat koneksi baru lewat menu Terminal, lalu buka Browser lagi.');
  }

  if (session.userId !== req.session.userId) {
    logProxy(req, { status: 403, path: '-', note: 'sesi milik user lain' });
    return fail(res, req, nav, 403, 'Akses ditolak', 'Sesi SSH itu bukan milik akun Anda.');
  }

  if (session.closed) {
    logProxy(req, { status: 410, path: '-', note: 'sesi sudah ditutup' });
    return fail(res, req, nav, 410, 'Koneksi SSH sudah tertutup',
      'Sesi SSH untuk jendela ini sudah berakhir. Hubungkan ulang lewat Terminal.');
  }

  req.sshSession = session;
  return next();
}

/**
 * Dial ke tujuan lewat channel SSH, lalu bungkus TLS bila perlu.
 * Mengembalikan socket yang siap dipakai http.request.
 */
async function dial(session, host, port, secure) {
  const target = { host, port, secure: Boolean(secure) };
  const { stream } = await proxy.openChannel(session, target);

  const socket = target.secure ? await proxy.wrapTls(stream, host) : stream;
  // Ditandai agar http.request bisa memakai host/port yang benar tanpa
  // perlu parameter tambahan yang|National ulang.
  socket.__targetHost = host;
  socket.__targetPort = port;
  return socket;
}

/*
 * Batas waktu.
 *
 * Versi pertama memakai socket.on('data') untuk menghitung idle, dan itu
 * justru merusak: memasang listener 'data' pada sebuah stream membuatnya
 * mengalir, sehingga data bisa keluar sebelum http.request sempat memasang
 * pemanggilnya - lalu hilang tanpa jejak. Jadi di sini tidak ada listener yang
 * menyentuh aliran data sama sekali.
 *
 * Tiga lapis yang saling menutup:
 *   - connect + header : pengatur waktu di dalam Promise request
 *   - badan respons     : up.setTimeout (IncomingMessage punya ini)
 *   - channel menganggur: sweep di ssh-proxy.js
 */

/**
 * Batas waktu untuk badan respons.
 *
 * up.setTimeout() kedengarannya mudah, tapi secara internal memanggil
 * this.socket.setTimeout - dan socket di sini adalah Channel ssh2, yaitu
 * Duplex yang tidak punya metode itu. Dipanggil saja akan melempar TypeError.
 *
 * Karena itu timer dibuat sendiri, dihitung ulang tiap ada data. Aman
 * menempelkan listener 'data' ke RESPONS karena pipe() juga salah satu
 * pendengarnya: keduanya menerima potongan yang sama, bukan berebut.
 */
function guardBody(res, up, ms) {
  let timer = setTimeout(kill, ms);
  const bump = () => { clearTimeout(timer); timer = setTimeout(kill, ms); };

  function kill() {
    clearTimeout(timer);
    try { up.destroy(); } catch { /* abaikan */ }
    if (!res.writableEnded) res.end();
  }

  const stop = () => clearTimeout(timer);
  up.on('data', bump);
  up.on('end', stop);
  up.on('close', stop);
  up.on('error', stop);
  return up;
}


/* --------------------------------------------------------- rewrite HTML */

/**
 * Cuplikan singkat badan respons, untuk melihat apa yang BENAR-BENAR dikirim
 * server tujuan.
 *
 * Tanpa ini, respons target hanya tampak sebagai "403, 1054 byte, tanpa teks".
 * Itu tidak cukup untuk diagnosis: kita tidak tahu apakah target
 * mengirim halaman login, halaman bootstrap yang mengarahkan lewat JS, atau
 * challenge Captcha. Ketiganya menghasilkan baris log yang identik.
 *
 * Hanya badan kecil yang ditampilkan (2 KB), dan nilai yang terlihat seperti
 * token disamarkan - halaman login Jenkins memuat CSRF crumb, dan itu tidak
 * SHOULD ditulis ke log.
 */
function bodyPreview(text, limit = 300) {
  const masked = String(text)
    // Token panjang: base64/hex. CSRF crumb, session id, JWT.
    .replace(/[A-Za-z0-9_-]{24,}/g, (m) => `${m.slice(0, 6)}…${m.slice(-4)}`)
    .replace(/\s+/g, ' ')
    .trim();
  return masked.slice(0, limit);
}

/**
 * Catat satu permintaan proksi.
 *
 * Dulu tidak ada satu baris pun untuk permintaan halaman - hanya probe yang
 * tercatat. Akibatnya ketika UI Jenkins tidak tampil, tidak ada satu bukti pun
 * untuk dibaca: tidak tahu path apa yang diminta, status apa yang kembali,
 * apakah HTML-nya sempat ditulis ulang. Dua putaran perbaikan berlandaskan
 * tebakan karena titik buta ini.
 *
 * Ke log konsol, bukan audit: audit untuk kejadian yang perlu ditelusuri
 * afterwards, sementara ini perlu melihat apa yang SEDANG terjadi.
 */
function logProxy(req, info = {}) {
  const who = req.session ? req.session.username : '?';
  const bits = [
    `[proxy] ${who}`,
    String(info.status ?? '-').padEnd(4),
    (info.path || '/').slice(0, 72),
  ];
  if (info.bytes !== undefined) bits.push(`${info.bytes}B`);
  if (info.type) bits.push(info.type);
  if (info.note) bits.push(`| ${info.note}`);
  console.log(bits.join(' '));
}

/**
 * Balas kegagalan. Halaman navigasi dapat HTML yang terbaca; aset dapat JSON
 * supaya tidak merusak CSS atau skrip dengan isi halaman error.
 */
function fail(res, req, nav, status, title, detail) {
  if (nav) {
    return res.status(status)
      .type('text/html; charset=utf-8')
      .send(errorPage(status, title, detail));
  }
  return res.status(status).json({ error: title, detail });
}

/**
 * Tulis ulang asal target yang dikunci di dalam JS, CSS, dan teks.
 *
 * Ini bug terakhir yang membuat iframe Jenkins tetap kosong.
 *
 * Jenkins 2.5x menjawab 403 dengan halaman bootstrap nyaris tanpa teks yang
 * memuat redirect.js, dan redirect.js itu berisi URL ABSOLUT ke dirinya
 * sendiri, misalnya window.location.replace("http://localhost:8080/login").
 *
 * Penulisan ulang HTML tidak menangkap ini, karena URL-nya ada di dalam
 * berkas JavaScript, bukan di atribut markup. Akibatnya iframeRENDAH
 * navigasi ke http://localhost:8080/login - port 8080 di komputer user, yang
 * tidak ada tunnelnya - dan browser menolak sambungnya. Gejalanya iframe
 * kosong tanpa pesan sama sekali.
 *
 * Sama persis alasan tunnel dari Windows Anda berhasil: di sana
 * localhost:8080 memang Jenkins, jadi URL absolut itu benar. Di dalam iframe
 * tidak.
 *
 * Yang ditulis ulang HANYA asal target sendiri (scheme://host[:port]). Kalau
 * string literal di dalam skrip kebetulan memuat asal itu, dan itu pun
 * seharusnya ditulis ulang - tujuan navigasinya memang target. Yang tidak
 * disentuh asal lain, dan tidak ada string yang bisa cocok dua kali karena
 * prefix hasil ganti tidak memuat skema.
 */
function rewriteOrigin(body, origin, prefix) {
  if (!body.includes(origin)) return { body, hits: 0 };

  // Panjang berbeda karena hasil ganti lebih panjang dari yang diganti, jadi
  // dihitung dari occurrence asal, bukan per indeks karakter.
  const parts = body.split(origin);
  return { body: parts.join(prefix), hits: parts.length - 1 };
}

/**
 * Semua ejaan asal yang menunjuk layanan yang sama.
 *
 * Kalau target diketik sebagai 127.0.0.1, Jenkins tetap boleh membalas dengan
 * "localhost:8080" di redirect.js-nya - bukan karena nakal, tapi karena ia
 * memakai nama yang dipilihkan sendiri. Kalau hanya asal yang diketik yang
 * ditulis ulang, URL itu lolos dan iframe mendarat di port 8080 komputer user,
 * yang tidak ada tunnelnya: iframe kosong tanpa pesan.
 *
 * Ejaan lain yang tidak loopback sengaja TIDAK ikut. 127.0.0.2:8080 bukan
 * layanan yang sama, dan menimpanya akan mengirim permintaan ke tempat lain.
 */
function originVariants(host, port) {
  const variants = new Set([`${host}:${port}`]);
  const loopback = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
  if (loopback.has(String(host).toLowerCase())) {
    variants.add(`localhost:${port}`);
    variants.add(`127.0.0.1:${port}`);
  }
  return [...variants];
}

/**
 * Content-type yang badannya aman ditulis ulang.
 *
 * Biner (gambar, font, arsip) dilewati: tidak ada URL di dalamnya, dan
 * menanganinya sebagai string hanya berisiko merusak berkas.
 */
const TEXTUAL = /^(?:text\/|application\/(?:json|javascript|x-javascript|ecmascript|xml|xhtml))/i;

/**
 * Ambil pesan yang bisa dibaca dari badan error upstream.
 *
 * Tanpa ini, upstream menjawab 403 dan panel hanya mencatat "403" - angka yang
 * tidak_ISI_mengatakan apa pun. Jenkins, ArgoCD, dan nginxmasing-masing punya halaman
 * error yang menjelaskan sebabnya dalam beberapa baris teks, dan itu justru
 * yang dibutuhkan untuk memperbaiki masalahnya.
 *
 * Yang diambil hanya isi elemen pesan/judul yang umum dipakai. Label dan nilai
 * atribut dibuang supaya token atau kredensial yang kebetulan ada di halaman
 * error tidak ikut bocor ke log.
 */
function errorPreview(html, limit = 260) {
  const picked = [];

  const byTag = /<(h1|h2|h3|title|strong|p|div)[^>]*>([\s\S]{1,400}?)<\/\1>/gi;
  let m;
  while ((m = byTag.exec(html)) !== null) {
    const text = m[2]
      .replace(/<[^>]+>/g, ' ')
      .replace(/&[a-z]+;|&#\d+;/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (text.length > 8 && !/^(Jenkins|Loading|Access Denied)$/i.test(text)) picked.push(text);
    if (picked.join(' | ').length > limit) break;
  }

  const out = picked.join(' | ').slice(0, limit);
  return out || '(tidak ada teks pesan yang bisa dibaca)';
}

/**
 * Halaman error yang bisa dibaca manusia.
 *
 * Kegagalan proksi tadinya dibalas JSON apa adanya. Di dalam iframe JSON itu
 * tampil sebagai teks mentah di atas latar kosong - praktis tidak ada
 * informasinya. Browser tidak menampilkan halaman error HTTP untuk respons
 * 4xx/5xx di dalam iframe, jadi tampilannya benar-benar kosong.
 *
 * nowarn mode: kalau permintaan ini hanya aset (Accept tidak navigator),
 * JSON tetap lebih tepat dan lebih murah.
 */
function errorPage(status, title, detail) {
  const esc = (t) => String(t).replace(/[&<>]/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]
  ));

  return `<!DOCTYPE html><html lang="id"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<style>
  body { margin: 0; padding: 2.5rem 1.5rem; background: #1b1d21; color: #d8dade;
         font: 15px/1.6 system-ui, -apple-system, "Segoe UI", sans-serif; }
  main { max-width: 34rem; margin: 0 auto; }
  h1 { font-size: 1.25rem; margin: 0 0 .25rem; color: #f2f3f5; }
  .kode { font: 600 12px/1 ui-monospace, monospace; color: #e0a458;
          letter-spacing: .08em; text-transform: uppercase; }
  p { margin: 0 0 1rem; color: #a8adb8; }
  pre { background: #131518; border: 1px solid #2a2d34; border-radius: 8px;
        padding: .9rem 1rem; overflow: auto; color: #cfd3da;
        font: 13px/1.55 ui-monospace, SFMono-Regular, Menlo, monospace;
        white-space: pre-wrap; word-break: break-word; }
  footer { margin-top: 1.5rem; font-size: 13px; color: #6f757f; }
</style></head><body><main>
<p class="kode">${esc(status)}</p>
<h1>${esc(title)}</h1>
<pre>${esc(detail)}</pre>
<footer>Halaman ini dilayani panel, bukan situs tujuan.</footer>
</main></body></html>`;
}

/**
 * Apakah ini navigasi halaman, atau aset?
 *
 * Aset tidak boleh dibalas HTML - stylesheet yang isinya halaman error akan
 * ditolak dengan pesan yang jauh lebih membingungkan daripada 502 biasa.
 */
function isNavigation(req) {
  const accept = String(req.headers.accept || '');
  if (req.method !== 'GET') return false;
  return /text\/html|application\/xhtml/i.test(accept) || accept === '';
}

/**
 * Tulis ulang URL absolut supaya tetap tinggal di dalam prefix proksi.
 *
 * Kenapa perlu: <base> HANYA memengaruhi URL relatif. URL yang dimulai dengan
 * "/" diabaikan <base> dan selalu memakai asal halaman - sehingga
 * <script src="/static/foo.js"></script> akan meminta ke origin panel, yang
 * jelas tidak punya /static. Jenkins memakai /static/ dan /adjuncts/ di
 * seluruh halamannya, jadi tanpa langkah ini halamannya tampil tanpa CSS dan
 * JS sama sekali.
 *
 * Dua kesalahan yang sudah pernah terjadi di sini dan dijaga oleh tes:
 *   - Atribut pada TAG PEMBUKA <script src="..."> ikut dianggap "isi skrip"
 *     dan dilewati, padahal yang harus dilewati hanya isi di dalam tag.
 *   - <base> sendiri ikut ditulis ulang dua kali, karena setelah disisipkan ia
 *     juga berbentuk href="/...".
 *
 * Isi <script>, <style>, <textarea>, dan <title> dilewati. String literal di
 * dalam skrip yang ditulis ulang akan merusak halaman secara diam-diam.
 *
 * Batas 8 MB: di atas itu dokumen dikirim apa adanya, lebih baik iframe rusak
 * daripada menahan respons besar di memori tanpa henti.
 */
const MAX_REWRITE_BYTES = 8 * 1024 * 1024;

/**
 * Daerah raw text: dari ujung tag pembuka sampai awal tag penutup.
 * @returns {Array<[number, number]>}
 */
function rawRegions(html) {
  const regions = [];
  const scanner = /<\/?(?:script|style|textarea|title|noscript)\b[^>]*>/gi;
  let open = null;
  let match;

  while ((match = scanner.exec(html)) !== null) {
    if (match[0].startsWith('</')) {
      if (open !== null) {
        regions.push([open, match.index]);
        open = null;
      }
    } else if (open === null) {
      // Tag pembuka sendiri BUKAN raw: atributnya justru yang perlu ditulis.
      open = match.index + match[0].length;
    }
  }
  // Tag pembuka tanpa penutup (HTML rusak): anggap sisa dokumen sebagai raw.
  if (open !== null) regions.push([open, html.length]);

  return regions;
}

function rewriteHtml(html, prefix) {
  if (html.length > MAX_REWRITE_BYTES) return html;

  const regions = rawRegions(html);
  const inRaw = (i) => regions.some(([from, to]) => i >= from && i < to);

  // prefix TIDAK berakhir dengan garis miring. Nilai atribut yang ditulis ulang
  // selalu dimulai dengan "/", jadi menambahkannya di sini akan menghasilkan
  // "//" di setiap URL.
  const base = prefix.endsWith('/') ? prefix.slice(0, -1) : prefix;
  const already = (value) => value.startsWith(base) || value.startsWith('/api/proxy/');

  // Atribut yang isinya URL. Daftar ini sengaja tidak lengkap: menebak
  // atribut lain berisiko merusak skrip, dan satu aset gagal jauh lebih mudah
  // dilihat daripada seluruh JavaScript yang rusak.
  //
  // Catatan: \2 di pola ini adalah BACKREFERENCE, bukan grup ke-4. Menulis
  // ulang dengan ${match[4]} menghasilkan "undefined" di setiap URL - itu
  // sempat terjadi dan sekarang dijaga oleh tes.
  // data-* yang memuat URL ikut ditulis ulang. Jenkins memakai pola ini:
  // <script id="redirect" data-redirect-url="/login?from=%2F"> lalu redirect.js
  // membaca dataset.redirectUrl dan memanggil window.location.replace().
  // Tanpa penulisan ulang di sini, URL relatif itu diselesaikan terhadap asal
  // PANEL, bukan terhadap proksi - jadi tidak pernah sampai ke target, dan
  // halaman bootstrap 403 berputar tanpa pernah memuat /login.
  //
  // Fixture lama memakai origin absolut di dalam redirect.js sehingga lolos,
  // padahal Jenkins sungguhan memakai atribut data-*. Itu sebabnya seluruh
  // suite hijau sementara Jenkins tidak bisa dibuka.
  const ATTR = /\b(href|src|srcset|action|poster|formaction|xlink:href|background|data-[\w-]*(?:url|href|src))\s*=\s*("|')(\/(?!\/)[^"']*)\2/gi;

  let out = '';
  let last = 0;
  let m;
  ATTR.lastIndex = 0;

  while ((m = ATTR.exec(html)) !== null) {
    if (inRaw(m.index)) continue;
    if (already(m[3])) continue;

    out += html.slice(last, m.index);

    // srcset berisi daftar kandidat yang dipisah koma ("/a.png 1x, /b.png 2x"),
    // dan setiap kandidat harus dipisah sendiri. Kalau hanya yang pertama
    // yang ditulis ulang, gambar resolusi 2x tetap menunjuk ke origin panel.
    const value = m[1] === 'srcset'
      ? m[3].split(',').map((part) => {
        const trimmed = part.trim();
        if (!trimmed.startsWith('/') || already(trimmed)) return part;
        return part.replace(trimmed, `${base}${trimmed}`);
      }).join(', ')
      : `${base}${m[3]}`;

    out += `${m[1]}=${m[2]}${value}${m[2]}`;
    last = m.index + m[0].length;
  }
  out += html.slice(last);

  // <meta http-equiv="refresh" content="0;URL=/login">.
  //
  // Ini BUKAN salah satu atribut yang ada di daftar di atas - isinya bukan
  // URL langsung, melainkan "delay;URL=alamat" - jadi harus dealt secara
  // terpisah. Halaman bootstrap 403 milik Jenkins memakai pola ini, jadi tanpa
  // ini refresh-nya akan melompat ke asal panel atau ke asal kosong.
  out = out.replace(
    /(\bcontent\s*=\s*["']\s*\d+\s*;\s*url\s*=\s*)(["']?)(\/(?!\/)[^"'\s]*)\2/gi,
    (all, head, quote, url) => {
      if (already(url)) return all;
      return `${head}${quote}${base}${url}${quote}`;
    },
  );

  // Meta refresh dengan URL ABSOLUT, misalnya content="0;URL=http://localhost:8080/login".
  //
  // <base> tidak berlaku untuk URL seperti ini, sama seperti tidak berlaku
  // untuk atribut URL lain. Ditangani terpisah dari pola di atas supaya
  // cakupannya sempit: hanya isi meta refresh, bukan seluruh dokumen.
  out = out.replace(
    /(\bcontent\s*=\s*["']\s*\d+\s*;\s*url\s*=\s*)(["']?)(https?:\/\/[^/"'\s]+)(\/[^"'\s]*)?\2/gi,
    // originPart dibuang: prefix proksi SUDAH memuat skema, host, dan port.
    // Mempertahannya menghasilkan prefix ganda seperti
    // ".../8080http://localhost:8080/login" - yang sudah terjadi sekali di sini.
    (all, head, quote, originPart, rest = '') => `${head}${quote}${base}${rest}${quote}`,
  );

  // url(/...) di dalam CSS inline, style="...", dan stylesheet yang
  // di-embed sebagai <style>.
  // Penutup kutip harus dikembalikan apa adanya. Kalau hanya kutip pembuka
  // yang ikut tangkap lalu tidak ditulis balik, hasilnya url("/PX/a.png) -
  // CSS rusak dan penyebabnya jauh dari tempatnya.
  out = out.replace(/url\(\s*(['"]?)(\/(?!\/)[^)'"\s]*)(['"]?)\s*\)/gi,
    (all, openQuote, path, closeQuote) => {
      if (already(path)) return all;
      return `url(${openQuote}${base}${path}${closeQuote})`;
    });

  return out;
}

/* --------------------------------------------------------------- request */

/**
 * @param {boolean} secure  true = tujuan HTTPS
 * @param {object} extraHeaders  header tambahan, mis. cookie milik target
 */
function fetchThroughSsh(session, host, port, path, secure, method = 'GET', extraHeaders = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    dial(session, host, port, secure).then((socket) => {
      const req = http.request({
        // host/port WAJIB ada walau socket-nya sudah jadi. Tanpa keduanya,
        // http.request tidak punya header Host dan tidak tahu harus
        // mengirim ke mana - dan permintaannya menggantung tanpa respons.
        host: socket.__targetHost,
        port: socket.__targetPort,
        createConnection: () => socket,
        method,
        path,
        headers: {
          host: `${host}:${port}`,
          accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
          'user-agent': 'ssh-vps-panel-proxy',
          connection: 'close',
          ...extraHeaders,
        },
        setHost: false,
      });

      const timer = setTimeout(() => {
        req.destroy(new Error('Waktu habis menunggu server tujuan.'));
      }, CONNECT_TIMEOUT_MS);

      req.on('response', (res) => {
        clearTimeout(timer);
        resolvePromise(res);
      });
      req.on('error', (err) => {
        clearTimeout(timer);
        rejectPromise(err);
      });
      req.end();
    }, rejectPromise);
  });
}

/* ---------------------------------------------------------------- routes */

/** Daftar target yang bisa dibuka, untuk UI. */
router.get('/:id/targets', requireAuth, resolve, (req, res) => {
  const saved = JSON.parse(req.session.proxyBookmarks || '[]');
  res.json({ targets: Array.isArray(saved) ? saved : [] });
});

/** Cek apakah target bisa dijangkau, sebelum iframe dicoba. */
router.get('/:id/probe', requireAuth, resolve, async (req, res) => {
  let target;
  try {
    target = proxy.validateTarget(req.query.host, req.query.port);
  } catch (err) {
    return res.status(err.status || 400).json({ error: err.message });
  }

  const secure = req.query.secure === '1' || req.query.secure === 'true';
  try {
    const up = await fetchThroughSsh(req.sshSession, target.host, target.port, '/', secure);
    const server = up.headers.server || '';
    guardBody(res, up, IDLE_TIMEOUT_MS);
    up.resume();
    // Probe juga harus JUJUR soal status. Versi ini melapor "berhasil" untuk
    // 403 juga, karena yang dicek hanya sambungan - dan itu membuat saya
    // dua kali menyatakan ke user bahwa Jenkins dapat dihubungi, padahal yang
    // dikembalikan adalah 403.
    const statusCode = up.statusCode || 0;
    const usable = statusCode >= 200 && statusCode < 400;
    logProxy(req, {
      status: statusCode,
      path: '/',
      type: 'probe',
      note: `${target.host}:${target.port} -> ${server || '?'} | ${usable ? 'siap' : 'DITOLAK oleh target, bukan masalah sambungan'}`,
    });
    audit.record('proxy.probe', `${target.host}:${target.port}`, undefined, {
      userId: req.session.userId, username: req.session.username,
    });
    /**
     * ok = "target bisa dihubungi", BUKAN "target mau melayani Anda".
     *
     * Jenkins default menjawab 403 untuk anonymously, dan itu jawaban yang
     * wajar - bukan kegagalan jaringan. Kalau ok selalu true, panel
     * bilang "siap" lalu iframe menampilkan 403 kosong, dan user tidak pernah
     * diberi tahu apa yang sebenarnya terjadi.
     */
    const hint = !usable
      ? (statusCode === 401 || statusCode === 403
        ? 'Login dulu di aplikasi ini, lalu buka lagi. Jenkins/ArgoCD menolak '
          + 'permintaan anonymously dengan ' + statusCode + '.'
        : `Server tujuan menjawab ${statusCode}.`)
      : null;

    return res.json({
      ok: usable,
      usable,
      hint,
      host: target.host,
      port: target.port,
      secure,
      status: statusCode,
      server,
    });
  } catch (err) {
    return res.status(502).json({ error: err.message });
  }
});

/**
 * The main event: streaming the destination page into an iframe.
 *
 * Query:
 *   host, port, secure=1, path
 */
router.get('/:id/*', requireAuth, resolve, async (req, res) => {
  const wild = req.params[0] || '/';
  const nav = isNavigation(req);

  /**
   * Bentuk path yang diminta browser: "<scheme>/<host>/<port>/<path>".
   *
   * Query hanya dipakai untuk navigasi manual (klik pertama / Address bar),
   * karena aset hasil rewrite tidak punya query sama sekali - dan kalau host
   * hanya ada di query, setiap aset datang tanpanya lalu ditolak.
   */
  const segments = wild.split('/').filter(Boolean);
  const fromPath = segments.length >= 3 && ['http', 'https'].includes(segments[0])
    ? { secure: segments[0] === 'https', host: segments[1], port: segments[2] }
    : null;

  const picked = fromPath
    || { host: req.query.host, port: req.query.port, secure: req.query.secure === '1' };

  let target;
  try {
    target = proxy.validateTarget(picked.host, picked.port);
  } catch (err) {
    const status = err.status || 400;
    logProxy(req, { status, path: '/', note: `target tidak valid: ${err.message}` });
    return fail(res, req, nav, status, 'Target tidak valid', err.message);
  }

  const secure = Boolean(picked.secure);

  /**
   * Path yang benar-benar diminta ke server tujuan.
   *
   * Wildcard sudah memuat "<scheme>/<host>/<port>" sebagai tiga segmen
   * pertama, jadi ketiganya harus dilepas. Kalau tidak, Jenkins menerima
   * "/localhost/8080/static/foo.js" dan menjawab 404.
   */
  const skip = fromPath ? 3 : 0;
  const wanted = segments.length > skip
    ? `/${segments.slice(skip).join('/')}`
    : (typeof req.query.path === 'string' && req.query.path ? req.query.path : '/');

  // Prefix proksi. Dipakai untuk menyaring cookie dan untuk <base>.
  const prefix = proxyPath(req.params.id, { ...target, secure }).replace(/\/$/, '');

  /**
   * Cookie target diteruskan, cookie panel dibuang.
   *
   * Yang boleh hanya cookie yang namanya sudah tercatat di sesi ini - yaitu
   * cookie yang target benar-benar kirimkan lewat Set-Cookie sebelumnya.
   */
  const sent = forwardCookies(req.headers.cookie, req.sshSession.proxyCookies);
  const extraHeaders = sent.forward.length ? { cookie: sent.forward.join('; ') } : {};

  let up;
  try {
    up = await fetchThroughSsh(
      req.sshSession, target.host, target.port, wanted, secure, 'GET', extraHeaders,
    );
  } catch (err) {
    logProxy(req, { status: 502, path: wanted, note: err.message });
    return fail(res, req, nav, 502, 'Tidak bisa menjangkau target',
      `${target.host}:${target.port}\n\n${err.message}`);
  }

  // Lokasi di dalam iframe harus tetap di prefix proksi.
  if (up.headers.location) {
    const to = rewriteLocation(up.headers.location, req.params.id, { ...target, secure });
    logProxy(req, { status: 302, path: wanted, note: `redirect -> ${to}` });
    up.resume();
    return res.redirect(302, to);
  }

  const contentType = String(up.headers['content-type'] || '');
  guardBody(res, up, IDLE_TIMEOUT_MS);

  for (const [name, value] of Object.entries(up.headers)) {
    const key = name.toLowerCase();
    if (RESPONSE_DROP.has(key)) continue;
    if (key === 'set-cookie') continue;
    if (key === 'location') continue;
    res.setHeader(name, value);
  }

  const cookies = up.headers['set-cookie'];
  if (cookies) {
    const list = Array.isArray(cookies) ? cookies : [cookies];
    for (const cookie of list) {
      const name = String(cookie).split('=')[0].trim();
      if (noteTargetCookie(req.sshSession, name)) {
        res.append('Set-Cookie', rewriteSetCookie(cookie, req.params.id, { ...target, secure }));
      }
    }
  }

  /**
   * Aset.
   *
   * HTML punya jalurnya sendiri (di bawah). Untuk JS, CSS, dan teks, asal
   * target yang terkunci di dalam badan ikut ditulis ulang - tanpa itu
   * redirect.js milik Jenkins mengarahkan iframe ke port 8080 di komputer user
   * dan iframe jadi kosong tanpa pesan.
   *
   * Biner diteruskan apa adanya: tidak ada URL di dalam gambar atau font, dan
   * memperlakukannya sebagai teks hanya menambah risiko tanpa manfaat.
   */
  if (!isHtml(contentType)) {
    if (!TEXTUAL.test(contentType)) {
      let bytes = 0;
      up.on('data', (chunk) => { bytes += chunk.length; });
      up.on('end', () => logProxy(req, {
        status: up.statusCode || 200, path: wanted, bytes, type: contentType.slice(0, 40),
      }));
      res.status(up.statusCode || 200);
      up.pipe(res);
      return undefined;
    }

    // Status WAJIB disalin sebelum badan dikirim. Versi pertama memakai
    // up.pipe(res) yang otomatis meneruskannya; setelah badan dikumpulkan untuk
    // ditulis ulang, res.end() sendirinya TIDAK membawa status - sehingga
    // setiap aset yang dibalas 404 oleh target ikut terkirim sebagai 200.
    res.status(up.statusCode || 200);

    const scheme = secure ? 'https' : 'http';
    const origins = originVariants(target.host, target.port)
      .map((h) => `${scheme}://${h}`);
    const chunks = [];
    let size = 0;

    up.on('data', (chunk) => { chunks.push(chunk); size += chunk.length; });
    up.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let body = raw;
      let hits = 0;
      for (const origin of origins) {
        const step = rewriteOrigin(body, origin, prefix);
        body = step.body;
        hits += step.hits;
      }

      // Panjang badan bisa berubah karena rewrite, jadi content-length
      // upstream tidak boleh diteruskan. RESPONSE_DROP sudah membuangnya.
      logProxy(req, {
        status: up.statusCode || 200,
        path: wanted,
        bytes: Buffer.byteLength(body),
        type: contentType.slice(0, 40),
        note: hits
          ? `asal ditulis ulang ${hits}x (${origins.join(', ')}) -> prefix proksi`
          : `asal tidak ditemukan${raw.length <= 2048 ? ` | isi: ${bodyPreview(raw)}` : ''}`,
      });
      return res.end(Buffer.from(body, 'utf8'));
    });
    up.on('error', () => res.end());

    return undefined;
  }

  res.status(up.statusCode || 200);
  res.setHeader('content-type', contentType);
  res.setHeader('content-security-policy', PROXY_CSP);

  /**
   * Dokumen dikumpulkan utuh, ditulis ulang, lalu dikirim.
   *
   * Dulu ini dialirkan per-chunk dengan harapan "cari <head> di awal". Itu
   * rusak untuk dua alasan: penulisan ulang butuh dokumen utuh - bukan
   * potongan yang bisa terpotong di tengah atribut - dan server yang
   * mengirim halaman besar dengan chunk pertama yang kecil membuat responsnya
   * menahan-nahan tanpa menghasilkan apa pun.
   */
  const chunks = [];
  let size = 0;
  let overflow = false;

  up.on('data', (chunk) => {
    if (overflow) return void res.write(chunk);
    chunks.push(chunk);
    size += chunk.length;
    if (size > MAX_REWRITE_BYTES) {
      // Terlalu besar: kirim apa adanya. Iframe yang rusak lebih baik
      // daripada menahan respons sebesar ini di memori tanpa batas.
      overflow = true;
      res.write(Buffer.concat(chunks));
      chunks.length = 0;
    }
  });

  up.on('end', () => {
    if (overflow) {
      logProxy(req, { status: up.statusCode || 200, path: wanted, bytes: size, note: 'melewati batas rewrite' });
      return res.end();
    }

    // Disimpan sebelum ditulis ulang: cuplikan untuk log harus menunjukkan
    // apa yang benar-benar dikirim target, bukan hasil transformasi kita.
    // Versi pertama memakai `raw` - nama yang hanya ada di cabang aset - dan
    // ReferenceError itu mematikan seluruh route proksi.
    const original = Buffer.concat(chunks).toString('utf8');
    let html = original;
    const hadHead = /<head[^>]*>/i.test(html);
    const hadBase = /<base\b/i.test(html);

    if (hadHead && !hadBase) html = html.replace(/<head([^>]*)>/i, `<head$1><base href="${prefix}/">`);
    html = rewriteHtml(html, prefix);

    const status = up.statusCode || 200;
    logProxy(req, {
      status,
      path: wanted,
      bytes: Buffer.byteLength(html),
      type: 'html',
      // Status >= 400 dicatat lengkap dengan pesan dari halaman error tujuan.
      // Angka saja tidak pernah cukup untuk memperbaiki apa pun.
      note: status >= 400
        ? `head=${hadHead} base-inject=${hadHead && !hadBase} rewrite=ya | pesan: ${errorPreview(html)}`
          + (original.length <= 2048 ? ` | isi: ${bodyPreview(original)}` : '')
        : `head=${hadHead} base-inject=${hadHead && !hadBase} rewrite=ya`,
    });
    return res.end(Buffer.from(html, 'utf8'));
  });

  up.on('error', (err) => {
    if (overflow) return res.end();
    logProxy(req, { status: 502, path: wanted, note: `galat saat membaca badan: ${err.message}` });
    return res.end(rewriteHtml(Buffer.concat(chunks).toString('utf8'), prefix));
  });

  return undefined;
});

module.exports = router;
module.exports.rewriteLocation = rewriteLocation;
module.exports.proxyLink = proxyLink;
module.exports.rewriteSetCookie = rewriteSetCookie;
module.exports.REQUEST_DROP = REQUEST_DROP;
module.exports.RESPONSE_DROP = RESPONSE_DROP;
module.exports.fetchThroughSsh = fetchThroughSsh;
module.exports.isHtml = isHtml;
module.exports.rewriteHtml = rewriteHtml;
module.exports.rawRegions = rawRegions;
module.exports.forwardCookies = forwardCookies;
module.exports.noteTargetCookie = noteTargetCookie;
module.exports.PANEL_COOKIES = PANEL_COOKIES;
module.exports.errorPage = errorPage;
module.exports.isNavigation = isNavigation;
module.exports.errorPreview = errorPreview;
module.exports.bodyPreview = bodyPreview;
module.exports.rewriteOrigin = rewriteOrigin;
module.exports.originVariants = originVariants;
module.exports.TEXTUAL = TEXTUAL;