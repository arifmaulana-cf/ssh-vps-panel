/**
 * Tema panel.
 *
 * Ditulis sebagai skrip klasik, bukan modul ES, supaya bisa dimuat sinkron
 * di <head> dan menerapkan tema sebelum halaman dirender. Kalau ini modul,
 * modul selalu deferred, dan tema pilihan user akan terlihat "kedip" ke
 * warna bawaan selama satu frame.
 *
 * Setiap tema mengambil palet dari proyek komunitas yang nyata, bukan warna
 * karangan. Alasan tiap tema ada di DESIGN.md.
 *
 * Token CSS ditulis ke :root; seluruh warna di stylesheet diturunkan dari
 * sana lewat color-mix(), jadi mengganti tema cukup menimpa ±16 token.
 */
(function initThemes(global) {
  'use strict';

  /* ------------------------------------------------------------ utilitas */

  function hexToRgb(hex) {
    const h = hex.replace('#', '');
    const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
    return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16));
  }

  function toHex(rgb) {
    return `#${rgb.map((v) => Math.round(Math.min(255, Math.max(0, v)))
      .toString(16).padStart(2, '0')).join('')}`;
  }

  /** Campur dua warna; ratio 0..1 untuk warna pertama. */
  function mix(a, b, ratio) {
    const [r1, g1, b1] = hexToRgb(a);
    const [r2, g2, b2] = hexToRgb(b);
    return toHex([r1 + (r2 - r1) * ratio, g1 + (g2 - g1) * ratio, b1 + (b2 - b1) * ratio]);
  }

  /** Cerahkan ke arah putih; untuk varian bright palet ANSI. */
  function lighten(hex, amount) {
    return mix(hex, '#ffffff', amount === undefined ? 0.22 : amount);
  }

  /** Luminansi relatif; memilih warna teks di atas warna aksen. */
  function luminance(hex) {
    const [r, g, b] = hexToRgb(hex).map((v) => {
      const s = v / 255;
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }

  /**
   * 16 warna ANSI dari 8 warna inti. Varian bright dicerahkannya dengan
   * nilai yang sama, sehingga tetap satu keluarga warna dan tidak perlu
   * menulis 16 hex per tema.
   */
  function ansi(c) {
    return {
      black: c.black, red: c.red, green: c.green, yellow: c.yellow,
      blue: c.blue, magenta: c.magenta, cyan: c.cyan, white: c.white,
      brightBlack: lighten(c.black, 0.3),
      brightRed: lighten(c.red), brightGreen: lighten(c.green),
      brightYellow: lighten(c.yellow), brightBlue: lighten(c.blue),
      brightMagenta: lighten(c.magenta), brightCyan: lighten(c.cyan),
      brightWhite: lighten(c.white),
    };
  }

  /**
   * Terjemahkan warna inti tema menjadi token CSS.
   * bg = latar di belakang jendela, bgAlt = permukaan jendela,
   * bgHigh = headerbar dan permukaan terangkat.
   */
  function tokens(t) {
    const dark = luminance(t.bg) < 0.4;
    const accentInk = luminance(t.accent) > 0.45 ? t.bgAlt : '#ffffff';

    return {
      '--t-base': t.bg,
      '--t-wall-1': t.bgAlt,
      '--t-wall-2': t.bg,
      '--t-wall-3': t.bgHigh,
      '--t-window': t.bgAlt,
      '--t-window-2': t.bgHigh,
      '--t-headerbar': t.bgHigh,
      '--t-headerbar-in': mix(t.bg, t.bgHigh, 0.45),
      '--t-term-bg': mix(t.bg, '#000000', dark ? 0.22 : 0.06),
      '--t-text': t.fg,
      '--t-text-dim': t.fgDim,
      '--t-border': mix(t.bg, t.fg, dark ? 0.14 : 0.2),
      '--t-accent': t.accent,
      '--t-accent-ink': accentInk,
      '--t-ok': t.ok,
      '--t-warn': t.warn,
      '--t-danger': t.danger,
      '--t-shadow': dark ? 'rgba(0,0,0,.55)' : 'rgba(40,30,20,.22)',
    };
  }

  /* ------------------------------------------------------------- katalog */

  const THEMES = [
    {
      id: 'ubuntu',
      name: 'Ubuntu',
      note: 'Aubergine dengan oranye. Shell GNOME asli.',
      base: {
        bg: '#1b1b1f', bgAlt: '#242424', bgHigh: '#303030',
        fg: '#deddda', fgDim: '#9a9996', accent: '#e95420',
        ok: '#4ec9a0', warn: '#f5a623', danger: '#e01b24',
      },
      ansi: ansi({
        black: '#3b3b3d', red: '#e01b24', green: '#4ec9a0', yellow: '#f5a623',
        blue: '#729fcf', magenta: '#ad7fa8', cyan: '#5a8b8b', white: '#deddda',
      }),
    },
    {
      id: 'catppuccin-mocha',
      name: 'Catppuccin Mocha',
      note: 'Pastel gelap, dari paket warna Catppuccin.',
      base: {
        bg: '#1e1e2e', bgAlt: '#181825', bgHigh: '#313244',
        fg: '#cdd6f4', fgDim: '#9399b2', accent: '#cba6f7',
        ok: '#a6e3a1', warn: '#f9e2af', danger: '#f38ba8',
      },
      ansi: ansi({
        black: '#45475a', red: '#f38ba8', green: '#a6e3a1', yellow: '#f9e2af',
        blue: '#89b4fa', magenta: '#cba6f7', cyan: '#94e2d5', white: '#bac2de',
      }),
    },
    {
      id: 'catppuccin-latte',
      name: 'Catppuccin Latte',
      note: 'Versi terang Catppuccin, untuk ruangan terang.',
      base: {
        bg: '#eff1f5', bgAlt: '#f5f6f8', bgHigh: '#dce0e8',
        fg: '#4c4f69', fgDim: '#7c7f93', accent: '#8839ef',
        ok: '#40a02b', warn: '#df8e1d', danger: '#d20f39',
      },
      ansi: ansi({
        black: '#5c5f77', red: '#d20f39', green: '#40a02b', yellow: '#df8e1d',
        blue: '#1e66f5', magenta: '#8839ef', cyan: '#179299', white: '#acb0be',
      }),
    },
    {
      id: 'nord',
      name: 'Nord',
      note: 'Arktik biru-hijau. Palet paling kalem untuk mata lelah.',
      base: {
        bg: '#2e3440', bgAlt: '#3b4252', bgHigh: '#434c5e',
        fg: '#eceff4', fgDim: '#a9b4c4', accent: '#88c0d0',
        ok: '#a3be8c', warn: '#ebcb8b', danger: '#bf616a',
      },
      ansi: ansi({
        black: '#4c566a', red: '#bf616a', green: '#a3be8c', yellow: '#ebcb8b',
        blue: '#81a1c1', magenta: '#b48ead', cyan: '#8fbcbb', white: '#e5e9f0',
      }),
    },
    {
      id: 'gruvbox-dark',
      name: 'Gruvbox Dark',
      note: 'Retro hangat, gradasi oranye-krem yang khas.',
      base: {
        bg: '#282828', bgAlt: '#32302f', bgHigh: '#3c3836',
        fg: '#ebdbb2', fgDim: '#a89984', accent: '#fe8019',
        ok: '#b8bb26', warn: '#fabd2f', danger: '#fb4934',
      },
      ansi: ansi({
        black: '#665c54', red: '#fb4934', green: '#b8bb26', yellow: '#fabd2f',
        blue: '#83a598', magenta: '#d3869b', cyan: '#8ec07c', white: '#ebdbb2',
      }),
    },
    {
      id: 'gruvbox-light',
      name: 'Gruvbox Light',
      note: 'Krem hangat dengan aksen biru, kontras baik di bawah matahari.',
      base: {
        bg: '#fbf1c7', bgAlt: '#f2e5bc', bgHigh: '#ebdbb2',
        fg: '#3c3836', fgDim: '#7c6f64', accent: '#458588',
        ok: '#79740e', warn: '#b57614', danger: '#9d0006',
      },
      ansi: ansi({
        black: '#7c6f64', red: '#9d0006', green: '#79740e', yellow: '#b57614',
        blue: '#458588', magenta: '#8f3f71', cyan: '#427b58', white: '#3c3836',
      }),
    },
    {
      id: 'tokyo-night',
      name: 'Tokyo Night',
      note: 'Biru malam yang dalam, aksen biru elektrik.',
      base: {
        bg: '#1a1b26', bgAlt: '#20222f', bgHigh: '#292e42',
        fg: '#c0caf5', fgDim: '#a9b1d6', accent: '#7aa2f7',
        ok: '#9ece6a', warn: '#e0af68', danger: '#f7768e',
      },
      ansi: ansi({
        black: '#414868', red: '#f7768e', green: '#9ece6a', yellow: '#e0af68',
        blue: '#7aa2f7', magenta: '#bb9af7', cyan: '#7dcfff', white: '#c0caf5',
      }),
    },
    {
      id: 'everforest',
      name: 'Everforest',
      note: 'Hijau lumut, nuansa hutan dengan kontras rendah.',
      base: {
        bg: '#2d353b', bgAlt: '#343f44', bgHigh: '#3d484d',
        fg: '#d3c6aa', fgDim: '#9da9a0', accent: '#83c092',
        ok: '#a7c080', warn: '#dbbc7f', danger: '#e78284',
      },
      ansi: ansi({
        black: '#475258', red: '#e78284', green: '#a7c080', yellow: '#dbbc7f',
        blue: '#7fbbb3', magenta: '#d699b6', cyan: '#83c092', white: '#d3c6aa',
      }),
    },
    {
      id: 'rose-pine',
      name: 'Rose Pine',
      note: 'Mawar, pinus, dan busa. Lembut tanpa terasa seperti tema generik.',
      base: {
        bg: '#191724', bgAlt: '#1f1d2e', bgHigh: '#26233a',
        fg: '#e0def4', fgDim: '#908caa', accent: '#ebbcba',
        ok: '#9ccfd8', warn: '#f6c177', danger: '#eb6f92',
      },
      ansi: ansi({
        black: '#26233a', red: '#eb6f92', green: '#31748f', yellow: '#f6c177',
        blue: '#9ccfd8', magenta: '#c4a7e7', cyan: '#ebbcba', white: '#e0def4',
      }),
    },
  ];

  const DEFAULT_THEME = 'ubuntu';
  const STORAGE_KEY = 'panel.theme';

  function byId(id) {
    return THEMES.find((t) => t.id === id) || THEMES[0];
  }

  function stored() {
    try {
      return byId(localStorage.getItem(STORAGE_KEY)).id;
    } catch {
      return DEFAULT_THEME;
    }
  }

  /**
   * Terapkan tema ke :root dan kembalikan palet terminal.
   * xterm.js memakai palet terpisah karena warnanya tidak bisa dari CSS.
   */
  function apply(id) {
    const theme = byId(id);
    const vars = tokens(theme.base);
    const root = document.documentElement;

    for (const key in vars) root.style.setProperty(key, vars[key]);
    root.dataset.theme = theme.id;

    try { localStorage.setItem(STORAGE_KEY, theme.id); } catch { /* mode privat */ }

    return {
      id: theme.id,
      name: theme.name,
      note: theme.note,
      base: theme.base,
      terminal: {
        background: vars['--t-term-bg'],
        foreground: theme.base.fg,
        cursor: theme.base.accent,
        cursorAccent: vars['--t-term-bg'],
        selectionBackground: `${theme.base.accent}44`,
        ...theme.ansi,
      },
    };
  }

  let current = null;

  const api = {
    THEMES,
    DEFAULT_THEME,
    STORAGE_KEY,
    byId,
    current: () => current || (current = apply(stored())),
    apply(id) {
      current = apply(id);
      // Beri tahu pendengar (terminal, dsb) lewat event kustom.
      document.dispatchEvent(new CustomEvent('themechange', { detail: current }));
      return current;
    },
    isDark: (id) => luminance(byId((id || (current && current.id))).base.bg) < 0.4,
  };

  global.PanelThemes = api;

  // Terapkan segera: ini yang mencegah kedipan warna.
  if (document.documentElement) current = apply(stored());
}(window));