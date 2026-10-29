import { api, terminalUrl } from '../api.js';
import { icons } from '../icons.js';
import { el, toast } from '../ui.js';

/** Satu tab = satu channel shell pada koneksi SSH yang sama. */
class TerminalTab {
  constructor({ tabId, session, onExit, onStatus }) {
    this.tabId = tabId;
    this.session = session;
    this.onExit = onExit;
    this.onStatus = onStatus;
    this.socket = null;
    this.disposed = false;
    this.term = null;
    this.fit = null;
    this.retry = null;
    this.fontSize = 15;
  }

  mount(container) {
    this.container = container;

    this.term = new window.Terminal({
      fontFamily: '"JetBrains Mono", "SFMono-Regular", Menlo, Consolas, monospace',
      fontSize: this.fontSize,
      // Palet terminal mengikuti tema aktif, jadi mengganti tema langsung
      // terasa juga di dalam shell.
      theme: window.PanelThemes.current().terminal,
      cursorBlink: true,
      scrollback: 8000,
      allowProposedApi: true,
    });
    this.fit = new window.FitAddon.FitAddon();
    this.term.loadAddon(this.fit);
    this.term.open(container);

    this.term.onData((data) => this.send({ type: 'input', data }));
    this.term.onResize(({ cols, rows }) => this.send({ type: 'resize', cols, rows }));

    this.container.addEventListener('mousedown', () => this.term.focus());

    // Tab yang sudah terbuka ikut berubah tema tanpa perlu dibuat ulang.
    this.onThemeChange = (event) => {
      try { this.term.options.theme = event.detail.terminal; } catch { /* abaikan */ }
    };
    document.addEventListener('themechange', this.onThemeChange);

    this.connect();
  }

  send(message) {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(message));
    }
  }

  connect() {
    if (this.disposed) return;
    this.socket = new WebSocket(terminalUrl(this.session.id, this.tabId));

    this.socket.addEventListener('open', () => this.onStatus?.(true));

    this.socket.addEventListener('message', (event) => {
      let msg;
      try { msg = JSON.parse(event.data); } catch { return; }

      if (msg.type === 'data') this.term.write(msg.data);
      else if (msg.type === 'ready') { this.fitNow(); this.term.focus(); }
      else if (msg.type === 'exit') {
        this.term.write(`\r\n\x1b[33m[${msg.reason || `shell selesai${msg.code != null ? ` (kode ${msg.code})` : ''}`}]\x1b[0m\r\n`);
        this.onStatus?.(false);
        this.onExit?.(this);
      } else if (msg.type === 'error') {
        this.term.write(`\r\n\x1b[31m[${msg.message}]\x1b[0m\r\n`);
        this.onStatus?.(false);
      }
    });

    this.socket.addEventListener('close', () => {
      this.onStatus?.(false);
      if (this.disposed || this.dead) return;
      this.term.write('\r\n\x1b[90m[terputus - menyambung ulang]\x1b[0m\r\n');
      this.retry = setTimeout(() => this.connect(), 3000);
    });

    this.socket.addEventListener('error', () => this.onStatus?.(false));
  }

  fitNow() {
    requestAnimationFrame(() => {
      if (this.disposed || !this.container.isConnected) return;
      try {
        this.fit.fit();
        this.send({ type: 'resize', cols: this.term.cols, rows: this.term.rows });
      } catch { /* elemen belum terukur */ }
    });
  }

  setFontSize(size) {
    this.fontSize = size;
    if (this.term) this.term.options.fontSize = size;
    this.fitNow();
  }

  focus() { this.term?.focus(); this.fitNow(); }
  write(text) { this.term?.write(text); }
  clear() { this.term?.clear(); }

  dispose() {
    this.disposed = true;
    clearTimeout(this.retry);
    if (this.onThemeChange) document.removeEventListener('themechange', this.onThemeChange);
    try { this.socket?.close(); } catch { /* abaikan */ }
    this.term?.dispose();
  }
}

export const terminalApp = {
  id: 'terminal',
  name: 'Terminal',
  icon: icons.terminal,
  resizable: true,

  mount(body, ctx) {
    const tabs = [];
    let active = null;
    let tabSeq = 0;
    let fontSize = 15;

    const tabStrip = el('div', { class: 'term-tabs' });
    const host = el('div', { class: 'term-host' });
    const statusDot = el('span', { class: 'dot dot-off', title: 'status koneksi' });

    const sizeSelect = el('select', { class: 'select-sm', title: 'Ukuran font' },
      el('option', { value: '13', text: 'Kecil' }),
      el('option', { value: '15', selected: true, text: 'Sedang' }),
      el('option', { value: '17', text: 'Besar' }),
      el('option', { value: '20', text: 'Sangat besar' }));

    sizeSelect.addEventListener('change', () => {
      fontSize = Number.parseInt(sizeSelect.value, 10);
      tabs.forEach((t) => t.setFontSize(fontSize));
    });

    const newTabBtn = el('button', { class: 'btn btn-ghost btn-xs', type: 'button', text: '+ Tab', title: 'Buka tab shell baru' });
    const clearBtn = el('button', { class: 'btn btn-ghost btn-xs', type: 'button', text: 'Bersihkan' });

    body.append(
      el('div', { class: 'term-toolbar' },
        tabStrip,
        el('div', { class: 'term-tools' }, statusDot, sizeSelect, newTabBtn, clearBtn)),
      host,
    );

    clearBtn.addEventListener('click', () => active?.clear());
    newTabBtn.addEventListener('click', () => addTab());

    ctx.win.node.addEventListener('win:resize', () => active?.fitNow());
    window.addEventListener('resize', onWindowResize);
    ctx.registerCleanup?.(() => window.removeEventListener('resize', onWindowResize));

    function onWindowResize() {
      tabs.forEach((t) => t.fitNow());
    }

    function renderTabs() {
      tabStrip.replaceChildren();
      for (const tab of tabs) {
        const item = el('div', { class: `term-tab${tab === active ? ' is-active' : ''}` },
          el('span', { class: 'term-tab-dot', title: 'status' }),
          el('span', { class: 'term-tab-name', text: tab.tabId }),
          tabs.length > 1 && el('button', {
            class: 'term-tab-close',
            type: 'button',
            title: 'Tutup tab',
            html: '&times;',
            onClick: (e) => { e.stopPropagation(); closeTab(tab); },
          }));

        item.addEventListener('click', () => activate(tab));
        tabStrip.append(item);
        tab.dotEl = item.querySelector('.term-tab-dot');
      }
    }

    async function addTab() {
      const tabId = `t${++tabSeq}-${Date.now().toString(36).slice(-4)}`;

      // Channel shell harus dibuat lebih dulu di server, kalau tidak WebSocket
      // akan ditolak karena tab-nya belum terdaftar.
      newTabBtn.disabled = true;
      try {
        await api.openTab(ctx.session.id, tabId, { cols: 80, rows: 24 });
      } catch (err) {
        toast(`Gagal membuka tab: ${err.message}`, 'error');
        return;
      } finally {
        newTabBtn.disabled = false;
      }

      const container = el('div', { class: 'term-pane' });
      host.append(container);

      const tab = new TerminalTab({
        tabId,
        session: ctx.session,
        onStatus: (online) => tab.dotEl?.classList.toggle('dot-on', online),
        onExit: () => { tab.dead = true; },
      });

      tabs.push(tab);
      tab.mount(container);
      activate(tab);
      renderTabs();
      return tab;
    }

    function activate(tab) {
      active = tab;
      for (const other of tabs) {
        other.container.classList.toggle('is-active', other === tab);
      }
      tab.focus();
      renderTabs();
    }

    async function closeTab(tab) {
      const index = tabs.indexOf(tab);
      if (index === -1) return;

      tab.dead = true;
      tab.dispose();
      tab.container.remove();
      tabs.splice(index, 1);

      await api.closeTab(ctx.session.id, tab.tabId).catch(() => {});

      if (active === tab) activate(tabs[Math.max(0, index - 1)] || tabs[0]);
      else renderTabs();

      if (!tabs.length) {
        toast('Semua tab tertutup. Buka tab baru dengan tombol + Tab.');
      }
    }

    // Tab pertama memakai shell default yang sudah dibuat server.
    const first = new TerminalTab({
      tabId: 'main',
      session: ctx.session,
      onStatus: (online) => {
        statusDot.classList.toggle('dot-on', online);
        statusDot.classList.toggle('dot-off', !online);
      },
    });
    const firstPane = el('div', { class: 'term-pane is-active' });
    host.append(firstPane);
    tabs.push(first);
    first.mount(firstPane);
    activate(first);
    renderTabs();

    ctx.onFocus = () => active?.fitNow();

    /* --------------------------------------------------------------- menu
       Menu bar GNOME lengkap: ini yang membedakan aplikasi desktop dari
       form web di dalam iframe. Setiap butir di bawah benar-benar
       menjalankan sesuatu. */
    const FILE_ITEMS = () => [
      { label: 'Tab Baru', hint: 'Ctrl+Shift+T', onSelect: () => { addTab(); } },
      {
        label: 'Tutup Tab',
        disabled: !active || active.dead,
        onSelect: () => { if (active) closeTab(active); },
      },
      '-',
      {
        label: 'Bersihkan Layar',
        disabled: !active,
        onSelect: () => active?.term?.clear(),
      },
      '-',
      { label: 'Putuskan Sesi', danger: true, onSelect: () => ctx.disconnectSession?.(ctx.session.id) },
    ];

    const EDIT_ITEMS = () => [
      {
        label: 'Salin',
        disabled: !active,
        onSelect: () => {
          const sel = active?.term?.getSelection?.();
          if (!sel) return toast('Tidak ada teks yang dipilih.', 'warn');
          navigator.clipboard?.writeText(sel).then(
            () => toast('Disalin ke clipboard.'),
            () => toast('Tidak bisa mengakses clipboard.', 'warn'),
          );
        },
      },
      {
        label: 'Tempel',
        disabled: !active,
        onSelect: async () => {
          // xterm punya paste(data), jadi yang perlu dibaca lebih dulu adalah
          // isi clipboard - dan itu butuh izin, sehingga bisa ditolak.
          try {
            const text = await navigator.clipboard.readText();
            if (text) active.term.paste(text);
            else toast('Clipboard kosong.', 'warn');
          } catch {
            toast('Peramban menolak membaca clipboard.', 'warn');
          }
        },
      },
      '-',
      {
        label: 'Pilih Semua',
        disabled: !active,
        onSelect: () => active?.term?.selectAll?.(),
      },
    ];

    const VIEW_ITEMS = () => [
      {
        label: 'Perbesar',
        disabled: !active,
        onSelect: () => { fontSize += 1; applyFont(); },
      },
      {
        label: 'Perkecil',
        disabled: !active,
        onSelect: () => { fontSize -= 1; applyFont(); },
      },
      { label: 'Reset Ukuran', disabled: !active, onSelect: () => { fontSize = 15; applyFont(); } },
      '-',
      { label: 'Bersihkan Scrollback', disabled: !active, onSelect: () => active?.term?.clear() },
    ];

    function applyFont() {
      fontSize = Math.min(30, Math.max(9, fontSize));
      sizeSelect.value = String(fontSize);
      tabs.forEach((t) => t.setFontSize(fontSize));
      ctx.refreshMenus?.();
    }

    ctx.setMenus(() => [
      { label: 'Berkas', items: FILE_ITEMS },
      { label: 'Edit', items: EDIT_ITEMS },
      { label: 'Tampilan', items: VIEW_ITEMS },
    ]);

    ctx.registerCleanup?.(() => tabs.forEach((t) => t.dispose()));
  },
};