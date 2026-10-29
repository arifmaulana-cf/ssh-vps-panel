import { api } from '../api.js';
import { icons } from '../icons.js';
import { el, toast, confirmDialog, promptDialog } from '../ui.js';

/**
 * Pengaturan, mengikuti GNOME Settings: daftar bagian di kiri, isi di kanan.
 *
 * Aturan yang dipegang: **tidak ada baris pengaturan yang tidak melakukan
 * sesuatu.** GNOME asli punya tombol "Tampilan Layar" yang di sini tidak ada
 * artinya, jadi tombol seperti itu sengaja tidak dibuat - lebih baik tidak ada
 * daripada ada yang,buta.
 */

const SHORTCUTS = [
  { group: 'Jendela', keys: [
    ['Super + Panah kiri/atas/kanan', 'Snap jendela: kiri, layar penuh, kanan'],
    ['Alt + Panah kiri/kanan', 'Snap yang sama (cadangan bila Super dimakan OS)'],
    ['Super + Panah bawah', 'Kembalikan ukuran / lepas dari petak'],
    ['Alt + F4', 'Tutup jendela yang terfokus'],
    ['Alt + Tab', 'Pindah antar jendela'],
    ['Ctrl + W', 'Tutup jendela'],
    ['Ctrl + Shift + T', 'Tab terminal baru'],
    ['Klik ganda judul', 'Perbesar / perkecil'],
    ['Seret ke tepi atau pojok', 'Kunci jendela ke petak'],
    ['Seret pembagi', 'Ubah lebar antar petak'],
  ] },
  { group: 'Shell', keys: [
    ['Super', 'Buka daftar aplikasi'],
    ['Escape', 'Tutup app grid, menu, dialog, atau overview'],
    ['Ctrl + Alt + T', 'Terminal baru'],
  ] },
  { group: 'Panel', keys: [
    ['Super + Q', 'Tutup semua jendela'],
    ['Ctrl + Shift + W', 'Tutup semua jendela'],
    ['Klik kanan desktop', 'Menu konteks desktop'],
    ['Tahan tombol Perbesar', 'Pilihan snap layout'],
  ] },
];

export const settingsApp = {
  id: 'settings',
  name: 'Pengaturan',
  icon: icons.gear,
  resizable: true,
  needsSession: false,

  mount(body, ctx) {
    let page = ctx.initialPage || 'appearance';
    let timer = null;

    const nav = el('nav', { class: 'set-nav', 'aria-label': 'Bagian pengaturan' });
    const page_ = el('div', { class: 'set-page' });

    const PAGES = [
      { id: 'appearance', label: 'Tampilan', icon: icons.palette },
      { id: 'sessions', label: 'Sesi & Koneksi', icon: icons.unplug },
      { id: 'account', label: 'Akun', icon: icons.users },
      { id: 'keyboard', label: 'Papan Tik', icon: icons.terminal },
      { id: 'about', label: 'Tentang', icon: icons.unknown },
    ];

    function renderNav() {
      nav.replaceChildren(...PAGES.map((p) => el('button', {
        class: `set-nav-item${p.id === page ? ' is-active' : ''}`,
        type: 'button',
        onClick: () => { page = p.id; draw(); },
      },
      el('span', { class: 'ti', html: p.icon }),
      el('span', { text: p.label }))));
    }

    /* ------------------------------------------------------------ Tampilan */
    function appearance() {
      const grid = el('div', { class: 'theme-grid' });
      const wrap = el('section', { class: 'set-section' },
        el('h2', { class: 'set-title', text: 'Tampilan' }),
        el('p', { class: 'set-note', text: 'Tema berlaku seketika di seluruh panel dan terminal. Tersimpan di peramban ini, bukan di server.' }),
        grid);

      for (const theme of window.PanelThemes.THEMES) {
        const active = window.PanelThemes.current().id === theme.id;
        grid.append(el('button', {
          class: `theme-card${active ? ' is-active' : ''}`,
          type: 'button',
          'data-theme-id': theme.id,
          title: theme.name,
          onClick: () => {
            window.PanelThemes.apply(theme.id);
            document.body.dataset.themeReady = theme.id;
            document.getElementById('theme-modal').hidden = true;
            toast(`Tema ${theme.name} diterapkan.`);
            draw();
          },
        },
        el('span', {
          class: 'swatch-row',
          html: `<i style="background:${theme.base.accent}"></i>`
            + `<i style="background:${theme.base.window}"></i>`
            + `<i style="background:${theme.base.base}"></i>`
            + `<i style="background:${theme.base.text}"></i>`,
        }),
        el('span', { class: 'theme-name', text: theme.name })));
      }
      return wrap;
    }

    /* ------------------------------------------------- Sesi & Koneksi */
    function sessions() {
      const list = el('div', { class: 'set-list' });
      const state = ctx.getSessions?.() || [];

      if (!state.length) {
        list.append(el('div', { class: 'set-empty', text: 'Belum ada koneksi SSH. Buka satu lewat tombol Koneksi baru di kanan atas.' }));
      } else {
        for (const s of state) {
          list.append(el('div', { class: 'set-row' },
            el('div', { class: 'set-row-main' },
              el('div', { class: 'set-row-title mono', text: `${s.username}@${s.host}:${s.port}` }),
              el('div', { class: 'set-row-sub', text: `metode: ${s.authMethod} \u00b7 dibuat ${new Date(s.createdAt).toLocaleString('id-ID')}` })),
            el('button', {
              class: 'btn btn-ghost btn-xs',
              type: 'button',
              text: 'Putuskan',
              onClick: async () => {
                const ok = await confirmDialog({
                  title: 'Putuskan sesi?',
                  message: `Koneksi ke ${s.host}:${s.port} akan ditutup.`,
                  confirmText: 'Putuskan',
                  danger: true,
                });
                if (!ok) return;
                await ctx.disconnectSession?.(s.id);
                draw();
              },
            })));
        }
      }

      return el('section', { class: 'set-section' },
        el('h2', { class: 'set-title', text: 'Sesi & Koneksi' }),
        el('p', { class: 'set-note', text: 'Semua sesi di bawah milik akun Anda sendiri. Sesi milik pengguna lain tidak terlihat di sini.' }),
        list,
        state.length > 0 && el('button', {
          class: 'btn btn-ghost btn-xs',
          type: 'button',
          text: 'Putuskan semua sesi',
          onClick: async () => {
            const ok = await confirmDialog({
              title: 'Putuskan semua sesi?',
              message: `${state.length} koneksi akan ditutup.`,
              confirmText: 'Putuskan semua',
              danger: true,
            });
            if (!ok) return;
            await ctx.disconnectAll?.();
            draw();
          },
        }));
    }

    /* ------------------------------------------------------------- Akun */
    function account() {
      const me = ctx.me;
      return el('section', { class: 'set-section' },
        el('h2', { class: 'set-title', text: 'Akun' }),
        el('div', { class: 'set-kv' },
          kv('Nama akun', me?.username || '-'),
          kv('Peran', me?.role === 'admin' ? 'Administrator' : 'Pengguna biasa'),
          kv('ID akun', me?.id || '-')),
        el('p', { class: 'set-note', text: 'Mengganti password akan memutus semua sesi milik akun ini, termasuk di perangkat lain.' }),
        el('div', { class: 'set-actions' },
          el('button', {
            class: 'btn btn-ghost btn-xs',
            type: 'button',
            text: 'Ganti password saya',
            onClick: () => ctx.changeOwnPassword?.(),
          })));
    }

    const kv = (label, value) => el('div', { class: 'set-kv-row' },
      el('span', { class: 'set-kv-label', text: label }),
      el('span', { class: 'set-kv-value mono', text: value }));

    /* ------------------------------------------------------- Papan Tik */
    function keyboard() {
      return el('section', { class: 'set-section' },
        el('h2', { class: 'set-title', text: 'Pintasan Papan Tik' }),
        ...SHORTCUTS.map((group) => el('div', { class: 'set-group' },
          el('h3', { class: 'set-group-title', text: group.group }),
          el('div', { class: 'set-list' },
            ...group.keys.map(([keys, desc]) => el('div', { class: 'set-row' },
              el('div', { class: 'set-row-main' },
                el('div', { class: 'set-row-sub', text: desc })),
              el('kbd', { class: 'set-kbd', text: keys })))))));
    }

    /* ---------------------------------------------------------- Tentang */
    function about() {
      const boot = ctx.bootInfo?.() || {};
      return el('section', { class: 'set-section' },
        el('h2', { class: 'set-title', text: 'Tentang' }),
        el('div', { class: 'set-about' },
          el('div', { class: 'set-about-logo', html: icons.terminal }),
          el('div', {},
            el('div', { class: 'set-about-name', text: 'SSH VPS Panel' }),
            el('div', { class: 'set-about-sub', text: 'Panel web untuk mengelola VPS lewat SSH' }))),
        el('div', { class: 'set-kv' },
          kv('Versi', boot.version || '-'),
          kv('Node.js', boot.node || '-'),
          kv('Uptime server', boot.uptime || '-'),
          kv('Sesi SSH terbuka', String(ctx.getSessions?.().length ?? 0)),
          kv('Akun aktif', boot.users != null ? String(boot.users) : 'hanya admin')),
        el('p', { class: 'set-note', text: 'Panel ini memakai ssh2 (reimplementasi SSH di JavaScript), bukan biner OpenSSH. Bukan pengganti bastion atau audit gateway untuk tim.' }));
    }

    function draw() {
      renderNav();
      const build = { appearance, sessions, account, keyboard, about }[page] || appearance;
      page_.replaceChildren(build());
    }

    body.append(el('div', { class: 'set-shell' }, nav, page_));
    draw();

    ctx.setMenus(() => [
      { label: 'Berkas', items: [{ label: 'Tutup', hint: 'Ctrl+W', onSelect: () => ctx.win.close() }] },
      { label: 'Tampilan', items: () => PAGES.map((p) => ({
        label: p.label,
        checked: p.id === page,
        onSelect: () => { page = p.id; draw(); },
      })) },
    ]);

    ctx.registerCleanup?.(() => clearInterval(timer));
  },
};
