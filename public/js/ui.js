/* Helper UI kecil yang dipakai bersama semua aplikasi. */

export const el = (tag, attrs = {}, ...children) => {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'html') node.innerHTML = value;
    else if (key === 'style' && typeof value === 'object') Object.assign(node.style, value);
    // dataset harus di-assign sebagai objek. Tanpa cabang ini,
    // `dataset: { a: 1 }` berakhir jadi setAttribute('dataset',
    // '[object Object]') dan setiap pembacaan dataset.a menjadi null - bug yang
    // sulit dilacak karena tidak ada error sama sekali.
    else if (key === 'dataset' && typeof value === 'object') Object.assign(node.dataset, value);
    else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (value === true) node.setAttribute(key, '');
    else node.setAttribute(key, value);
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
};

export const $ = (selector, root = document) => root.querySelector(selector);
export const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

let toastTimer;
export function toast(message, kind = 'info') {
  const node = document.getElementById('toast');
  node.textContent = message;
  node.className = `toast toast-${kind}`;
  node.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { node.hidden = true; }, 3200);
}

export function formatBytes(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  const i = Math.min(Math.floor(Math.log(n) / Math.log(1024)), units.length - 1);
  return `${(n / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

export function formatTime(ms) {
  if (!ms) return '-';
  const d = new Date(ms);
  const now = Date.now();
  const diff = (now - ms) / 1000;
  const two = (v) => String(v).padStart(2, '0');

  if (diff < 60) return 'baru saja';
  if (diff < 3600) return `${Math.floor(diff / 60)} menit lalu`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} jam lalu`;

  const sameYear = d.getFullYear() === new Date().getFullYear();
  const prefix = sameYear ? '' : `${d.getFullYear()}-`;
  return `${prefix}${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`;
}

/** Dialog konfirmasi yang menimpa window.confirm (lebih rapi & non-blocking). */
export function confirmDialog({ title, message, confirmText = 'Lanjutkan', danger = false }) {
  return new Promise((resolve) => {
    const close = (result) => {
      overlay.remove();
      document.removeEventListener('keydown', onKey);
      resolve(result);
    };
    const onKey = (event) => {
      if (event.key === 'Escape') close(false);
      if (event.key === 'Enter') close(true);
    };

    const overlay = el('div', { class: 'modal' },
      el('div', { class: 'modal-backdrop', onClick: () => close(false) }),
      el('div', { class: 'card modal-card modal-narrow' },
        el('div', { class: 'modal-head' }, el('h2', { text: title })),
        el('p', { class: 'muted', text: message }),
        el('div', { class: 'modal-foot' },
          el('button', { class: 'btn btn-ghost', type: 'button', text: 'Batal', onClick: () => close(false) }),
          el('button', {
            class: `btn ${danger ? 'btn-danger-solid' : 'btn-primary'}`,
            type: 'button',
            text: confirmText,
            onClick: () => close(true),
          }),
        ),
      ),
    );

    document.body.append(overlay);
    document.addEventListener('keydown', onKey);
    overlay.querySelector('.modal-foot .btn:last-child').focus();
  });
}

/** Prompt teks satu baris (dipakai untuk nama folder baru / rename). */
export function promptDialog({ title, label, value = '', confirmText = 'Simpan' }) {
  return new Promise((resolve) => {
    const input = el('input', { type: 'text', value, spellcheck: 'false' });
    const close = (result) => {
      overlay.remove();
      document.removeEventListener('keydown', onKey);
      resolve(result);
    };
    const onKey = (event) => {
      if (event.key === 'Escape') close(null);
      if (event.key === 'Enter') close(input.value.trim() || null);
    };

    const overlay = el('div', { class: 'modal' },
      el('div', { class: 'modal-backdrop', onClick: () => close(null) }),
      el('form', { class: 'card modal-card modal-narrow', onSubmit: (e) => { e.preventDefault(); close(input.value.trim() || null); } },
        el('div', { class: 'modal-head' }, el('h2', { text: title })),
        el('label', { text: label }),
        input,
        el('div', { class: 'modal-foot' },
          el('button', { class: 'btn btn-ghost', type: 'button', text: 'Batal', onClick: () => close(null) }),
          el('button', { class: 'btn btn-primary', type: 'submit', text: confirmText }),
        ),
      ),
    );

    document.body.append(overlay);
    document.addEventListener('keydown', onKey);
    input.focus();
    input.select();
  });
}

/** Menu konteks sederhana di posisi kursor. */
export function contextMenu(event, items) {
  $$('.context-menu').forEach((n) => n.remove());

  const menu = el('div', { class: 'context-menu' },
    items.map((item) => (item === '-'
      ? el('div', { class: 'ctx-sep' })
      : el('button', {
        class: 'ctx-item',
        type: 'button',
        text: item.label,
        disabled: item.disabled,
        onClick: () => { menu.remove(); item.onSelect(); },
      }))),
  );

  document.body.append(menu);
  const { innerWidth: w, innerHeight: h } = window;
  const rect = menu.getBoundingClientRect();

  // Jangan sampai keluar dari layar.
  menu.style.left = `${Math.min(event.clientX, w - rect.width - 8)}px`;
  menu.style.top = `${Math.min(event.clientY, h - rect.height - 8)}px`;

  const dismiss = () => { menu.remove(); document.removeEventListener('pointerdown', dismiss, true); };
  setTimeout(() => document.addEventListener('pointerdown', dismiss, true), 0);
}

/** Bar persentase dengan perubahan kelas otomatis untuk kondisi kritis. */
export function bar(percent) {
  const value = Math.max(0, Math.min(Number(percent) || 0, 100));
  const level = value >= 90 ? ' crit' : (value >= 75 ? ' warn' : '');
  return el('div', { class: `bar${level}` }, el('span', { style: { width: `${value}%` } }));
}

/**
 * Empty state yang jujur: sebut penyebabnya, lalu beri satu aksi yang
 * mengisinya. "Kosong" saja tidak memberi tahu pengguna harus apa selanjutnya.
 */
export function emptyState({ title, cause, action }) {
  return el('div', { class: 'empty-state' },
    el('strong', { class: 'empty-title', text: title }),
    el('p', { class: 'empty-cause', text: cause }),
    action ? el('button', { class: 'btn btn-ghost btn-xs', type: 'button', text: action.label, onClick: action.onClick }) : null,
  );
}

/** Bangun elemen <table> beserta isi dari array of rows. */
export function table(headers, rows, { onRowClick, onRowContext, empty = 'Kosong' } = {}) {
  const body = el('tbody');
  if (!rows.length) {
    body.append(el('tr', {}, el('td', { class: 'table-empty', colspan: headers.length, text: empty })));
  }
  for (const row of rows) {
    const tr = el('tr', {},
      row.cells.map((cell) => (cell && cell.node instanceof Node
        ? el('td', { class: cell.class }, cell.node)
        : el('td', { class: (cell && cell.class) || '', text: (cell && cell.text) ?? '' }))),
    );
    if (onRowClick) tr.addEventListener('click', () => onRowClick(row));
    if (onRowContext) tr.addEventListener('contextmenu', (e) => { e.preventDefault(); onRowContext(row, e); });
    body.append(tr);
  }

  return el('div', { class: 'table-wrap' },
    el('table', { class: 'data-table' },
      el('thead', {}, el('tr', {}, headers.map((h) => el('th', { text: h.label ?? h, ...(h.sortable ? { class: 'sortable' } : {}) })))),
      body),
  );
}