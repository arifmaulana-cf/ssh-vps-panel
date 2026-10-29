import { api } from './api.js';
import { icons } from './icons.js';
import { el, $, toast, confirmDialog, promptDialog, contextMenu } from './ui.js';
import { WindowManager } from './wm.js';
import { Menubar } from './menubar.js';
import { terminalApp } from './apps/terminal.js';
import { fileManagerApp } from './apps/filemanager.js';
import { editorApp } from './apps/editor.js';
import { systemMonitorApp } from './apps/sysmon.js';
import { processesApp } from './apps/processes.js';
import { diskUsageApp } from './apps/diskusage.js';
import { usersApp } from './apps/users.js';
import { settingsApp } from './apps/settings.js';
import { browserApp } from './apps/browser.js';

/**
 * Aplikasi milik semua user.
 *
 * `usersApp` sengaja TIDAK ada di sini. Aplikasi admin tidak pernah ikut ke
 * dock dan app grid, karena dock dirender ulang tiap kali jumlah jendela
 * berubah; membutanya dari daftar yang sama membuat filter peran ikut
 *_attachment_ di dua tempat, dan satu salah_filter_ berarti user biasa melihat
 * tombol yang tidak bisa dipakai.
 */
const APPS = [
  terminalApp, fileManagerApp, editorApp, systemMonitorApp, processesApp, diskUsageApp,
  browserApp,
];

/**
 * Aplikasi shell: tidak butuh koneksi SSH, jadi tidak ikut daftar dock dan
 * tidak ikut-grid aplikasi. Hanya bisa dibuka dari menu sistem, quick
 * settings, atau klik kanan desktop - persis seperti Settings di Ubuntu,
 * yang tidak bisa dicari lewat Show Applications.
 */
const SHELL_APPS = [settingsApp];


const ui = {
  login: $('#login-screen'),
  desktop: $('#desktop'),
  workspace: $('#workspace'),
  dock: $('#dock'),
  topbarTitle: $('#topbar-title'),
  topbarMenus: $('#topbar-menus'),
  clock: $('#clock'),
  systemMenu: $('#system-menu'),
  overview: $('#overview'),
  overviewEmpty: $('#overview-empty'),
  appgrid: $('#appgrid'),
  appgridSearch: $('#appgrid-search'),
  appgridItems: $('#appgrid-items'),
  appgridCats: $('#appgrid-cats'),
  quickSettings: $('#quick-settings'),
  qsDatetime: $('#qs-datetime'),
  qsDay: $('#qs-day'),
  qsSessions: $('#qs-sessions'),
  sessionPicker: $('#session-picker'),
  connStatus: $('#conn-status'),
  connLabel: $('#conn-label'),
  userName: $('#system-user'),
  systemRole: $('#system-role'),
  systemAccounts: $('#system-accounts'),
};

const state = {
  sessions: [],
  activeSessionId: null,
  wm: null,
  // Identitas user panel. null sampai login selesai. `role` menentukan apa
  // yang terlihat di UI; server tetap memeriksa sendiri di setiap endpoint.
  me: null,
  // Menu aplikasi yang terfokus. Menyimpan menu aktif di state supaya WM
  // (yang tahu jendela mana yang fokus) bisa meminta render ulang tanpa
  // desktop.js tidak perlu tahu apa isi menu itu.
  activeWin: null,
  appGridCategory: 'Semua',
};

const menubar = new Menubar(ui.topbarMenus);

/**
 * Menu aplikasi untuk jendela tertentu.
 *
 * Aplikasi mendaftarkan menunya lewat ctx.setMenus(). Isinya boleh berupa
 * fungsi supaya bisa ikut berubah - "Tutup tab" harus mati kalau hanya ada
 * satu tab, dan itu baru diketahui setelah render.
 */
function menusFor(win) {
  const spec = win?.getMenus?.();
  return Array.isArray(spec) ? spec : [];
}

/** Menu jatuh kosong saat tidak ada jendela terfokus (semua jendela ditutup). */
function renderMenus() {
  const focused = state.wm?.focusedWindow() || null;
  state.activeWin = focused;
  menubar.render(focused ? menusFor(focused) : []);
}

const isAdmin = () => state.me?.role === 'admin';

/** Aplikasi yang boleh dibuka user saat ini. */
function visibleApps() {
  return APPS.concat(isAdmin() ? [usersApp] : []);
}

/**
 * Semua aplikasi yang bisa dicari lewat Show Applications: aplikasi biasa,
 * aplikasi shell, dan (kalau admin) Pengguna.
 *
 * Sengaja berbeda dari visibleApps(): dock hanya menampilkan aplikasi yang
 * butuh koneksi SSH, sementara app grid harus menampilkan semuanya -
 * kalau tidak, Settings tidak akan pernah bisa ditemukan.
 */
const allApps = () => APPS.concat(SHELL_APPS, isAdmin() ? [usersApp] : []);

/**
 * Tampilkan atau sembunyikan elemen yang ditandai per peran.
 *
 * Ini hanya tampilan. Menyembunyikan tombol admin bukan tindakan keamanan:
 * endpoint-nya tetap menolak non-admin di server, dan inilah yang membuat
 * tombol tidak membingungkan orang yang memang tidak berhak.
 */
function applyRoleVisibility() {
  const admin = isAdmin();
  for (const node of document.querySelectorAll('[data-role="admin"]')) {
    node.hidden = !admin;
  }
}

/* ===================================================================== login */
$('#login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  void api.clientEvent('form-dikirim', String($('#login-user').value || '(kosong)'));
  const errorNode = $('#login-error');
  errorNode.hidden = true;

  try {
    const result = await api.login($('#login-user').value, $('#login-pass').value);
    void api.clientEvent('login-200', result.user?.username || '');
    state.me = result.user;
    ui.userName.textContent = result.user.username;
    // Layar login disembunyikan di dalam enterDesktop(). Kalau pemanggilannya
    // gagal setelah titik itu, pesan ke errorNode tidak terlihat lagi karena
    // elemennya ada di layar yang sudah tertutup - user hanya melihat desktop
    // kosong tanpa alasan.
    await enterDesktop();
  } catch (err) {
    errorNode.textContent = err.message;
    errorNode.hidden = false;
    showError(err.message);
    api.reportClientError({
      where: 'login',
      message: err.message,
      stack: err?.stack || '',
    });
  }
});

/* =================================================================== desktop */
async function enterDesktop() {
  void api.clientEvent('enter-desktop');
  ui.login.hidden = true;
  ui.desktop.hidden = false;
  void api.clientEvent('layar-login-disembunyikan');

  state.wm = new WindowManager({ workspace: ui.workspace });
  // Panggil ulang tiap kali jendela bertambah, berkurang, atau fokus
  // berpindah: dock memakai ini untuk menandai aplikasi yang jalan, dan
  // menubar memakai perubahan fokus yang sama.
  state.wm.onChange = () => { renderDock(); renderMenus(); };
  // Fokus berpindah: menubar harus ikut berubah, dock tidak perlu dibangun
  // ulang karena isinya sama saja.
  state.wm.onFocusChange = () => renderMenus();
  state.wm.titleTarget = ui.topbarTitle;
  state.wm.setOverview({
    overlay: ui.overview,
    empty: ui.overviewEmpty,
  });

  applyRoleVisibility();
  void paintIdentity();
  void loadBootInfo();
  renderDock();
  renderMenus();
  paintIcons();
  tickClock();
  setInterval(tickClock, 15_000);
  // Panel kiri login memakai tema yang sama, jadi belum perlu paint ulang.
  document.body.dataset.themeReady = PanelThemes.current().id;

  void api.clientEvent('kerangka-siap');

  await refreshSessions();
  void api.clientEvent('sesi-terambil', `${state.sessions.length} sesi`);
  if (!state.sessions.length) openConnectModal();
  else openDesktop();
  void api.clientEvent('desktop-siap');
}

/**
 * Kepala menu sistem: nama peran di bawah nama akun, plus jumlah akun untuk
 * admin.
 *
 * Panggilan ke endpoint admin sengaja dibungkus try/catch: angka ini cuma
 * informasi, dan kegagalannya tidak boleh menggagalkan login.
 */
async function paintIdentity() {
  if (!state.me) return;

  ui.systemRole.textContent = state.me.role === 'admin' ? 'admin' : 'user';
  if (!isAdmin()) return;

  try {
    const { summary } = await api.listUsers();
    const live = summary.active;
    ui.systemAccounts.textContent = ` \u00b7 ${live} akun aktif dari ${summary.total}`;
  } catch {
    ui.systemAccounts.textContent = '';
  }
}

function tickClock() {
  ui.clock.textContent = new Date().toLocaleString('id-ID', {
    weekday: 'short', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
  });
}

/**
 * Ikon di HTML ditulis sebagai penanda `data-icon="nama"`, lalu diisi di sini
 * dari set SVG. Alasannya (lihat DESIGN.md): HTML tetap bebas emoji, dan
 * semua ikon berasal dari satu sumber sehingga bobot garisnya seragam.
 */
function paintIcons(root = document) {
  for (const node of root.querySelectorAll('[data-icon]')) {
    node.innerHTML = icons[node.dataset.icon] || '';
  }
}

/* ===================================================================== dock */
/* ================================================================= dock
   Struktur dash-to-dock milik Ubuntu: aplikasi yang DIPASANG selalu ada,
   lalu garis pemisah, lalu aplikasi lain yang sedang jalan. Sebelumnya dock
   hanya menampilkan "yang jalan", jadi tidak ada cara memindahkan aplikasi
   yang jarang dipakai ke bawah tanpa kehilangan ikonnya sama sekali. */

const FAVORITES_KEY = 'panel.favorites';

/** Ikon yang tidak DIPASANG akan hilang dari dock begitu tidak berjalan. */
function favorites() {
  let saved;
  try { saved = JSON.parse(localStorage.getItem(FAVORITES_KEY) || 'null'); } catch { saved = null; }

  // Default: semua aplikasi terpasang. Daftar kosong berarti "tidak ada yang
  // terpasang", jadi keduanya harus dibedakan - new Set(null) yang salah akan
  // membuat dock kosong total.
  const list = Array.isArray(saved) ? saved : APPS.map((a) => a.id);
  return new Set(list.filter((id) => APPS.some((a) => a.id === id)));
}

function setFavorites(ids) {
  localStorage.setItem(FAVORITES_KEY, JSON.stringify([...ids]));
  renderDock();
}

const isFavorite = (id) => favorites().has(id);

function toggleFavorite(app) {
  const set = favorites();
  if (set.has(app.id)) set.delete(app.id);
  else set.add(app.id);
  setFavorites(set);
  toast(`${app.name} ${set.has(app.id) ? 'dipasang ke dock' : 'dilepas dari dock'}.`);
}

function dockButton(app, running) {
  const el_ = el('button', {
    dataset: { dockApp: app.id },
    class: `dock-item${running.has(app.id) ? ' is-running' : ''}`,
    type: 'button',
    title: app.name,
    'aria-label': app.name,
    onClick: () => launch(app.id),
    onContextmenu: (event) => {
      event.preventDefault();
      contextMenu(event, [
        { label: 'Buka', onSelect: () => launch(app.id) },
        '-',
        {
          label: isFavorite(app.id) ? 'Lepas dari dock' : 'Pasang ke dock',
          onSelect: () => toggleFavorite(app),
        },
        '-',
        { label: 'Semua aplikasi', onSelect: showAppGrid },
      ]);
    },
  },
  el('span', { class: 'dock-icon', html: app.icon }),
  el('span', { class: 'dock-run', 'aria-hidden': 'true' }),
  el('span', { class: 'dock-label', text: app.name }));
  return el_;
}

function renderDock() {
  const running = new Set(
    [...(state.wm?.windows.values() || [])]
      .filter((w) => !w.disposed)
      .map((w) => w.appId),
  );

  const pinned = APPS.filter((a) => isFavorite(a.id));
  // Yang jalan tapi tidak dipasang. Aplikasi shell (Pengaturan, Pengguna)
  // sengaja tidak ikut: GNOME juga tidak menaruh Settings di dock.
  const loose = APPS.filter((a) => !isFavorite(a.id) && running.has(a.id));

  // PENTING: array harus disebar dengan "...". replaceChildren() hanya menerima
  // Node atau string, jadi array tanpa spread akan diubah jadi teks
  // "[object HTMLButtonElement],..." dan tombolnya hilang.
  ui.dock.replaceChildren(
    ...pinned.map((app) => dockButton(app, running)),

    // Pemisah hanya digambar kalau ada isi di sisinya: garis yang menggantung
    // di dasar dock terlihat seperti ada sesuatu yang belum termuat.
    loose.length
      ? el('div', { class: 'dock-sep', 'aria-hidden': 'true' })
      : null,
    ...loose.map((app) => dockButton(app, running)),

    el('button', {
      id: 'btn-show-apps',
      class: 'dock-item is-show-apps',
      type: 'button',
      title: 'Semua aplikasi (Super)',
      'aria-label': 'Semua aplikasi',
      onClick: showAppGrid,
    }, el('span', { class: 'dock-icon', html: icons.grid })),
  );
}

/* ================================================================ overview */
/* ====================================================== info & aksi shell */

const bootInfo = { version: '', node: '', uptime: '', users: null };

/**
 * Info dasar server, diambil sekali saat masuk.
 *
 * /api/health sengaja tidak mengembalikan versi atau jumlah akun - itu
 * informasi yang tidak perlu dan menambah jejak audit. Jadi
 * jumlah akun diambil dari endpoint admin yang sudah ada, dan kalau bukan
 * admin field-nya dibiarkan kosong.
 */
async function loadBootInfo() {
  try {
    const res = await fetch('/api/health', { credentials: 'same-origin' });
    const data = await res.json();
    bootInfo.node = navigator.userAgent.match(/Node[^ )]*/) ? 'peramban' : '-';
    bootInfo.uptime = `${Math.floor(data.uptime / 3600)} jam ${Math.floor((data.uptime % 3600) / 60)} menit`;
    bootInfo.version = '1.0';
  } catch { /* panel tetap jalan tanpa info */ }

  if (isAdmin()) {
    try {
      const { summary } = await api.listUsers();
      bootInfo.users = summary.active;
    } catch { /* biarkan kosong */ }
  }
}

/** Putuskan satu sesi SSH tanpa menutup jendela aplikasi. */
async function disconnectSessionById(id) {
  try {
    await api.disconnect(id);
    await refreshSessions();
    for (const win of [...(state.wm?.windows.values() || [])]) {
      if (win.sessionId === id) win.close();
    }
    closeWindowsForSession(id);
    toast('Sesi diputus.');
  } catch (err) {
    toast(err.message, 'error');
  }
}

/** Putuskan seluruh sesi milik user ini. */
async function disconnectAllSessions() {
  const ok = await confirmDialog({
    title: 'Putuskan semua sesi?',
    message: `${state.sessions.length} koneksi SSH akan ditutup. Jendela yang menampilkannya ikut tertutup.`,
    confirmText: 'Putuskan semua',
    danger: true,
  });
  if (!ok) return;

  for (const session of [...state.sessions]) {
    await api.disconnect(session.id).catch(() => {});
  }
  await refreshSessions();
  closeWindowsForSession(null);
  toast('Semua sesi diputus.');
}

/** Tutup jendela yang terikat ke sesi tertentu, atau semua bila null. */
function closeWindowsForSession(id) {
  for (const win of [...(state.wm?.windows.values() || [])]) {
    if (id === null || win.sessionId === id) win.close();
  }
}

/** Pintasan keyboard, dipanggil dari menu Bantuan setiap aplikasi. */
function openShortcuts() {
  launch('settings', { page: 'keyboard', key: 'settings', unique: true });
}

/**
 * Dialog daya ala GNOME.
 *
 * GNOME punya Suspend / Restart / Matikan. Tiga hal itu tidak punya arti
 * jujur di sini: panel ini berjalan di dalam peramban orang, bukan di mesin
 * mereka. Yang ditampilkan hanya dua aksi yang benar-benar terjadi, dan
 * kalimatnya menjelaskan kenapa sisanya tidak ada - menu yang terlihat
 * lengkap tapi tombolnya tidak berfungsi akan lebih buruk daripada menu
 * yang jujur hanya punya dua.
 */
function openPowerDialog() {
  const sessions = state.sessions.length;
  confirmDialog({
    title: 'Matikan / Keluar',
    message: [
      sessions > 0
        ? `Ada ${sessions} sesi SSH terbuka. Putuskan semuanya sebelum keluar, atau biarkan terputus otomatis.`
        : 'Tidak ada sesi SSH yang terbuka.',
      '',
      'Suspend, Restart, dan Matikan tidak ditampilkan: ketiganya tentang mesin ini,'
        + 'bukan panel. Panel juga tidak bisa menyalakan ulang dirinya sendiri tanpa '
        + 'supervisor di luar cakupannya.',
    ].join('\n'),
    confirmText: 'Keluar',
    danger: true,
  }).then((ok) => { if (ok) logout(); });
  return undefined;
}

/* ============================================================ app grid
   Super membuka daftar aplikasi, sedangkan Alt+Tab atau tombol Activities
   berpindah antar jendela - persis pembagiannya di GNOME.

   Bentuknya meniru Show Applications: daftar kategori di kiri, kisi aplikasi
   di kanan, dan pencarian yang menutupi keduanya. Kategori dipilih karena
   GNOME-nya yang punya, dan karena dengan hanya enam aplikasi daftar kategori
   jadi lebih berguna daripada satu baris panjang yang tidak bisa dipindai. */

const APP_CATEGORY = {
  terminal: 'Terminal',
  files: 'Berkas',
  editor: 'Berkas',
  sysmon: 'Sistem',
  processes: 'Sistem',
  disk: 'Sistem',
  users: 'Administrasi',
  browser: 'Internet',
  settings: 'Sistem',
};

/** Dipakai(app) -> "Semua", atau nama kategorinya. */
const RECENT_KEY = 'panel.recentApps';

function recentApps() {
  try {
    const list = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]');
    return Array.isArray(list) ? list : [];
  } catch { return []; }
}

function noteAppUsed(appId) {
  const next = [appId, ...recentApps().filter((id) => id !== appId)].slice(0, 6);
  localStorage.setItem(RECENT_KEY, JSON.stringify(next));
}

/**
 * @param {string} filter  teks pencarian; saat tidak kosong kategori disembunyikan
 * @param {string} category  'Semua' atau nama kategori
 */
function renderAppGrid(filter = '', category = state.appGridCategory || 'Semua') {
  const needle = filter.trim().toLowerCase();
  const items = ui.appgridItems;
  items.replaceChildren();

  const pool = allApps();
  const inCategory = (app) => category === 'Semua' || APP_CATEGORY[app.id] === category;

  // Pencarian selalu mencari seluruh katalog, bukan hanya kategori aktif:
  // orang yang mengetik "peng" tidak perlu memilih kategori yang benar untuk
  // menemukan Pengaturan.
  let matches = pool.filter((app) => app.name.toLowerCase().includes(needle)
    || (APP_CATEGORY[app.id] || '').toLowerCase().includes(needle));
  if (!needle) matches = matches.filter(inCategory);

  if (category === 'Baru dipakai' && !needle) {
    const recent = recentApps().map((id) => pool.find((a) => a.id === id)).filter(Boolean);
    if (recent.length) matches = recent;
  }

  if (!matches.length) {
    items.append(el('div', {
      class: 'appgrid-empty',
      text: needle ? `Tidak ada aplikasi bernama "${filter}".` : `Tidak ada aplikasi di ${category}.`,
    }));
    renderCategoryNav();
    return;
  }

  matches.forEach((app, i) => {
    items.append(el('button', {
      class: `appgrid-item${i === 0 ? ' is-focus' : ''}`,
      type: 'button',
      tabindex: '-1',
      onClick: () => { hideAppGrid(); noteAppUsed(app.id); launch(app.id); },
      onMouseenter: (e) => {
        [...items.children].forEach((n) => n.classList.remove('is-focus'));
        e.currentTarget.classList.add('is-focus');
      },
    },
    el('span', { class: 'dock-icon', html: app.icon }),
    el('span', { text: app.name })));
  });

  renderCategoryNav();
}

function renderCategoryNav() {
  if (!ui.appgridCats) return;

  const pool = allApps();
  const names = [...new Set(pool.map((a) => APP_CATEGORY[a.id]).filter(Boolean))];
  const active = state.appGridCategory || 'Semua';

  const entries = ['Semua'];
  if (recentApps().length) entries.push('Baru dipakai');
  entries.push(...names);

  ui.appgridCats.replaceChildren(...entries.map((name) => el('button', {
    class: `appgrid-cat${name === active ? ' is-active' : ''}`,
    type: 'button',
    onClick: () => {
      state.appGridCategory = name;
      renderAppGrid(ui.appgridSearch.value, name);
    },
  }, el('span', { text: name }))));

  ui.appgridCats.hidden = ui.appgridSearch.value.trim().length > 0;
}

function showAppGrid() {
  state.wm.exitOverview();
  hideSystemMenu();
  hideQuickSettings();
  state.appGridCategory = 'Semua';
  ui.appgridSearch.value = '';
  renderAppGrid('');
  ui.appgrid.hidden = false;
  ui.appgridSearch.focus();
}

const hideAppGrid = () => { ui.appgrid.hidden = true; };

ui.appgridSearch.addEventListener('input', (event) => {
  // Mengetik memaksa kembali ke "Semua": bila tidak, hasil pencarian ikut
  // difilter kategori lama dan orang mengira aplikasinya hilang.
  state.appGridCategory = 'Semua';
  renderAppGrid(event.target.value);
});

/* ======================================================== quick settings
   Diklik dari jam, seperti GNOME: kalender, sesi SSH, dan aksi cepat. */
function showQuickSettings() {
  hideSystemMenu();
  hideAppGrid();
  const now = new Date();

  ui.qsDatetime.textContent = now.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });
  ui.qsDay.textContent = now.toLocaleDateString('id-ID', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
  });

  ui.qsSessions.replaceChildren();
  if (!state.sessions.length) {
    ui.qsSessions.append(el('div', { class: 'qs-empty', text: 'Belum ada koneksi SSH.' }));
  } else {
    for (const session of state.sessions) {
      ui.qsSessions.append(el('div', { class: 'qs-session' },
        el('span', { class: `dot ${session.id === state.activeSessionId ? 'dot-on' : 'dot-off'}` }),
        el('span', { class: 'mono', text: `${session.username}@${session.host}:${session.port}` }),
        el('span', { class: 'qs-auth', text: session.authMethod === 'key' ? 'key' : 'password' })));
    }
  }

  ui.quickSettings.hidden = false;
}

const hideQuickSettings = () => { ui.quickSettings.hidden = true; };

ui.clock.addEventListener('click', () => {
  if (ui.quickSettings.hidden) showQuickSettings();
  else hideQuickSettings();
});

$('#qs-users').addEventListener('click', () => { hideQuickSettings(); launch('users'); });
$('#qs-themes').addEventListener('click', () => { hideQuickSettings(); openThemePicker(); });
$('#qs-disconnect').addEventListener('click', () => { hideQuickSettings(); disconnectCurrent(); });
$('#qs-logout').addEventListener('click', () => { hideQuickSettings(); logout(); });

/* ============================================================ system menu */
function showSystemMenu() {
  ui.systemMenu.hidden = !ui.systemMenu.hidden;
  if (!ui.systemMenu.hidden) renderSaved();
}

document.addEventListener('pointerdown', (event) => {
  if (ui.systemMenu.hidden) return;
  // event.target bisa berupa Document/Window, yang tidak punya closest().
  const target = event.target;
  const inMenu = target instanceof Element && ui.systemMenu.contains(target);
  const onButton = target instanceof Element && !!target.closest('#btn-system');
  if (!inMenu && !onButton) ui.systemMenu.hidden = true;
});

// Quick settings ditutup dengan klik di luar, sama seperti menu sistem.
document.addEventListener('pointerdown', (event) => {
  if (ui.quickSettings.hidden) return;
  const target = event.target;
  const inside = target instanceof Element
    && (ui.quickSettings.contains(target) || target.closest('#clock'));
  if (!inside) hideQuickSettings();
});

$('#btn-system').addEventListener('click', showSystemMenu);
$('#btn-activities').addEventListener('click', () => state.wm.toggleOverview());
$('#btn-disconnect').addEventListener('click', disconnectCurrent);
$('#menu-disconnect').addEventListener('click', () => { hideSystemMenu(); disconnectCurrent(); });
$('#btn-new-connection').addEventListener('click', () => { hideSystemMenu(); openConnectModal(); });
$('#menu-open-files').addEventListener('click', () => { hideSystemMenu(); launch('files'); });
$('#menu-open-terminal').addEventListener('click', () => { hideSystemMenu(); launch('terminal'); });
$('#menu-logout').addEventListener('click', () => { hideSystemMenu(); logout(); });

const hideSystemMenu = () => { ui.systemMenu.hidden = true; };

function renderSaved() {
  const list = JSON.parse(localStorage.getItem('panel.savedServers') || '[]');
  let section = ui.systemMenu.querySelector('.system-saved');
  if (!section) {
    section = el('div', { class: 'system-section system-saved' });
    ui.systemMenu.insertBefore(section, ui.systemMenu.lastElementChild);
  }
  if (!list.length) { section.replaceChildren(); return; }

  section.replaceChildren(
    el('div', { class: 'system-sep' }),
    ...list.map((entry) => el('button', {
      class: 'system-item',
      type: 'button',
      onClick: () => { hideSystemMenu(); prefillConnect(entry); },
    },
    el('span', { class: 'si-icon', html: icons.bolt }),
    el('span', { text: `${entry.username}@${entry.host}` }))),
  );
}

/* ================================================================ sesi SSH */
async function refreshSessions() {
  const data = await api.listSessions().catch(() => ({ sessions: [] }));
  state.sessions = data.sessions;

  if (state.sessions.length && !state.sessions.some((s) => s.id === state.activeSessionId)) {
    state.activeSessionId = state.sessions[state.sessions.length - 1].id;
  }
  renderSessionPicker();
}

function renderSessionPicker() {
  ui.sessionPicker.replaceChildren();
  for (const session of state.sessions) {
    ui.sessionPicker.append(el('option', {
      value: session.id,
      selected: session.id === state.activeSessionId,
      text: `${session.username}@${session.host}:${session.port}`,
    }));
  }
  if (!state.sessions.length) {
    ui.sessionPicker.append(el('option', { text: 'Belum ada koneksi' }));
  }
}

ui.sessionPicker.addEventListener('change', (event) => {
  state.activeSessionId = event.target.value;
  setStatus(true);
  renderSessionPicker();
});

const activeSession = () => state.sessions.find((s) => s.id === state.activeSessionId) || null;

function setStatus(online) {
  ui.connStatus.className = `dot ${online ? 'dot-on' : 'dot-off'}`;
  ui.connLabel.textContent = online ? 'SSH aktif' : 'Putus';
}

/**
 * Putuskan sesi SSH milik user ini saja.
 *
 * Endpoint-nya sudah difilter per userId di server, jadi ini tidak mungkin
 * menyentuh koneksi milik orang lain.
 */
async function disconnectCurrent() {
  const session = activeSession();
  if (!session) return toast('Tidak ada sesi SSH untuk diputus.', 'warn');

  const ok = await confirmDialog({
    title: 'Putuskan koneksi?',
    message: `Sesi SSH ke ${session.username}@${session.host}:${session.port} akan ditutup.`,
    confirmText: 'Putuskan',
    danger: true,
  });
  if (!ok) return;

  await api.disconnect(session.id).catch(() => {});
  await refreshSessions();
  if (!state.sessions.length) openConnectModal();
  else renderSessionPicker();
}

async function logout() {
  const ok = await confirmDialog({
    title: 'Keluar dari panel?',
    message: 'Semua sesi SSH akan diputus dan jendela yang terbuka akan hilang.',
    confirmText: 'Keluar',
    danger: true,
  });
  if (!ok) return;
  await api.logout().catch(() => {});
  location.reload();
}

/**
 * Ganti password panel milik user sendiri.
 *
 * Setelah berhasil, server memutus semua sesi milik akun itu (termasuk yang di
 * perangkat lain), jadi panel memaksa login ulang. Itu bukan gangguan: kalau
 * ada cookie lama yang sudah dicuri, ia harus ikut mati.
 */
async function changeOwnPassword() {
  const current = await promptDialog({
    title: 'Ganti password',
    label: 'Password saat ini',
    confirmText: 'Lanjut',
  });
  if (!current) return;

  const next = await promptDialog({
    title: 'Ganti password',
    label: 'Password baru (minimal 8 karakter)',
    confirmText: 'Simpan',
  });
  if (!next) return;

  try {
    await api.changeOwnPassword(current, next);
  } catch (err) {
    toast(err.message, 'error');
    return;
  }

  toast('Password diganti. Silakan login ulang.');
  await api.logout().catch(() => {});
  location.reload();
}

/* ============================================================ pemilih tema */
const themeModal = $('#theme-modal');

function renderThemeGrid() {
  const grid = $('#theme-grid');
  const activeId = PanelThemes.current().id;

  grid.replaceChildren(...PanelThemes.THEMES.map((theme) => {
    const isActive = theme.id === activeId;

    // Swatch memakai warna asli tema, jadi pilihan terlihat sebelum diklik.
    // Empat petak: latar, permukaan, headerbar, aksen.
    const swatch = el('span', { class: 'theme-swatch' },
      el('i', { style: { background: theme.base.bg } }),
      el('i', { style: { background: theme.base.bgAlt } }),
      el('i', { style: { background: theme.base.bgHigh } }),
      el('i', { class: 'is-accent', style: { background: theme.base.accent } }));

    return el('button', {
      class: `theme-card${isActive ? ' is-active' : ''}`,
      type: 'button',
      'aria-pressed': isActive ? 'true' : 'false',
      'data-theme-id': theme.id,
      onClick: () => {
        PanelThemes.apply(theme.id);
        renderThemeGrid();
        toast(`Tema ${theme.name} dipakai.`);
      },
    },
    swatch,
    el('span', { class: 'theme-name', text: theme.name }),
    el('span', { class: 'theme-note', text: theme.note }),
    isActive ? el('span', { class: 'theme-current', text: 'Sedang dipakai' }) : null);
  }));
}

function openThemePicker() {
  hideSystemMenu();
  renderThemeGrid();
  themeModal.hidden = false;
}

$('#menu-themes').addEventListener('click', openThemePicker);
$('#menu-users').addEventListener('click', () => { hideSystemMenu(); launch('users'); });
$('#menu-settings').addEventListener('click', () => { hideSystemMenu(); launch('settings'); });
$('#menu-shortcuts').addEventListener('click', () => { hideSystemMenu(); openShortcuts(); });
$('#menu-power').addEventListener('click', () => { hideSystemMenu(); openPowerDialog(); });
$('#menu-open-monitor').addEventListener('click', () => { hideSystemMenu(); launch('sysmon'); });
$('#menu-open-show-apps').addEventListener('click', () => { hideSystemMenu(); showAppGrid(); });
$('#menu-password').addEventListener('click', () => { hideSystemMenu(); changeOwnPassword(); });
$('#btn-close-themes').addEventListener('click', () => { themeModal.hidden = true; });
themeModal.querySelector('.modal-backdrop').addEventListener('click', () => { themeModal.hidden = true; });
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !themeModal.hidden) themeModal.hidden = true;
});

/* ============================================ menu klik kanan di desktop
   GNOME punya menu ini; isinya sesuai, bukan tempelan: setiap item benar-benar
   melakukan sesuatu, dan yang tidak bisa dilakukan sengaja tidak ada. */
ui.workspace.addEventListener('contextmenu', (event) => {
  if (event.target.closest('.win')) return; // biarkan menu konteks file manager
  event.preventDefault();

  const session = activeSession();
  const home = session?.home || '/';
  const focused = state.wm?.focusedWindow() || null;

  // Susunan meniru menu desktop Ubuntu: yang sering dipakai dulu, lalu
  // pengaturan, lalu sisanya. "Tampilan Layar" di Ubuntu membuka panel
  // Displays; padanannya yang jujur di sini adalah snap layout, jadi itu
  // yang dipakai - bukan tombol yang tidak melakukan apa-apa.
  contextMenu(event, [
    {
      label: 'Buka Terminal',
      disabled: !session,
      onSelect: () => launch('terminal'),
    },
    {
      label: 'Folder baru di beranda',
      disabled: !session,
      onSelect: async () => {
        const name = await promptDialog({ title: 'Folder baru', label: 'Nama folder', confirmText: 'Buat' });
        if (!name) return;
        try {
          await api.mkdir(session.id, `${home.replace(/\/+$/, '')}/${name}`);
          toast(`Folder ${name} dibuat di ${home}.`);
        } catch (err) { toast(err.message, 'error'); }
      },
    },
    '-',
    {
      label: 'Pengaturan Layar',
      disabled: !focused,
      onSelect: () => state.wm.tiling.showLayoutPicker(focused, focused.querySelector('.win-btn[aria-label="Perbesar"]')),
    },
    { label: 'Ganti Latar', onSelect: openThemePicker },
    { label: 'Pengaturan', onSelect: () => launch('settings') },
    '-',
    { label: 'Semua Aplikasi', onSelect: showAppGrid },
    { label: 'Tampilkan Jendela', onSelect: () => state.wm.enterOverview() },
    '-',
    {
      label: 'Putuskan Sesi',
      disabled: !session,
      onSelect: disconnectCurrent,
    },
    {
      label: 'Koneksi Baru',
      disabled: !!session,
      onSelect: openConnectModal,
    },
  ]);
});


/* ================================================================ aplikasi */
function appContext(extra = {}) {
  const cleanups = [];
  let win = null;
  let menus = () => [];

  return {
    ctx: {
      session: activeSession(),
      api,
      registerCleanup: (fn) => cleanups.push(fn),
      launch: (appId, options) => launch(appId, options),
      openEditor: (path) => launch('editor', { path, key: `editor:${path}` }),
      // Menu aplikasi. Isinya boleh fungsi supaya bisa ikut berubah; begitu
      // juga mengaftarkannya lagi setelah ada yang berubah (mis. jumlah tab).
      // Dipakai aplikasi shell (Pengaturan) yang tidak punya
      // koneksi SSH tapi tetap perlu tahu state panel.
      getSessions: () => state.sessions,
      disconnectSession: (id) => disconnectSessionById(id),
      disconnectAll: () => disconnectAllSessions(),
      changeOwnPassword: () => changeOwnPassword(),
      bootInfo: () => bootInfo,
      ...extra,
      setMenus: (spec) => { menus = typeof spec === 'function' ? spec : () => spec; },
      refreshMenus: () => {
        if (state.activeWin === win) renderMenus();
      },
      ...extra,
    },
    bind: (w) => {
      win = w;
      w.getMenus = () => {
        const own = typeof menus === 'function' ? menus() : [];

        // Menu bawaan hanya diisi kalau aplikasinya tidak punya menunya
        // sendiri. Tanpa ini setiap aplikasi yang punya "Berkas" sendiri
        // akan mendapat dua judul "Berkas" di top bar, dan dua "Tutup"
        // dengan isi berbeda - yang sangat membingungkan.
        const has = (label) => own.some((m) => m.label === label);

        const defaults = [];
        if (!has('Berkas')) {
          defaults.push({
            label: 'Berkas',
            items: () => [{ label: 'Tutup', hint: 'Ctrl+W', onSelect: () => w.close() }],
          });
        }
        if (!has('Bantuan')) {
          defaults.push({
            label: 'Bantuan',
            items: () => [{ label: 'Pintasan Keyboard', onSelect: openShortcuts }],
          });
        }

        // Menu aplikasi dulu, baru bawaan. Menaruh bawaan di depan membuat
        // urutan judul jadi "Bantuan | Berkas | Tampilan", yang tidak menyerupai
        // aplikasi desktop sama sekali.
        return own.concat(defaults);
      };
      renderMenus();
    },
    runCleanups: () => cleanups.splice(0).forEach((fn) => { try { fn(); } catch { /* abaikan */ } }),
  };
}

function launch(appId, options = {}) {
  const app = visibleApps().concat(SHELL_APPS).find((a) => a.id === appId);
  const session = activeSession();

  if (!app) return toast('Aplikasi tidak dikenal.', 'error');

  // Aplikasi admin punya role; user biasa tidak akan pernah mendeteksinya
  // lewat launch(), dan endpoint-nya juga menolak.
  if (app.role && app.role !== state.me?.role) {
    return toast('Aplikasi ini hanya untuk admin.', 'error');
  }

  // Sebagian aplikasi bekerja pada panel itu sendiri (bukan pada VPS), jadi
  // tidak wajar memaksa membuat koneksi SSH dulu untuk melihat daftar akun.
  if (!app.needsSession && !session) {
    return openApp(app, options);
  }

  if (!session) {
    toast('Belum ada koneksi SSH. Buat koneksi dulu.', 'warn');
    openConnectModal();
    return null;
  }

  // Aplikasi yang butuh path awal memakai home user remote.
  const home = session.home || session.fsRoot || '/';
  return openApp(app, options, {
    path: options.path,
    startPath: options.startPath ?? (['files', 'disk'].includes(app.id) ? home : undefined),
  });
}

/**
 * Bagian launch() yang benar-benar membuka jendela.
 *
 * Dipisah supaya jalur "tidak butuh sesi SSH" bisa memakainya tanpa mengarang
 * objek sesi palsu.
 */
function openApp(app, options = {}, extra = {}) {
  // Dipisah dari appContext karena onClose dijalankan WM, di luar scope
  // tempat ctx dibuat; tanpa itu referensi `win` tidak ada di situ.
  const { ctx, runCleanups, bind } = appContext({
    path: options.path,
    startPath: options.startPath,
    me: state.me,
    isAdmin,
    ...extra,
  });

  return state.wm.open({
    key: options.key || app.id,
    appId: app.id,
    // Jendelanya mencatat sesi mana yang menampilkannya. Tanpa ini, disconnect
    // dari menu Pengaturan akan memutus koneksi tapi meninggalkan jendela
    // yang menampilkan shell yang sudah tidak ada.
    sessionId: ctx.session?.id || null,
    title: app.name,
    icon: app.icon,
    width: options.width || 1000,
    height: options.height || 620,
    resizable: app.resizable !== false,
    unique: options.unique !== false,
    onMount: (body, win) => {
      ctx.win = win;
      bind(win);
      app.mount(body, ctx);
      // Aplikasi boleh mendaftarkan menu-nya di dalam mount(), jadi render
      // terakhir dilakukan setelah mount, bukan sebelum.
      renderMenus();
    },
    onClose: async () => {
      if (ctx.onBeforeClose && !(await ctx.onBeforeClose())) return;
      runCleanups();
      menubar.render([]);
      renderMenus();
    },
  });
}

/* ===================================================================== modal */
const modal = $('#connect-modal');
const openConnectModal = () => { modal.hidden = false; $('#c-host').focus(); };

/**
 * Menutup modal juga membuang isi form. Private key tidak boleh bertahan di
 * DOM atau variabel modul lebih lama dari satu percobaan koneksi.
 */
const closeModal = () => {
  modal.hidden = true;
  resetCredentials();
};

function resetCredentials() {
  $('#c-password').value = '';
  $('#c-key').value = '';
  $('#c-passphrase').value = '';
  $('#c-keyfile').value = '';
  setKeyStatus('');
}

/** Buang isi key dari seluruh variabel yang menyalinnya. */
let pastedKey = '';

function currentKey() {
  return ($('#c-key').value || pastedKey || '').trim();
}

function setKeyStatus(text, kind = '') {
  const node = $('#key-status');
  node.textContent = text;
  node.className = `key-status${kind ? ` is-${kind}` : ''}`;
}

$('#btn-cancel-connect').addEventListener('click', closeModal);
$('#btn-cancel-connect-2').addEventListener('click', closeModal);
modal.querySelector('.modal-backdrop').addEventListener('click', closeModal);

$('#toggle-pass').addEventListener('click', () => {
  const field = $('#c-password');
  const isHidden = field.type === 'password';
  field.type = isHidden ? 'text' : 'password';
  $('#toggle-pass').textContent = isHidden ? 'sembunyikan' : 'lihat';
});

/* -------------------------------- preset username AWS ------------------------ */
document.querySelectorAll('.preset-chip').forEach((chip) => {
  chip.addEventListener('click', () => {
    $('#c-username').value = chip.dataset.username;
  });
});

/* ------------------------------ pilihan metode ------------------------------ */
let authMethod = 'password';

function setAuthMethod(method, { focus = true } = {}) {
  authMethod = method;
  const isKey = method === 'key';

  $('#m-password').classList.toggle('is-active', !isKey);
  $('#m-key').classList.toggle('is-active', isKey);
  $('#m-password').setAttribute('aria-checked', String(!isKey));
  $('#m-key').setAttribute('aria-checked', String(isKey));

  $('#pane-password').hidden = isKey;
  $('#pane-key').hidden = !isKey;
  // required ikut pindah, supaya submit tidak bisa tanpa metode yang dipilih.
  // Atribut ini wajib benar sejak awal, bukan hanya setelah tombol diklik.
  $('#c-password').required = !isKey;
  if (focus) ($(isKey ? '#c-key' : '#c-password')).focus();
}

$('#m-password').addEventListener('click', () => setAuthMethod('password'));
$('#m-key').addEventListener('click', () => setAuthMethod('key'));
// Terapkan state awal lewat jalur yang sama supaya tidak ada perbedaan
// antara "baru dimuat" dan "sudah diklik".
setAuthMethod('password', { focus: false });

/* --------------------------------- private key ------------------------------ */
$('#c-keyfile').addEventListener('change', (event) => {
  const file = event.target.files?.[0];
  if (!file) return;

  // Dibaca di browser lalu hanya ada di memori tab ini.
  const reader = new FileReader();
  setKeyStatus(`Membaca ${file.name}...`, 'busy');
  reader.onload = () => {
    pastedKey = String(reader.result || '');
    $('#c-key').value = pastedKey;
    setKeyStatus(`${file.name} dimuat (${Math.round(file.size / 1024)} KB). Tekan "Periksa key".`, 'ok');
  };
  reader.onerror = () => setKeyStatus('Gagal membaca file.', 'err');
  reader.readAsText(file);
});

$('#c-key-clear').addEventListener('click', () => {
  pastedKey = '';
  $('#c-key').value = '';
  $('#c-keyfile').value = '';
  setKeyStatus('');
});

$('#c-key-check').addEventListener('click', async () => {
  const key = currentKey();
  if (!key) return setKeyStatus('Isi private key dulu.', 'err');

  const button = $('#c-key-check');
  button.disabled = true;
  setKeyStatus('Memeriksa key...', 'busy');

  try {
    const result = await api.validateKey({
      privateKey: key,
      passphrase: $('#c-passphrase').value,
    });
    setKeyStatus(`Key valid: ${result.type}, ${result.format}.`, 'ok');
  } catch (err) {
    setKeyStatus(err.message, 'err');
  } finally {
    button.disabled = false;
  }
});

function prefillConnect(entry) {
  $('#c-host').value = entry.host;
  $('#c-port').value = entry.port;
  $('#c-username').value = entry.username;
  openConnectModal();
}

$('#connect-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const errorNode = $('#connect-error');
  const submit = $('#connect-submit');

  const target = {
    host: $('#c-host').value.trim(),
    port: Number.parseInt($('#c-port').value, 10) || 22,
    username: $('#c-username').value.trim(),
    authMethod,
    password: '',
    privateKey: '',
    passphrase: '',
  };

  if (authMethod === 'password') {
    target.password = $('#c-password').value;
  } else {
    target.privateKey = currentKey();
    target.passphrase = $('#c-passphrase').value;
    if (!target.privateKey) {
      errorNode.textContent = 'Private key belum diisi: pilih file .pem atau tempel isinya.';
      errorNode.hidden = false;
      return;
    }
  }

  errorNode.hidden = true;
  submit.disabled = true;
  submit.textContent = 'Menghubungkan\u2026';

  try {
    if ($('#c-remember').checked) {
      const list = JSON.parse(localStorage.getItem('panel.savedServers') || '[]');
      const entry = { id: crypto.randomUUID(), host: target.host, port: target.port, username: target.username };
      localStorage.setItem('panel.savedServers',
        JSON.stringify([...list.filter((s) => !(s.host === entry.host && s.port === entry.port)), entry]));
    }

    const { session } = await api.connect(target);
    closeModal();
    pastedKey = '';

    state.activeSessionId = session.id;
    await refreshSessions();
    renderSessionPicker();
    openDesktop();
  } catch (err) {
    errorNode.textContent = err.message;
    errorNode.hidden = false;
    // Kredensial tetap dikosongkan supaya percobaan ulang tidak
    // diam-diam mengirim key yang sama padahal sudah jelas ditolak.
    if (authMethod === 'password') $('#c-password').value = '';
  } finally {
    submit.disabled = false;
    submit.textContent = 'Hubungkan';
  }
});

function openDesktop() {
  if (!activeSession()) return openConnectModal();
  setStatus(true);
  if (!state.wm.windows.size) launch('terminal', { width: 1000, height: 620 });
}

/* ======================================================== tombol papan tik */

/**
 * Pemetaan Super/Alt + panah, sama seperti Windows: kiri dan kanan meny snap,
 * atas memperbesar, bawah mengembalikan.
 *
 * Super sering sudah dimakan sistem operasi, jadi Alt+panah memakai jalan yang
 * sama - bukan implementasi terpisah yang bisa berbeda hasilnya.
 *
 * Tidak ada "separuh bawah" di sini, dan itu disengaja: di Windows Super+Bawah
 * adalah restore. Separuh bawah tetap bisa lewat drag ke tepi bawah, pojok,
 * klik kanan judul, atau snap layout.
 */
const ARROW_REGION = {
  ArrowLeft: 'left',
  ArrowRight: 'right',
  ArrowUp: 'maximize',
  ArrowDown: 'restore',
};

document.addEventListener('keydown', (event) => {
  if (ui.desktop.hidden) return;

  /* ------------------------------------- Super + panah: snap ala Windows */
  if ((event.metaKey || event.altKey) && ARROW_REGION[event.key]) {
    event.preventDefault();
    const win = state.wm.focusedWindow();
    if (!win) return;

    const region = ARROW_REGION[event.key];
    if (region === 'maximize') {
      win.maximize();
    } else if (region === 'restore') {
      // Sama seperti Windows: yang sudah dilepas tidak melakukan apa-apa,
      // dan yang menempel di petak dilepas dari petaknya.
      if (!win.restoreDown() && state.wm.tiling.isTiled(win)) state.wm.tiling.float(win);
    } else {
      state.wm.tiling.snap(win, region);
    }
    return;
  }

  // Pintasan manajemen jendela diperiksa SEBELUM penjaga input di bawah. xterm
  // memakai <textarea> tersembunyi, jadi penjaga input akan menelan semua
  // pintasan selama terminal fokus - padahal Super+panah harus tetap bekerja,
  // sama seperti di Windows.
  //
  // event.target tidak selalu Element (bisa Document saat tidak ada yang fokus),
  // jadi periksa dulu sebelum memanggil matches().
  const target = event.target;
  if (target instanceof Element && target.matches('input, textarea, select, [contenteditable]')) return;

  // Super / OS: buka app grid — default-nya GNOME, bukan daftar jendela
  if (event.key === 'Meta' || event.key === 'OS') {
    event.preventDefault();
    if (ui.appgrid.hidden) showAppGrid();
    else hideAppGrid();
    return;
  }

  if (event.key === 'Escape') {
    if (!modal.hidden) { closeModal(); return; }
    if (!ui.systemMenu.hidden) { hideSystemMenu(); return; }
    if (!ui.quickSettings.hidden) { hideQuickSettings(); return; }
    if (!ui.appgrid.hidden) { hideAppGrid(); return; }
    if (menubar.isOpen) { menubar.close(); return; }
    if (!themeModal.hidden) { themeModal.hidden = true; return; }
    state.wm.exitOverview();
    return;
  }

  // Ctrl+Alt+T: terminal baru
  if (event.ctrlKey && event.altKey && event.key.toLowerCase() === 't') {
    event.preventDefault();
    launch('terminal', { key: `terminal-${Date.now()}`, unique: false });
    return;
  }

  // Alt+F4: tutup jendela terfokus
  if (event.altKey && event.key === 'F4') {
    event.preventDefault();
    state.wm.focusedWindow()?.close();
    return;
  }

  // Alt+Tab: pindah jendela
  if (event.altKey && event.key === 'Tab') {
    event.preventDefault();
    const visible = [...state.wm.windows.values()].filter((w) => !w.minimized && !w.disposed);
    if (visible.length < 2) return;
    const current = visible.findIndex((w) => w.node.classList.contains('is-active'));
    visible[(current + 1) % visible.length].focus();
  }
});

/* ================================================================ startup */

/**
 * Pasang penangkap error global.
 *
 * Dua alasan. Pertama, kegagalan JavaScript sebelumnya buta: server melihat
 * login 200 dan semua endpoint berikutnya 200, sementara halamannya diam -
 * tidak ada jejak di server dan tidak ada pesan di layar.
 *
 * Kedua, dan yang lebih penting: handler login menulis pesan kesalahan ke
 * elemen di LAYAR LOGIN - yang pada saat itu sudah disembunyikan. Jadi ketika
 * enterDesktop() gagal, user melihat desktop kosong tanpa penjelasan apa pun.
 * showError() menampilkannya di tempat yang benar-benar terlihat.
 */
function showError(message) {
  // 1. Layar login, kalau sedang terlihat.
  const loginErr = document.getElementById('login-error');
  if (loginErr && !ui.login.hidden) {
    loginErr.textContent = message;
    loginErr.hidden = false;
  }

  // 2. Selalu: panel galat di dalam desktop, yang tidak mungkin terlewat.
  let box = document.getElementById('fatal-error');
  if (!box) {
    box = el('div', { id: 'fatal-error', class: 'fatal-error', hidden: true });
    (ui.desktop || document.body).prepend(box);
  }
  box.replaceChildren(
    el('div', { class: 'fatal-error-title', text: 'Ada yang gagal di halaman ini' }),
    el('div', { class: 'fatal-error-msg', text: message }),
    el('div', { class: 'fatal-error-note', text: 'Detail teknisnya sudah dicatat di log server.' }),
  );
  box.hidden = false;
}

function installErrorReporting() {
  window.addEventListener('error', (e) => {
    const message = e.message || String(e.error || 'Error tidak diketahui');
    api.reportClientError({
      where: `${e.filename || '?'}:${e.lineno || 0}`,
      message,
      stack: e.error?.stack || '',
    });
    showError(message);
  });

  window.addEventListener('unhandledrejection', (e) => {
    const reason = e.reason;
    const message = reason?.message || String(reason || 'Promise ditolak tanpa alasan');
    api.reportClientError({
      where: 'unhandledrejection',
      message,
      stack: reason?.stack || '',
    });
    showError(message);
  });
}

installErrorReporting();

(async function init() {
  renderSessionPicker();
  void api.clientEvent('halaman-muat');
  try {
    const info = await api.session();
    if (!info.authenticated) {
      ui.login.hidden = false;
      return;
    }
    ui.userName.textContent = info.username;
    void api.clientEvent('init-terautentikasi', info.username || '');
    await enterDesktop();
  } catch (err) {
    ui.login.hidden = false;
    showError(err?.message || 'Gagal memuat sesi.');
    api.reportClientError({
      where: 'init',
      message: err?.message || String(err),
      stack: err?.stack || '',
    });
  }
})();

window.__desktop = { state, launch, api };