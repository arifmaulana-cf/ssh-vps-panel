import { el } from './ui.js';

/**
 * Menu bar aplikasi di top bar, seperti GNOME dan Ubuntu.
 *
 * Ini bagian yang paling mencolok dari shell desktop dan paling sering
 * hilang: aplikasi desktop tidak pernah menaruh "Berkas / Edit / Tampilan /
 * Bantuan" di atas. Yang di sini bukan hiasan - tiap butir benar-benar
 * menjalankan sesuatu, dan yang tidak punya implementasi nyata tidak
 * ditampilkan sama sekali.
 *
 * Perilakanya mengikuti yang biasa dipakai orang:
 *   - klik membuka, klik lagi menutup
 *   - selama satu menu terbuka, menyorot judul lain langsung berpindah
 *     (meneuhi kebiasaan di Windows dan GNOME)
 *   - klik di luar menutup
 *   - Escape menutup
 *   - panah kiri/kanan berpindah antar judul, atas/bawah antar butir
 *
 * Judul yang sedang dibuka diberi penekanan, bukan hanya `hover`, karena
 * itulah yang membedakan "menu ini sedang terbuka" dari "kursor lewat sini".
 */

export class Menubar {
  /** @param {HTMLElement} host */
  constructor(host) {
    this.host = host;
    this.spec = [];
    this.openIndex = -1;
    this.activeItem = 0;

    // Satu listener untuk seluruh menubar, dipasang sekali. Menutup
    // listener per-judul adalah sumber_clsas memory leak yang CLASSIK di
    // aplikasi yang membuka/menutup jendela sering.
    this._outside = (event) => {
      if (!this.host.contains(event.target)) this.close();
    };
    this._escape = (event) => {
      if (event.key === 'Escape' && this.openIndex >= 0) this.close();
    };
    this._nav = (event) => this.onKeyNav(event);

    document.addEventListener('pointerdown', this._outside);
    document.addEventListener('keydown', this._escape);
    this.host.addEventListener('keydown', this._nav);
  }

  /**
   * @param {Array} spec  [{ label, items: [{ label, onSelect, disabled, danger, checked }] }]
   *   `items` boleh berupa fungsi, supaya isi menu bisa ikut berubah
   *   (mis. "Tutup" mati kalau cuma ada satu tab).
   */
  render(spec) {
    this.spec = Array.isArray(spec) ? spec : [];
    const wasOpen = this.openIndex;
    this.openIndex = -1;

    this.host.replaceChildren(...this.spec.map((menu, index) => el('button', {
      class: 'menubar-title',
      type: 'button',
      text: menu.label,
      onClick: () => this.toggle(index),
      onPointerenter: () => {
        if (this.openIndex >= 0 && this.openIndex !== index) this.open(index);
      },
    })));
    this.host.hidden = this.spec.length === 0;

    // Judul yang tadinya terbuka perlu dibuka lagi, kalau masih ada.
    if (wasOpen >= 0 && wasOpen < this.spec.length) this.open(wasOpen);
  }

  toggle(index) {
    if (this.openIndex === index) return this.close();
    return this.open(index);
  }

  open(index) {
    const menu = this.spec[index];
    if (!menu) return this.close();

    this.close();
    this.openIndex = index;
    this.activeItem = 0;

    const bar = this.host.children[index];
    bar.classList.add('is-open');

    const items = typeof menu.items === 'function' ? menu.items() : menu.items;
    const list = el('div', { class: 'menu-pop', role: 'menu' });

    let selectable = 0;
    for (const item of items) {
      if (item === '-') { list.append(el('div', { class: 'menu-sep', role: 'separator' })); continue; }

      selectable += 1;
      const node = el('button', {
        class: `menu-item${item.disabled ? ' is-disabled' : ''}${item.danger ? ' is-danger' : ''}`,
        type: 'button',
        role: 'menuitem',
        disabled: item.disabled === true,
      },
      el('span', { text: item.label }),
      item.checked ? el('span', { class: 'menu-check', text: '\\u2713' }) : null,
      item.hint ? el('span', { class: 'menu-hint', text: item.hint }) : null);

      if (!item.disabled) {
        node.addEventListener('pointerenter', () => {
          node.parentElement.querySelectorAll('.menu-item').forEach((n) => n.classList.remove('is-cursor'));
          node.classList.add('is-cursor');
          this.activeItem = selectable - 1;
        });
        node.addEventListener('click', () => {
          this.close();
          item.onSelect?.();
        });
      }
      list.append(node);
    }

    // Dipasang ke dokumen, bukan ke host: menu harus bisa keluar dari
    // lebar top bar, dan top bar punya `overflow` yang tidak-longgar.
    this.pop = list;
    document.body.append(list);

    const barBox = bar.getBoundingClientRect();
    const box = list.getBoundingClientRect();
    // Menu yang terlalu lebar akan terpotong tepi jendela, dan butir di
    // dalamnya jadi tidak bisa diklik dengan benar.
    list.style.left = `${Math.max(4, Math.min(barBox.left, window.innerWidth - box.width - 4))}px`;
    list.style.top = `${barBox.bottom}px`;

    if (box.bottom > window.innerHeight) {
      list.style.top = `${Math.max(4, barBox.top - box.height)}px`;
    }
    return list;
  }

  close() {
    this.pop?.remove();
    this.pop = null;
    for (const bar of this.host.children) bar.classList.remove('is-open');
    this.openIndex = -1;
    return null;
  }

  get isOpen() { return this.openIndex >= 0; }

  onKeyNav(event) {
    if (!this.isOpen) return;

    const items = [...(this.pop?.querySelectorAll('.menu-item:not(.is-disabled)') || [])];
    if (!items.length) return;

    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const delta = event.key === 'ArrowDown' ? 1 : -1;
      this.activeItem = (this.activeItem + delta + items.length) % items.length;
      items.forEach((n, i) => n.classList.toggle('is-cursor', i === this.activeItem));
      items[this.activeItem].focus();
    } else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault();
      const delta = event.key === 'ArrowRight' ? 1 : -1;
      const next = (this.openIndex + delta + this.spec.length) % this.spec.length;
      this.open(next);
      this.host.children[next]?.focus();
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      items[this.activeItem]?.click();
    }
  }
}