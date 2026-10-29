/**
 * Pembungkus seluruh panggilan API panel.
 *
 * Sengaja tidak memakai async IIFE: kalau factory-nya async, hasilnya Promise
 * sehingga api.login dan anggota lainnya undefined.
 */
function makeApi() {
  async function request(method, path, body, opts = {}) {
    const res = await fetch(path, {
      method,
      headers: {
        ...(body !== undefined && !(body instanceof Blob) ? { 'Content-Type': 'application/json' } : {}),
        ...(opts.headers || {}),
      },
      body: body instanceof Blob ? body
        : (body !== undefined ? JSON.stringify(body) : undefined),
      credentials: 'same-origin',
    });

    if (res.status === 204) return null;

    const type = res.headers.get('content-type') || '';
    const payload = type.includes('json') ? await res.json().catch(() => null) : null;

    if (!res.ok) {
      const err = new Error(payload?.error || `Permintaan gagal (${res.status}).`);
      err.status = res.status;
      throw err;
    }
    return payload;
  }

  // Bentuk URL harus persis sama dengan yang didaftarkan di server/routes/ssh.js,
  // yaitu /api/ssh/<nama-endpoint>/:id - bukan /api/ssh/:id/<nama-endpoint>.
  const seg = (endpoint, sessionId) => `/api/ssh/${endpoint}/${encodeURIComponent(sessionId)}`;

  return {
    // auth
    session: () => request('GET', '/api/auth/session'),
    login: (username, password) => request('POST', '/api/auth/login', { username, password }),
    logout: () => request('POST', '/api/auth/logout'),

    // sesi
    listSessions: () => request('GET', '/api/ssh/sessions'),
    connect: (target) => request('POST', '/api/ssh/connect', target),
    validateKey: (payload) => request('POST', '/api/ssh/validate-key', payload),
    disconnect: (sessionId) => request('POST', seg('disconnect', sessionId)),

    // terminal
    openTab: (sessionId, tabId, size) => request('POST', seg('tabs', sessionId), { tabId, ...size }),
    closeTab: (sessionId, tabId) => request('DELETE', `${seg('tabs', sessionId)}/${encodeURIComponent(tabId)}`),
    resize: (sessionId, size, tabId) => request('POST', seg('resize', sessionId), { ...size, tabId }),

    // sistem
    metrics: (sessionId) => request('GET', seg('metrics', sessionId)),
    processes: (sessionId) => request('GET', seg('processes', sessionId)),
    diskUsage: (sessionId, p = '/') => request('GET', `${seg('diskusage', sessionId)}?path=${encodeURIComponent(p)}`),

    // file system
    listFiles: (sessionId, p) => request('GET', `${seg('files', sessionId)}?path=${encodeURIComponent(p)}`),
    mkdir: (sessionId, p) => request('POST', seg('mkdir', sessionId), { path: p }),
    rename: (sessionId, from, to) => request('POST', seg('rename', sessionId), { from, to }),
    remove: (sessionId, p) => request('DELETE', `${seg('files', sessionId)}?path=${encodeURIComponent(p)}`),
    readFile: (sessionId, p) => request('GET', `${seg('file', sessionId)}?path=${encodeURIComponent(p)}`),
    writeFile: (sessionId, p, content) => request('PUT', seg('file', sessionId), { path: p, content }),

    // transfer
    downloadUrl: (sessionId, p) => `${seg('download', sessionId)}?path=${encodeURIComponent(p)}`,
    upload: (sessionId, dir, name, blob) => request(
      'POST',
      `${seg('upload', sessionId)}?path=${encodeURIComponent(dir)}`,
      blob,
      { headers: { 'Content-Type': 'application/octet-stream', 'X-File-Name': name } },
    ),

    audit: (limit = 100) => request('GET', `/api/ssh/audit?limit=${limit}`),

    // Akun panel (bukan akun VPS). Semua di /api/users hanya untuk admin;
    // server menolak selain admin, jadi sisi klien tidak perlu menebak.
    listUsers: () => request('GET', '/api/users'),
    createUser: (payload) => request('POST', '/api/users', payload),
    updateUser: (id, patch) => request('PATCH', `/api/users/${encodeURIComponent(id)}`, patch),
    setUserPassword: (id, password) => request(
      'PUT', `/api/users/${encodeURIComponent(id)}/password`, { password },
    ),
    deleteUser: (id) => request('DELETE', `/api/users/${encodeURIComponent(id)}`),
    revokeUser: (id) => request('POST', `/api/users/${encodeURIComponent(id)}/revoke`),

    /**
     * Laporkan error JavaScript ke server.
     *
     * Tanpa ini, kegagalan di klien buta: server melihat login 200 dan semua
     * endpoint berikutnya 200, sementara halamannya diam. Endpoint ini
     * sengaja TIDAK melempar kalau gagal - melapor error harus tidak mungkin
     * menambah masalah baru.
     */
    /**
     * Tandai tahap boot yang sudah dilalui di peramban.
     *
     * Tanpa ini, "login berhasil tapi layar tidak berubah" mustahilEnsure
     * diagnosis: server melihat 200, dan peramban tidak melapor apa pun.
     * Penanda ini membuat alurnya terlihat dari sisi server.
     */
    clientEvent: (phase, detail = '') => {
      try {
        const body = JSON.stringify({ phase, detail });
        if (navigator.sendBeacon) {
          navigator.sendBeacon('/api/auth/client-event', new Blob([body], { type: 'application/json' }));
          return null;
        }
        return request('POST', '/api/auth/client-event', { phase, detail }).catch(() => null);
      } catch { return null; }
    },

    reportClientError: (detail) => {
      try {
        const body = JSON.stringify(detail);
        // fetch + keepalive supaya laporan tetap terkirim walau halaman
        // sedang dimuat ulang.
        if (navigator.sendBeacon) {
          navigator.sendBeacon('/api/auth/client-error', new Blob([body], { type: 'application/json' }));
          return null;
        }
        return request('POST', '/api/auth/client-error', detail).catch(() => null);
      } catch { return null; }
    },

    changeOwnPassword: (currentPassword, newPassword) => request(
      'POST', '/api/auth/password', { currentPassword, newPassword },
    ),
  };
}

export const api = makeApi();

/** Alamat WebSocket terminal untuk satu tab. */
export function terminalUrl(sessionId, tabId) {
  const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${protocol}://${location.host}/ws/term/${encodeURIComponent(sessionId)}/${encodeURIComponent(tabId)}`;
}