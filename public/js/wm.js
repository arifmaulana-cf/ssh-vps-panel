import { el, contextMenu } from './ui.js';
import { Tiling, regionFor } from './tiling.js';

/**
 * Window manager GNOME-flavored: drag, resize, min/max/close, integrasi dock,
 * Activities overview, dan split screen ala Windows.
 *
 * Posisi jendela dihitung manual (bukan mengandalkan CSS) supaya bisa
 * dibatasi di area kerja, dan supaya overview bisa menskalakan jendela
 * sungguhan menjadi pratinjau.
 */

/**
 * Pointer capture dibungkus karena tidak selalu bisa dipanggil. Browser
 * melempar NotFoundError kalau pointer sudah tidak aktif - jari sudah terangkat
 * atau elemennya dilepas - dan kegagalannya tidak boleh menggagalkan drag-nya
 * sendiri. Versi yang dibungkus sekaligus membuat WM tetap bisa diuji di
 * lingkungan yang tidak menyediakan API ini.
 */
function capture(node, pointerId) {
  try { node.setPointerCapture?.(pointerId); } catch { /* biarkan */ }
}

export class WindowManager {
  constructor({ workspace, onChange }) {
    this.workspace = workspace;
    this.onChange = onChange;
    this.windows = new Map();
    this.zTop = 10;
    this.cascade = 0;
    this._overviewOpen = false;

    this.titleTarget = null;   // elemen yang menampilkan judul jendela aktif
    this.onFocusChange = null;  // dipanggil tiap fokus berpindah (menu bar)
    this.overview = null;      // { overlay, grid }

    // Split screen. Modulnya terpisah supaya wm.js tidak jadi file yang
    // isinya dua masalah berbeda; WM hanya meneruskan aksi.
    this.tiling = new Tiling({
      workspace: this.workspace,
      onChange: () => this.notify(),
    });
    this.tiling.setRegistry((id) => this.windows.get(id));
  }

  get count() { return this.windows.size; }

  /**
   * Jendela yang benar-benar terfokus, yaitu yang punya z-index tertinggi.
   *
   * Semula ini mengambil entri terakhir dari Map, dan itu salah: Map ter
   * urutkan berdasarkan urutan DIBUAT, sedangkan fokus ditentukan oleh
   * z-index. Begitu user memfokuskan jendela lama, Alt+F4 akan menutup
   * jendela yang lain.
   */
  focusedWindow() {
    const alive = [...this.windows.values()].filter((w) => !w.disposed && !w.minimized);
    if (!alive.length) return null;

    return alive.reduce((best, win) => {
      const a = Number.parseInt(win.node.style.zIndex || '0', 10);
      const b = Number.parseInt(best.node.style.zIndex || '0', 10);
      return a > b ? win : best;
    });
  }

  /**
   * z-index jendela naik terus setiap kali difokuskan. Kalau dibiarkan,
   * angkanya tumbuh tanpa batas; sekarang dihitung ulang berkala agar tetap
   * di bawah lapisan shell (yang mulai dari 1).
   */
  raiseZ() {
    if (this.zTop > 9000) {
      let index = 20;
      // Diurutkan berdasarkan z-index sekarang supaya yang paling depan tetap paling depan.
      const ordered = [...this.windows.values()].sort((a, b) => {
        const za = Number.parseInt(a.node.style.zIndex || '0', 10);
        const zb = Number.parseInt(b.node.style.zIndex || '0', 10);
        return za - zb;
      });
      for (const win of ordered) win.node.style.zIndex = String(index += 1);
      this.zTop = index;
      return;
    }
    this.zTop += 1;
    return this.zTop;
  }

  notify() { this.onChange?.(); }

  /**
   * @param {object} spec
   * @param {string} spec.key     identitas unik (jika ada jendela untuk key ini,
   *                              jendela lama difokuskan, bukan dibuat dua kali)
   * @param {string} spec.title
   * @param {string} spec.icon
   * @param {number} [spec.width] @param {number} [spec.height]
   * @param {boolean} [spec.resizable]
   * @param {Function} spec.onMount  dipanggil dengan (body, win)
   * @param {Function} [spec.onClose]
   * @param {boolean} [spec.unique]  true = fokuskan bila sudah terbuka
   */
  open(spec) {
    // `this.windows` di-key oleh id internal ("terminal-3"), bukan spec.key,
    // jadi pencarian keunikan harus membandingkan properti key tiap jendela.
    if (spec.unique && spec.key) {
      for (const existing of this.windows.values()) {
        if (existing.key !== spec.key) continue;
        if (existing.minimized) existing.restore();
        else existing.focus();
        return existing;
      }
    }

    const id = `${spec.key || 'win'}-${++this.cascade}`;
    const body = el('div', { class: 'win-body' });

    const title = el('span', { class: 'win-title', text: spec.title });

    // Fungsi dideklarasikan terpisah lalu dipanggil sebagai metode window, jadi
    // `this` di dalamnya adalah objek window. Keduanya butuh manager untuk
    // mengakses z-index global dan daftar semua jendela.
    function focus() {
      if (this.disposed) return;
      if (this.minimized) this.restore();

      this.node.style.zIndex = String(this.manager.raiseZ());

      for (const other of this.manager.windows.values()) {
        other.node.classList.toggle('is-active', other === this);
        other.node.classList.toggle('is-inactive', other !== this);
      }

      if (this.manager.titleTarget) {
        this.manager.titleTarget.textContent = this.titleEl.textContent;
      }

      // Notifikasi fokus berpindah dipisah dari onChange.
      //
      // notify() dipakai untuk "daftar jendela berubah" (dock), dan
      // rebuild dock setiap kali user klik jendela berarti membuat ulang
      // seluruh isi dock tiap klik - terasa berat. Yang dibutuhkan di sini
      // cuma menubar, jadi jalurnya dipisah.
      this.manager.onFocusChange?.(this);

      this.node.focus({ preventScroll: true });
    }

    function minimize() {
      this.minimized = true;
      this.node.classList.add('is-minimized');
      this.manager.notify();
    }

    function restore() {
      this.minimized = false;
      this.node.classList.remove('is-minimized');
      this.focus();
      this.manager.notify();
    }

    /**
     * Memperbesar jendela, apa pun kondisinya.
     *
     * Dipisahkan dari toggleMaximize karena dua pemanggil punya makna
     * berbeda: tombol Perbesar pada jendela bertiles berarti "lepas dari
     * petak" (meniru GNOME), sementara Super+Atas berarti memperbesar
     * sungguhan, seperti di Windows.
     */
    function maximize() {
      if (this.maximized) return;

      if (this.manager.tiling.isTiled(this)) this.manager.tiling.float(this);

      this.prevBox = {
        left: this.node.style.left, top: this.node.style.top,
        width: this.node.style.width, height: this.node.style.height,
      };
      Object.assign(this.node.style, { left: '0px', top: '0px', width: '100%', height: '100%' });
      this.node.classList.add('is-maximized');
      this.maximized = true;
      this.snapped = null;
      this.node.dispatchEvent(new CustomEvent('win:resize'));
    }

    /** Perkecil lagi ke kotak sebelum diperbesar. */
    function restoreDown() {
      if (!this.maximized) return false;
      this.maximized = false;
      Object.assign(this.node.style, this.prevBox || { left: '40px', top: '40px' });
      this.node.classList.remove('is-maximized');
      this.node.dispatchEvent(new CustomEvent('win:resize'));
      return true;
    }

    function toggleMaximize() {
      // Jendela yang sedang di petak tidak punya konsep maximize: dia sudah
      // menempel di grid, jadi maximize berarti melepasnya kembali ke bebas.
      if (this.manager.tiling.isTiled(this)) {
        this.manager.tiling.float(this);
        return;
      }

      this.maximized = !this.maximized;
      if (this.maximized) {
        this.prevBox = {
          left: this.node.style.left, top: this.node.style.top,
          width: this.node.style.width, height: this.node.style.height,
        };
        Object.assign(this.node.style, { left: '0px', top: '0px', width: '100%', height: '100%' });
        this.node.classList.add('is-maximized');
      } else {
        // Kalau sebelumnya di-snap ke setengah, kembalikan ke kotak yang
        // tersimpan sebelum jendela diperbesar.
        Object.assign(this.node.style, this.prevBox || { left: '40px', top: '40px' });
        this.node.classList.remove('is-maximized');
      }
      this.snapped = null;
      this.node.dispatchEvent(new CustomEvent('win:resize'));
    }

    function close() {
      if (this.disposed) return;
      this.disposed = true;
      this.onClose?.();
      this._unbindFocus?.();
      this.manager.tiling.destroy(this);
      this.node.remove();
      this.manager.windows.delete(this.id);
      this.manager.notify();
      // Beri fokus ke jendela yang tersisa supaya tidak ada yang "yatim".
      const rest = [...this.manager.windows.values()];
      (rest[rest.length - 1] || rest[0])?.focus();
    }

    // GNOME: tombol jendela dibulatkan, gambarannya pakai ::after (tanpa ikon SVG).
    const btnMin = this.chromeButton('Perkecil', () => win.minimize());
    const btnMax = this.chromeButton('Perbesar', () => win.toggleMaximize());
    const btnClose = this.chromeButton('Tutup', () => win.close());

    // Windows 11: arahkan kursor ke tombol Perbesar dan pilihannya muncul.
    // Klik biasa tetap maximize/restore, jadi pintasan lama tidak rusak.
    btnMax.title = 'Perbesar (Super+Atas) - tahan untuk pilih tata letak';
    let hoverTimer = null;
    btnMax.addEventListener('pointerenter', () => {
      hoverTimer = setTimeout(() => {
        if (!win.disposed) this.tiling.showLayoutPicker(win, btnMax);
      }, 420);
    });
    const cancelHover = () => { clearTimeout(hoverTimer); hoverTimer = null; };
    btnMax.addEventListener('pointerleave', cancelHover);
    btnMax.addEventListener('pointerdown', cancelHover);

    const bar = el('div', { class: 'win-bar' },
      el('span', { class: 'win-icon', html: spec.icon || '' }),
      title,
      el('div', { class: 'win-controls' }, btnMin, btnMax, btnClose),
    );

    const node = el('div', { class: 'win is-inactive', tabindex: '-1' }, bar, body);
    // appId ikut ke DOM sebagai data-*. Dipakai untuk hook CSS per aplikasi
    // dan untuk menghitung invarian "aplikasi mana yang sedang jalan" dari
    // sisi klien tanpa harus menyimpan objek jendela.
    node.dataset.appId = spec.appId || '';
    node.style.width = `${spec.width || 900}px`;
    node.style.height = `${spec.height || 560}px`;

    const win = {
      id,
      key: spec.key,
      appId: spec.appId,
      // Sesi SSH yang menampilkannya, atau null untuk aplikasi shell.
      // Desktop.js memakainya untuk ikut menutup jendela ketika sesinya
      // diputus dari luar.
      sessionId: spec.sessionId || null,
      manager: this,
      node,
      body,
      titleEl: title,
      minimized: false,
      maximized: false,
      disposed: false,
      onClose: spec.onClose,
      setTitle: (value) => {
        title.textContent = value;
        if (this.manager.titleTarget && this.node.classList.contains('is-active')) {
          this.manager.titleTarget.textContent = value;
        }
      },
      focus, minimize, restore, maximize, restoreDown, toggleMaximize, close,
    };

    this.windows.set(id, win);
    this.workspace.append(node);
    this.place(node, spec);
    this.bindDrag(win, bar);
    if (spec.resizable !== false) this.bindResize(win, node);
    this.bindFocus(win);
    this.notify();

    node.addEventListener('pointerdown', () => win.focus(), true);
    win.focus();
    spec.onMount?.(body, win);

    return win;
  }

  /**
 * Tombol jendela ala GNOME: bundar, tanpa teks (gambarannya dari ::after CSS).
 * Urutan penting: minimize, maximize, close.
 */
chromeButton(label, onClick) {
  return el('button', { class: 'win-btn', type: 'button', title: label, 'aria-label': label, onClick });
}

  /** Posisi awal: bertingkat agar jendela tidak menutupi semuanya. */
  place(node, spec) {
    const area = this.workspace.getBoundingClientRect();
    const w = node.offsetWidth || spec.width || 900;
    const h = node.offsetHeight || spec.height || 560;
    const step = 26;
    const max = Math.max(0, Math.floor((area.width - w - 40) / step));

    const left = Math.min(24 + (this.cascade % (max || 1)) * step, Math.max(8, area.width - w - 8));
    const top = Math.min(18 + (this.cascade % 6) * step, Math.max(8, area.height - h - 8));

    node.style.left = `${Math.max(8, left)}px`;
    node.style.top = `${Math.max(8, top)}px`;
  }

  bindFocus(win) {
    const handler = () => win.focus();
    win.node.addEventListener('pointerdown', handler, true);
    win._unbindFocus = () => win.node.removeEventListener('pointerdown', handler, true);
  }

  // GNOME tidak punya taskbar; daftar jendela hidup ditangani dock (desktop.js)
  // dan Activities overview, jadi WM tidak membuat tombol sendiri.

  /* ==================================================== Activities overview */

  /**
   * @param {{overlay: HTMLElement, empty: HTMLElement}} refs
   * Scrim berada di dalam workspace dengan z-index di bawah jendela, jadi
   * yang tampil sebagai pratinjau adalah jendela sunggulan yang di-scale.
   * Tidak ada kartu tiruan: jendela itu sendiri yang diklik.
   */
  setOverview(refs) {
    this.overview = refs;
    refs.overlay.addEventListener('click', (event) => {
      if (!event.target.closest('.win')) this.exitOverview();
    });
  }

  get overviewOpen() { return Boolean(this._overviewOpen); }

  toggleOverview() {
    if (this.overviewOpen) this.exitOverview();
    else this.enterOverview();
  }

  enterOverview() {
    const wins = [...this.windows.values()].filter((w) => !w.disposed);
    if (!this.overview) return;

    this._overviewOpen = true;
    this.overview.overlay.hidden = false;
    this.overview.empty.hidden = wins.length > 0;

    this._overviewRestore = new Map();
    for (const win of wins) {
      this._overviewRestore.set(win.id, {
        left: win.node.style.left, top: win.node.style.top,
        transform: win.node.style.transform,
      });
    }

    const area = this.workspace.getBoundingClientRect();
    const cols = Math.ceil(Math.sqrt(wins.length));
    const rows = Math.ceil(wins.length / cols);
    const cellW = area.width / cols;
    const cellH = (area.height - 40) / rows;

    wins.forEach((win, i) => {
      const col = i % cols;
      const row = Math.floor(i / cols);
      const scale = Math.min(cellW / (win.node.offsetWidth + 40), cellH / (win.node.offsetHeight + 40), 0.5);

      const targetX = col * cellW + (cellW - win.node.offsetWidth * scale) / 2;
      const targetY = row * cellH + 24;

      win.node.classList.add('is-overview');
      win.node.style.transformOrigin = 'top left';
      win.node.style.transform =
        `translate(${targetX - win.node.offsetLeft}px, ${targetY - win.node.offsetTop}px) scale(${scale})`;

      const click = (event) => {
        event.stopPropagation();
        this.exitOverview();
        win.restore();
        win.focus();
      };
      win.node.addEventListener('click', click, true);
      win._overviewClick = click;
    });
  }

  exitOverview() {
    if (!this._overviewOpen) return;
    this._overviewOpen = false;

    for (const win of this.windows.values()) {
      win.node.classList.remove('is-overview');
      if (win._overviewClick) {
        win.node.removeEventListener('click', win._overviewClick, true);
        win._overviewClick = null;
      }
      const saved = this._overviewRestore?.get(win.id);
      if (saved) Object.assign(win.node.style, saved);
    }

    this._overviewRestore = null;
    if (this.overview) this.overview.overlay.hidden = true;
  }

  // ---------------------------------------------------------------- drag
  bindDrag(win, handle) {
    let ghost = null;

    const hideGhost = () => { ghost?.remove(); ghost = null; };

    /**
     * Pratinjau kotak tujuan. Region yang tidak bisa jadi petak (maximize)
     * digambar sebagai petak penuh; sisanya mengikuti grid yang AKAN berlaku
     * sesudah Lepas, supaya yang terlihat persis dengan hasilnya.
     */
    const boxFor = (region) => {
      const area = this.workspace.getBoundingClientRect();
      if (region === 'top') {
        return { left: 0, top: 0, width: area.width, height: area.height };
      }
      const cell = this.tiling.previewFor(region);
      if (cell) return this.tiling.boxFor(cell);
      return null;
    };

    const showGhost = (region) => {
      const box = boxFor(region);
      if (!box) return hideGhost();

      if (!ghost) {
        ghost = el('div', { class: 'snap-ghost' });
        this.workspace.append(ghost);
      }
      Object.assign(ghost.style, {
        left: `${box.left}px`, top: `${box.top}px`,
        width: `${box.width}px`, height: `${box.height}px`,
      });
    };

    handle.addEventListener('pointerdown', (event) => {
      if (event.target.closest('.win-btn')) return;

      const area = this.workspace.getBoundingClientRect();

      // Menyeret jendela yang sedang di petak berarti melepasnya: begitu juga
      // Windows. Kalau tidak, jendela akan ikut "nempel" sambil bergerak dan
      // pratinjau petaknya tidak pernah hilang.
      if (this.tiling.isTiled(win)) this.tiling.float(win);

      // Menyeret jendela maximized harus melepasnya lebih dulu, persis seperti
      // Windows dan GNOME. Tanpa ini satu-satunya jalan snap dari layar penuh
      // adalah pintasan papan tik - dan siapa pun yang mengira harus bisa
      // seret judulnya akan mengira fiturnya rusak.
      if (win.maximized) {
        const back = win.prevBox || { left: '40px', top: '40px' };
        Object.assign(win.node.style, back);
        win.node.classList.remove('is-maximized');
        win.maximized = false;
        win.node.dispatchEvent(new CustomEvent('win:resize'));

        // Jendela yang baru dilepas diletakkan di bawah kursor, bukan melompat
        // ke pojok tempat ia terakhir berada. Kalau tidak, drag berikutnya
        // melompat karena pointer sudah jauh dari kotak yang baru dilepas.
        const w = win.node.offsetWidth;
        const h = win.node.offsetHeight;
        const grabX = event.clientX - area.left - w / 2;
        const grabY = event.clientY - area.top - 16;
        win.node.style.left = `${Math.max(0, Math.min(grabX, area.width - w))}px`;
        win.node.style.top = `${Math.max(0, Math.min(grabY, area.height - 32))}px`;
      }

      const startX = event.clientX;
      const startY = event.clientY;
      const startLeft = win.node.offsetLeft;
      const startTop = win.node.offsetTop;
      let snapped = null;

      capture(handle, event.pointerId);
      handle.classList.add('is-dragging');

      const move = (e) => {
        const maxLeft = Math.max(0, area.width - win.node.offsetWidth);
        const maxTop = Math.max(0, area.height - 32);
        const left = Math.min(Math.max(startLeft + (e.clientX - startX), -win.node.offsetWidth + 80), maxLeft);
        const top = Math.min(Math.max(startTop + (e.clientY - startY), 0), maxTop);
        win.node.style.left = `${left}px`;
        win.node.style.top = `${top}px`;

        snapped = regionFor(win, area, e.clientX, e.clientY);
        if (snapped) showGhost(snapped);
        else hideGhost();
      };

      const up = () => {
        handle.classList.remove('is-dragging');
        handle.removeEventListener('pointermove', move);
        handle.removeEventListener('pointerup', up);
        handle.removeEventListener('pointercancel', up);
        hideGhost();

        if (!snapped) return;
        // Region 'top' = maximize, bukan petak; itu satu-satunya yang tidak
        // masuk ke tiling.
        if (snapped === 'top') {
          win.toggleMaximize();
          return;
        }
        this.tiling.snap(win, snapped);
      };

      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', up);
      handle.addEventListener('pointercancel', up);
    });

    handle.addEventListener('dblclick', (event) => {
      if (!event.target.closest('.win-btn')) win.toggleMaximize();
    });

    // Klik kanan pada title bar.|Windows 11 hanya punya snap lewat drag dan
    //_win_+panah, jadi orang yang tidak tahu pintasannya tidak punya jalan
    // masuk sama sekali. Menu ini providing jalan ketiga.
    handle.addEventListener('contextmenu', (event) => {
      if (event.target.closest('.win-btn')) return;
      event.preventDefault();
      event.stopPropagation();

      const tiling = this.tiling;
      const wasTiled = tiling.isTiled(win);

      contextMenu(event, [
        { label: 'Layar penuh', onSelect: () => win.toggleMaximize() },
        { label: 'Kiri', onSelect: () => tiling.snap(win, 'left') },
        { label: 'Kanan', onSelect: () => tiling.snap(win, 'right') },
        { label: 'Atas', onSelect: () => tiling.snap(win, 'top') },
        { label: 'Bawah', onSelect: () => tiling.snap(win, 'bottom') },
        '-',
        { label: 'Kiri atas', onSelect: () => tiling.snap(win, 'tl') },
        { label: 'Kanan atas', onSelect: () => tiling.snap(win, 'tr') },
        { label: 'Kiri bawah', onSelect: () => tiling.snap(win, 'bl') },
        { label: 'Kanan bawah', onSelect: () => tiling.snap(win, 'br') },
        '-',
        { label: 'Pilih tata letak', onSelect: () => tiling.showLayoutPicker(win, handle) },
        {
          label: 'Lepas dari petak',
          disabled: !wasTiled,
          onSelect: () => tiling.float(win),
        },
      ]);
    });
  }

  // -------------------------------------------------------------- resize
  bindResize(win, node) {
    const dirs = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'];
    for (const dir of dirs) {
      const handle = el('div', { class: `rs rs-${dir}` });
      node.append(handle);

      handle.addEventListener('pointerdown', (event) => {
        event.stopPropagation();
        if (win.maximized) return;
        // Ukuran jendela bertiles milik grid, bukan milik pemakai. Handle-nya
        // disembunyikan lewat CSS, tapi dicek juga di sini supaya tidak ada
        // jalur tersembunyi yang tetap bisa mengubah ukuran.
        if (this.tiling.isTiled(win)) return;

        const start = {
          x: event.clientX, y: event.clientY,
          left: node.offsetLeft, top: node.offsetTop,
          width: node.offsetWidth, height: node.offsetHeight,
        };
        const area = this.workspace.getBoundingClientRect();

        capture(handle, event.pointerId);
        node.classList.add('is-resizing');

        const move = (e) => {
          const dx = e.clientX - start.x;
          const dy = e.clientY - start.y;
          let { left, top, width, height } = start;

          if (dir.includes('e')) width = Math.max(280, start.width + dx);
          if (dir.includes('s')) height = Math.max(180, start.height + dy);
          if (dir.includes('w')) {
            width = Math.max(280, start.width - dx);
            left = start.left + (start.width - width);
          }
          if (dir.includes('n')) {
            height = Math.max(180, start.height - dy);
            top = start.top + (start.height - height);
          }

          if (left < 0) { width += left; left = 0; }
          if (top < 0) { height += top; top = 0; }
          if (left + width > area.width) width = area.width - left;
          if (top + height > area.height) height = area.height - top;

          Object.assign(node.style, { left: `${left}px`, top: `${top}px`, width: `${width}px`, height: `${height}px` });
          node.dispatchEvent(new CustomEvent('win:resize'));
        };

        const up = () => {
          node.classList.remove('is-resizing');
          handle.removeEventListener('pointermove', move);
          handle.removeEventListener('pointerup', up);
          handle.removeEventListener('pointercancel', up);
        };

        handle.addEventListener('pointermove', move);
        handle.addEventListener('pointerup', up);
        handle.addEventListener('pointercancel', up);
      });
    }
  }
}