'use strict';

const http = require('http');
const { WebSocketServer } = require('ws');
const signature = require('cookie-signature');

const app = require('./app');
const config = require('./config');
const sessions = require('./lib/sessions');
const users = require('./lib/user-store');
const { migrated } = require('./app');
const { DEFAULT_TAB } = require('./lib/ssh-manager');

const MAX_FRAME_BYTES = 64 * 1024;
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES });

/**
 * Verifikasi cookie sesi saat handshake websocket.
 * Cookie `panel.sid` berupa "s:<nilai>.<tanda-tangan>"; tanda tangannya
 * dilepas dengan SESSION_SECRET sebelum dipakai sebagai kunci store.
 */
async function authenticateUpgrade(req) {
  const store = app.get('sessionStore');

  const raw = (req.headers.cookie || '')
    .split(';')
    .map((pair) => pair.trim().split('='))
    .filter((parts) => parts.length === 2)
    .map(([k, ...v]) => [k, decodeURIComponent(v.join('='))])
    .find(([name]) => name === 'panel.sid');

  if (!raw) return null;

  const sid = raw[1].startsWith('s:')
    ? signature.unsign(raw[1].slice(2), config.SESSION_SECRET)
    : false;
  if (sid === false) return null;

  // Semua store express-session berbasis callback (MemoryStore, redis, ...).
  const session = await new Promise((resolve) => {
    try {
      store.get(sid, (err, value) => resolve(err ? null : value));
    } catch (err) {
      console.error('[ws] store.get gagal:', err.message);
      resolve(null);
    }
  });

  if (!session?.authenticated) return null;

  // Status akun dicek ulang dari store, bukan diambil apa adanya dari cookie
  // sesi. Cookie bertahan berjam-jam setelah admin dinonaktifkan atau
  // diturunkan perannya, jadi mengandalkannya akan menyisakan lubang di
  // handshake websocket yang tidak bisa ditutup oleh permintaan PATCH biasa.
  const fresh = users.findById(session.userId);
  if (!fresh || fresh.disabled) return null;

  return { userId: fresh.id, username: fresh.username, role: fresh.role };
}

/**
 * Upgrade yang ditolak harus dibalas dengan respons HTTP yang lengkap.
 * `socket.destroy()` saja membuat client melihat "socket hang up" tanpa
 * kode status, sehingga tidak bisa membedakan 401 dari kegagalan jaringan.
 */
function rejectUpgrade(socket, status, statusText) {
  socket.end(
    `HTTP/1.1 ${status} ${statusText}\r\n`
    + 'Connection: close\r\n'
    + 'Content-Type: text/plain; charset=utf-8\r\n'
    + 'Content-Length: 0\r\n'
    + 'X-Content-Type-Options: nosniff\r\n'
    + '\r\n',
  );
}

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://localhost');

  if (!url.pathname.startsWith('/ws/term')) {
    return rejectUpgrade(socket, 404, 'Not Found');
  }

  // Format: /ws/term/:sessionId/:tabId
  const parts = url.pathname.split('/').filter(Boolean);

  authenticateUpgrade(req)
    .then((auth) => {
      if (!auth) {
        rejectUpgrade(socket, 401, 'Unauthorized');
        return;
      }

      // Kepemilikan diperiksa SEBELUM upgrade, bukan sesudahnya. Kalau
      // ditolak setelah WebSocket sudah Accepted, user tetap bisa memastikan
      // socket-nya terbuka dan harus menunggu frame error; lebih baik
      // tolak dengan 403 yang sama seperti yang dilakukan resolveSession di
      // jalur HTTP.
      const session = sessions.get(parts[2]);
      if (!session || session.userId !== auth.userId || session.closed) {
        rejectUpgrade(socket, 403, 'Forbidden');
        return;
      }

      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit('connection', ws, req, auth, url);
      });
    })
    .catch((err) => {
      console.error('[ws] gagal autentikasi handshake:', err.message);
      rejectUpgrade(socket, 500, 'Internal Server Error');
    });

  return undefined;
});

wss.on('connection', (ws, req, auth, url) => {
  const parts = url.pathname.split('/').filter(Boolean); // ['ws','term',id,tabId?]
  const session = sessions.get(parts[2]);
  const tabId = parts[3] || DEFAULT_TAB;

  // Diperiksa lagi di sini. Pemeriksaan di handler 'upgrade' sudah menolak
  // lebih dulu, jadi cabang ini praktis tak terjangkau; ia tetap ada karena
  // satu jalur yang bisa dilewati saja sudah cukup untuk membuka terminal
  // orang lain.
  if (!session || session.userId !== auth.userId || session.closed) {
    ws.send(JSON.stringify({ type: 'error', message: 'Sesi SSH tidak tersedia.' }));
    return ws.close();
  }

  // Tab yang sudah ditutup (mis. lewat tombol Close) tidak boleh dihidupkan
  // lagi hanya karena ada browser yang men reconnect.
  if (!session.terminals.has(tabId)) {
    ws.send(JSON.stringify({ type: 'error', message: 'Terminal sudah ditutup.' }));
    return ws.close();
  }

  const terminal = session.terminals.get(tabId);
  if (terminal.closed) {
    ws.send(JSON.stringify({ type: 'error', message: 'Shell sudah selesai.' }));
    return ws.close();
  }

  terminal.sockets.add(ws);
  session.lastActivity = Date.now();

  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.send(JSON.stringify({ type: 'ready', cols: 80, rows: 24, tabId }));

  ws.on('message', (buffer, isBinary) => {
    if (isBinary) return ws.close(1003, 'Binary tidak didukung');

    let msg;
    try {
      msg = JSON.parse(buffer.toString('utf8'));
    } catch {
      return ws.close(1007, 'Payload bukan JSON valid');
    }

    session.lastActivity = Date.now();

    if (msg.type === 'input') {
      if (typeof msg.data !== 'string') return;
      try {
        terminal.stream.write(msg.data);
      } catch { /* stream tertutup mendadak */ }
    } else if (msg.type === 'resize') {
      const cols = Number.parseInt(msg.cols, 10);
      const rows = Number.parseInt(msg.rows, 10);
      if (Number.isInteger(cols) && Number.isInteger(rows)) {
        try {
          terminal.stream.setWindow(rows, cols, 0, 0);
        } catch { /* abaikan */ }
      }
    } else if (msg.type === 'ping') {
      ws.send(JSON.stringify({ type: 'pong', t: msg.t }));
    }
  });

  ws.on('close', () => {
    terminal.sockets.delete(ws);
    if (terminal.sockets.size === 0) session.lastActivity = Date.now();
  });

  ws.on('error', () => {
    terminal.sockets.delete(ws);
    if (terminal.sockets.size === 0) session.lastActivity = Date.now();
  });
});

// Deteksi koneksi-half-open (mis. koneksi terputus tanpa TCP FIN).
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    try { ws.ping(); } catch { /* abaikan */ }
  }
}, 30_000);
heartbeat.unref();

server.listen(config.PORT, config.HOST, () => {
  const account = users.summary();

  console.log(
    [
      '',
      '  SSH VPS Panel aktif',
      `  -> alamat    : http://localhost:${config.PORT}`,
      `  -> akun      : ${account.active} aktif (${account.admins} admin) dari ${account.total}`,
      `  -> batas     : ${config.MAX_SESSIONS_PER_USER} sesi SSH / ${config.SSH_TTL_MINUTES} menit`,
      // Password hanya ditampilkan di log saat akun pertama kali dibuat dari
      // .env. Setelah itu user digeser lewat UI, jadi menampilkannya di
      // sini tidak akan pernah benar dan hanya menambah risiko.
      migrated
        ? `  -> password  : ${config.ADMIN_PASS}  (hanya ditampilkan sekali, ganti lewat UI)`
        : '',
      '',
    ].filter(Boolean).join('\n'),
  );
});

function shutdown(signal) {
  console.log(`\n${signal} diterima, menutup server...`);
  clearInterval(heartbeat);
  for (const client of wss.clients) client.close(1001, 'Server shutting down');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// Menelan exception lalu melanjutkan akan menyisakan proses dalam keadaan tidak
// terdefinisi (kegagalan fatal seperti EADDRINUSE menyisakan proses zombie
// yang tidak melayani apa pun). Keluar saja agar masalahnya jelas.
process.on('uncaughtException', (err) => {
  console.error('[uncaught] keluar:', err.message);
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason instanceof Error ? reason.message : reason);
});

module.exports = { server, wss };