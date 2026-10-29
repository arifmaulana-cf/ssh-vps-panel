import { el } from './ui.js';

/**
 * Tiling ala Windows: satu jendela bisa dikunci ke petak layar, dan beberapa
 * jendela bisa mengisi layar bersamaan (split screen) dengan pembagi yang bisa
 * digeser.
 *
 * GNOME sendiri tidak punya ini tanpa ekstensi, tapi permintaannya jelas:
 * "split layar seperti di Windows". Yang diambil dari Windows adalah
 * snapped-to-edge + Aero Snap Layout; yang dipertahankan dari panel ini adalah
 * cara kerjakan jendela (header GNOME, snapping 8 arah, Activities).
 *
 * ---------------------------------------------------------------- model
 *
 * Layout disimpan sebagai batas ternormalisasi (fraksi 0..1), bukan piksel,
 * supaya tidak perlu dihitung ulang saat jendela dibuka atau workspace
 * berubah ukuran:
 *
 *   cuts.x = [0.5]        batas vertikal di tengah
 *   cuts.y = []           belum ada batas horizontal
 *   win.tile = { c, r, cs, rs }
 *
 * Petak (c, r) selebar seleurunnya. `cs`/`rs` allows satu jendela mengisi
 * beberapa baris (mis. "kiri" = 1 kolom tapi semua baris).
 */

const MIN_FRAC = 0.08;

/**
 * Katalog snap Windows 11. Nilai kiri = jumlah kolom, kanan = jumlah baris.
 * Dipakai juga untuk tombol maximize GNOME, supaya ada jalur yang bisa
 * diklik tanpa drag.
 */
export const SNAP_LAYOUTS = [
  { id: 'cols2', cols: 2, rows: 1 },
  { id: 'rows2', cols: 1, rows: 2 },
  { id: 'grid22', cols: 2, rows: 2 },
  { id: 'cols3', cols: 3, rows: 1 },
  { id: 'grid32', cols: 3, rows: 2 },
  { id: 'cols4', cols: 4, rows: 1 },
];

/** Region drag tepi -> daftar petak yang akan dipanggil. */
export function regionFor(win, area, x, y) {
  const EDGE = 24;
  const CORNER = 150;

  const near = (value, edge) => value <= edge;
  const fromLeft = x - area.left;
  const fromRight = area.right - x;
  const fromTop = y - area.top;
  const fromBottom = area.bottom - y;

  const edgeX = near(fromLeft, EDGE) ? 'left'
    : near(fromRight, EDGE) ? 'right' : null;
  const edgeY = near(fromTop, EDGE) ? 'top'
    : near(fromBottom, EDGE) ? 'bottom' : null;

  const cornerX = near(fromLeft, CORNER) ? 'left'
    : near(fromRight, CORNER) ? 'right' : null;
  const cornerY = near(fromTop, CORNER) ? 'top'
    : near(fromBottom, CORNER) ? 'bottom' : null;

  // Kuarters dicek lebih dulu. Kalau tidak, VMware yang di emulator Android
  // yang menutupi separuh monitor akan ikut ter-snap ke tengah.
  if (cornerX && cornerY) return `${cornerY === 'top' ? 't' : 'b'}${cornerX === 'left' ? 'l' : 'r'}`;
  if (edgeY) return edgeY;
  if (edgeX) return edgeX;
  return null;
}

export class Tiling {
  constructor({ workspace, onChange }) {
    this.workspace = workspace;
    this.onChange = onChange;

    this.cuts = { x: [], y: [] };
    this.cols = 1;
    this.rows = 1;

    // winId -> { c, r, cs, rs }
    this.assign = new Map();
    // winId -> kotak px terakhir sebelum masuk tiling, untuk saat dilepas.
    this.restore = new Map();

    this.dividers = el('div', { class: 'tile-dividers' });
    this.workspace.append(this.dividers);
  }

  /* ------------------------------------------------------- perhitungan petak */

  /** @returns {{x:number,y:number,w:number,h:number}} fraksi 0..1 */
  cell(c, r, cs = 1, rs = 1) {
    const x0 = c > 0 ? this.cuts.x[c - 1] : 0;
    const x1 = c + cs - 1 < this.cuts.x.length ? this.cuts.x[c + cs - 1] : 1;
    const y0 = r > 0 ? this.cuts.y[r - 1] : 0;
    const y1 = r + rs - 1 < this.cuts.y.length ? this.cuts.y[r + rs - 1] : 1;
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }

  /** Kotak dalam piksel workspace, untuk ghost dan untuk diterapkan ke DOM. */
  boxFor(cell) {
    const area = this.workspace.getBoundingClientRect();
    return {
      left: Math.round(cell.x * area.width),
      top: Math.round(cell.y * area.height),
      width: Math.round(cell.w * area.width),
      height: Math.round(cell.h * area.height),
    };
  }

  /**
   * Ubah jumlah kolom/baris. Batas dihitung ulang sama rata, karena Windows
   * juga begitu saat tata letak berubah dari 2 kolom ke 3: jendela yang sudah
   * di snapped redistribusi, bukan terjepit.
   */
  setGrid(cols, rows) {
    if (cols === this.cols && rows === this.rows) return;

    const remap = (index, count, oldCount) => (index < count ? index : oldCount - 1);

    this.assign.forEach((tile, id) => {
      const c = remap(tile.c, cols, this.cols);
      const r = remap(tile.r, rows, this.rows);
      this.assign.set(id, { ...tile, c: Math.max(0, c), r: Math.max(0, r) });
    });

    this.cols = cols;
    this.rows = rows;
    this.cuts.x = evenCuts(cols);
    this.cuts.y = evenCuts(rows);
  }

  /* --------------------------------------------------------- snapping region */

  /**
   * Petak untuk sebuah region. Mengembalikan null untuk region yang tidak bisa
   * jadi petak (mis. maximize).
   */
  tilesFor(region) {
    switch (region) {
      case 'left': return { cols: 2, rows: this.rows, cell: { c: 0, r: 0, cs: 1, rs: this.rows } };
      case 'right': return { cols: 2, rows: this.rows, cell: { c: 1, r: 0, cs: 1, rs: this.rows } };
      case 'top': return { cols: this.cols, rows: 2, cell: { c: 0, r: 0, cs: this.cols, rs: 1 } };
      case 'bottom': return { cols: this.cols, rows: 2, cell: { c: 0, r: 1, cs: this.cols, rs: 1 } };
      case 'c0': return { cols: 3, rows: this.rows, cell: { c: 0, r: 0, cs: 1, rs: this.rows } };
      case 'c1': return { cols: 3, rows: this.rows, cell: { c: 1, r: 0, cs: 1, rs: this.rows } };
      case 'c2': return { cols: 3, rows: this.rows, cell: { c: 2, r: 0, cs: 1, rs: this.rows } };
      case 'tl': return { cols: 2, rows: 2, cell: { c: 0, r: 0, cs: 1, rs: 1 } };
      case 'tr': return { cols: 2, rows: 2, cell: { c: 1, r: 0, cs: 1, rs: 1 } };
      case 'bl': return { cols: 2, rows: 2, cell: { c: 0, r: 1, cs: 1, rs: 1 } };
      case 'br': return { cols: 2, rows: 2, cell: { c: 1, r: 1, cs: 1, rs: 1 } };
      default: return null;
    }
  }

  /** Kotak pratinjau (fraksi) untuk sebuah region, atau null. */
  previewFor(region) {
    const plan = this.tilesFor(region);
    if (!plan) return null;

    // Pratinjau harus jujur soal bentuk akhirnya: kalau region butuh grid
    // 3x1 sementara sekarang 2x1, ghost tetap 1/2 bukan 1/3.
    const base = { x: [], y: [] };
    const cols = Math.max(this.cols, plan.cols);
    const rows = Math.max(this.rows, plan.rows);
    base.x = evenCuts(cols);
    base.y = evenCuts(rows);

    const saved = { cols: this.cols, rows: this.rows, x: this.cuts.x, y: this.cuts.y };
    this.cuts = base;
    this.cols = cols;
    this.rows = rows;
    const cell = this.cell(plan.cell.c, plan.cell.r, plan.cell.cs, plan.cell.rs);
    this.cols = saved.cols;
    this.rows = saved.rows;
    this.cuts = { x: saved.x, y: saved.y };

    return cell;
  }

  /* ------------------------------------------------------------------ aksi */

  /**
   * Kunci jendela ke petak. Jendela yang tadi menempati petak itu:
   *   - ditukar posisinya kalau ukurannya sama persis (kasus umum 2 jendela),
   *   - dilepas jadi jendela bebas kalau tidak, karena dua jendela tidak bisa
   *     menghuni satu petak dan "mendorong yang lain keluar" tanpa memberi
   *    tempat yang bisa diprediksi.
   */
  snap(win, region) {
    const plan = this.tilesFor(region);
    if (!plan) return false;

    const previous = this.assign.get(win.id) || null;
    this.setGrid(Math.max(this.cols, plan.cols), Math.max(this.rows, plan.rows));

    const target = plan.cell;
    const occupant = this.findOccupant(win.id, target);

    if (occupant) {
      if (previous && sameSpan(previous, target)) this.assign.set(occupant.id, previous);
      else this.float(occupant);
    }

    if (!previous) this.restore.set(win.id, boxOf(win.node));
    this.assign.set(win.id, target);

    win.snapped = region;
    win.maximized = false;
    win.node.classList.add('is-tiled');
    win.node.classList.remove('is-maximized');
    this.apply(win);
    this.renderDividers();
    this.onChange?.();
    return true;
  }

  /**
   * Jendela lain yang petaknya beririsan dengan petak tujuan.
   *
   * Mengembalikan objek jendela, bukan {id, win}. Nilai inilah yang langsung
   * diteruskan ke float() dan swap, jadi bentuknya harus sama dengan yang
   * dipakai pemanggil - kalau tidak, setiap pergantian petak meledak dengan
   * "undefined has no classList" jauh dari penyebabnya.
   */
  findOccupant(exceptId, target) {
    for (const [id, tile] of this.assign) {
      if (id === exceptId) continue;
      if (!overlaps(tile, target)) continue;

      const win = this.findWindow(id);
      if (win) return win;
      // Jendelanya sudah ditutup tapi petaknya belum dibersihkan: buang saja,
      // supaya petak tidak terkunci selamanya oleh jendela yang sudah tidak ada.
      this.assign.delete(id);
      this.restore.delete(id);
    }
    return null;
  }

  /**
   * Tiling tidak tahu daftar jendelanya sendiri; WM menitipkan closure
   * resolve(id) -> win supaya kedua kelas tidak saling memegang.
   */
  setRegistry(resolve) { this.registry = resolve; }

  findWindow(id) {
    return this.registry ? this.registry(id) : null;
  }

  isTiled(win) { return this.assign.has(win.id); }

  /** Lepas dari tiling; kembalikan ke kotak sebelum snapping. */
  float(win) {
    if (!this.assign.has(win.id)) return false;

    this.assign.delete(win.id);
    const back = this.restore.get(win.id);
    if (back) {
      Object.assign(win.node.style, back);
      this.restore.delete(win.id);
    }

    win.snapped = null;
    win.node.classList.remove('is-tiled');
    win.node.dispatchEvent(new CustomEvent('win:resize'));
    this.renderDividers();
    this.onChange?.();
    return true;
  }

  /** Terapkan posisi semua jendela yang sedang di petak. */
  reflow() {
    for (const id of this.assign.keys()) {
      const win = this.findWindow(id);
      if (win) this.apply(win);
    }
    this.renderDividers();
  }

  apply(win) {
    const tile = this.assign.get(win.id);
    if (!tile) return;
    const box = this.boxFor(this.cell(tile.c, tile.r, tile.cs, tile.rs));
    Object.assign(win.node.style, {
      left: `${box.left}px`, top: `${box.top}px`,
      width: `${box.width}px`, height: `${box.height}px`,
    });
    win.node.dispatchEvent(new CustomEvent('win:resize'));
  }

  destroy(win) {
    this.assign.delete(win.id);
    this.restore.delete(win.id);
    this.renderDividers();
  }

  /* ---------------------------------------------------------------- divider */

  /**
   * Pembagi antar kolom/baris yang memang memisahkan dua jendela bertiles.
   * Pembagi yang tidak dipakai tidak digambar: garis yang tidak bisa
   * diubah hanya menambah noise visual.
   */
  renderDividers() {
    this.dividers.replaceChildren();
    const tiled = [...this.assign.keys()]
      .map((id) => ({ id, tile: this.assign.get(id), win: this.findWindow(id) }))
      .filter((entry) => entry.win);
    if (tiled.length < 2) return;

    const area = this.workspace.getBoundingClientRect();

    this.cuts.x.forEach((frac, i) => {
      const left = tiled.some(({ tile }) => tile.c <= i);
      const right = tiled.some(({ tile }) => tile.c + tile.cs > i + 1);
      if (!left || !right) return;
      this.dividers.append(this.divider('x', i, frac * area.width, area));
    });

    this.cuts.y.forEach((frac, i) => {
      const top = tiled.some(({ tile }) => tile.r <= i);
      const bottom = tiled.some(({ tile }) => tile.r + tile.rs > i + 1);
      if (!top || !bottom) return;
      this.dividers.append(this.divider('y', i, frac * area.height, area));
    });
  }

  divider(axis, index, offset, area) {
    const node = el('div', { class: `tile-divider tile-divider-${axis}` });
    node.style[axis === 'x' ? 'left' : 'top'] = `${offset}px`;
    node.title = 'Geser untuk membagi ukuran';

    node.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      event.stopPropagation();
      try { node.setPointerCapture?.(event.pointerId); } catch { /* biarkan */ }
      node.classList.add('is-dragging');
      this.workspace.classList.add('is-resizing-tiles');

      const startPos = axis === 'x' ? event.clientX : event.clientY;
      const startFrac = this.cuts[axis][index];

      const move = (e) => {
        const delta = ((axis === 'x' ? e.clientX : e.clientY) - startPos)
          / (axis === 'x' ? area.width : area.height);
        const list = this.cuts[axis];
        // Batas tidak boleh menyatu dengan tetangganya: kalau i-1 = 0.33 dan
        // i+1 = 0.66, batas i harus tetap di antara keduanya.
        const lower = index > 0 ? list[index - 1] + MIN_FRAC : MIN_FRAC;
        const upper = index < list.length - 1 ? list[index + 1] - MIN_FRAC : 1 - MIN_FRAC;
        list[index] = Math.min(Math.max(startFrac + delta, lower), Math.max(lower, upper));

        this.reflow();
        const px = list[index] * (axis === 'x' ? area.width : area.height);
        node.style[axis === 'x' ? 'left' : 'top'] = `${px}px`;
      };

      const up = () => {
        node.classList.remove('is-dragging');
        this.workspace.classList.remove('is-resizing-tiles');
        node.removeEventListener('pointermove', move);
        node.removeEventListener('pointerup', up);
        node.removeEventListener('pointercancel', up);
      };

      node.addEventListener('pointermove', move);
      node.addEventListener('pointerup', up);
      node.addEventListener('pointercancel', up);
    });

    return node;
  }

  /* ------------------------------------------- snap layout ala Windows 11 */

  /**
   * Popover di atas tombol maximize, persis seperti Windows 11: grid pilihan
   * tata letak. Klik sebuah petak untuk mengunci jendela ke sana.
   */
  showLayoutPicker(win, anchor) {
    this.hideLayoutPicker();

    const pop = el('div', { class: 'snap-picker' });
    const area = this.workspace.getBoundingClientRect();
    const anchorBox = anchor.getBoundingClientRect();

    for (const layout of SNAP_LAYOUTS) {
      // Petak dipetakan lewat indeks yang disimpan pada <i>-nya masing-masing,
      // bukan pada tombolnya. Kalau indeksnya dipasang sekali di tombol, semua
      // petak dalam satu tata letak akan menunjuk ke sel yang sama, dan
      // mengklik kuarters kanan bawah akan mendarat di kiri atas.
      const pick = (cell) => {
        this.hideLayoutPicker();
        this.snapToGrid(win, layout.cols, layout.rows, cell % layout.cols,
          Math.floor(cell / layout.cols));
      };

      const grid = el('span', { class: 'snap-grid' });
      grid.style.gridTemplateColumns = `repeat(${layout.cols}, 1fr)`;
      grid.style.gridTemplateRows = `repeat(${layout.rows}, 1fr)`;

      const option = el('button', {
        class: 'snap-option',
        type: 'button',
        title: `${layout.cols} x ${layout.rows}`,
        onClick: (event) => {
          const cell = Number(event.target.closest('i')?.dataset.cell ?? 0);
          pick(cell);
        },
      }, grid);

      for (let i = 0; i < layout.cols * layout.rows; i += 1) {
        const cell = el('i', { title: `Petak ${i + 1}` });
        cell.dataset.cell = String(i);
        grid.append(cell);
      }

      pop.append(option);
    }

    this.workspace.append(pop);
    const popBox = pop.getBoundingClientRect();
    pop.style.left = `${Math.max(6, Math.min(
      anchorBox.left - area.left - popBox.width / 2 + anchorBox.width / 2,
      area.width - popBox.width - 6,
    ))}px`;
    pop.style.top = `${Math.max(6, anchorBox.bottom - area.top + 8)}px`;

    this._picker = pop;
    this._pickerClose = (event) => {
      if (pop.contains(event.target)) return;
      this.hideLayoutPicker();
    };
    // setTimeout supaya event yang sedang berjalan tidak langsung menutupnya.
    setTimeout(() => document.addEventListener('pointerdown', this._pickerClose), 0);
    return pop;
  }

  hideLayoutPicker() {
    this._picker?.remove();
    this._picker = null;
    if (this._pickerClose) {
      document.removeEventListener('pointerdown', this._pickerClose);
      this._pickerClose = null;
    }
  }

  snapToGrid(win, cols, rows, c, r) {
    const plan = { cols, rows, cell: { c, r, cs: 1, rs: 1 } };
    const previous = this.assign.get(win.id) || null;
    this.setGrid(cols, rows);

    const target = plan.cell;
    const occupant = this.findOccupant(win.id, target);
    if (occupant) {
      if (previous && sameSpan(previous, target)) this.assign.set(occupant.id, previous);
      else this.float(occupant);
    }

    if (!previous) this.restore.set(win.id, boxOf(win.node));
    this.assign.set(win.id, target);

    win.snapped = `grid:${cols}x${rows}`;
    win.maximized = false;
    win.node.classList.add('is-tiled');
    win.node.classList.remove('is-maximized');
    this.apply(win);
    this.renderDividers();
    this.onChange?.();
  }
}

/* --------------------------------------------------------------- pembantu */

const evenCuts = (count) => Array.from({ length: Math.max(0, count - 1) }, (_, i) => (i + 1) / count);

const boxOf = (node) => ({
  left: node.style.left, top: node.style.top,
  width: node.style.width, height: node.style.height,
});

const sameSpan = (a, b) => a.c === b.c && a.r === b.r && a.cs === b.cs && a.rs === b.rs;

function overlaps(a, b) {
  return a.c < b.c + b.cs && b.c < a.c + a.cs
    && a.r < b.r + b.rs && b.r < a.r + a.rs;
}