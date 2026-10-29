/**
 * Set ikon SVG sendiri, bukan emoji.
 *
 * Dua alasan (lihat DESIGN.md): bentuk emoji berubah antar platform dan
 * hilang total di klien tanpa font warna, sedangkan panel ini menyajikan
 * shell yang harus tampil sama di mana pun. Ikon digambar pada viewBox
 * 16x16 dengan stroke 1.4px dan ujung bulat, mengikuti bobot ikon GNOME.
 *
 * Semua ikon mengembalikan string SVG untuk dipasang lewat `html:` pada
 * helper el().
 */

const svg = (paths, extra = '') => `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor"
  stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"
  aria-hidden="true" focusable="false" ${extra}>${paths}</svg>`;

/* ------------------------------------------------------------- aplikasi */
export const icons = {
  // Prompt shell: chevron + garis bawah. Stroke 1.4px sengaja somber agar
  // tidak bersaing dengan teks di dalam terminal.
  terminal: svg('<path d="M3.5 4.5 6.5 7.5 3.5 10.5"/><path d="M8.5 11h4.5"/>'),

  // Folder tertutup untuk aplikasi, folder terbuka untuk browsing.
  folder: svg('<path d="M1.8 12.5v-8a1 1 0 0 1 1-1h3.1l1.5 1.7h5.8a1 1 0 0 1 1 1v5.8a1 1 0 0 1-1 1H2.8a1 1 0 0 1-1-1Z"/>'),
  folderOpen: svg('<path d="M1.8 12.5v-8a1 1 0 0 1 1-1h3.1l1.5 1.7h5.8a1 1 0 0 1 1 1v.8"/><path d="m1.8 12.5 1.7-4.4a1 1 0 0 1 .95-.65h10.1a.6.6 0 0 1 .57.8l-1.5 3.7a1 1 0 0 1-.95.65H2.8a1 1 0 0 1-1-1Z"/>'),

  // Dokumen dengan garis isi: yang diedit adalah teksnya.
  editor: svg('<path d="M9 1.8H4.3a1 1 0 0 0-1 1v10.4a1 1 0 0 0 1 1h7.4a1 1 0 0 0 1-1V5.5Z"/><path d="M9 1.8v3.7h3.7"/><path d="M5.8 8.6h4.4M5.8 11h3"/>'),

  // Denyut nadi: satu lintasan yang naik-turun, bukan ikon "statistik" generik.
  sysmon: svg('<path d="M1.5 8.5h3l1.6-4.4 2.4 8 1.9-5.2 1.1 1.6h2.5"/>'),

  // Baris daftar dengan lebar berbeda: process viewer memindai kolom.
  processes: svg('<path d="M2 3.5h12M2 8h8M2 12.5h10"/>'),

  // Globe: satu bujur dan satu meridian. Sengaja tanpa detail benua,
  // supaya tetap terbaca pada ukuran 16px.
  globe: svg('<circle cx="8" cy="8" r="6.2"/><path d="M1.8 8h12.4"/><path d="M8 1.8a9.4 9.4 0 0 1 0 12.4 9.4 9.4 0 0 1 0-12.4Z"/><path d="M3.4 4.2a10 10 0 0 0 9.2 0M3.4 11.8a10 10 0 0 1 9.2 0"/>'),

  // Dua kepala untuk akun panel. Bentuknya sengaja tanpa garis wajah,
  // supaya tidak terbaca sebagai avatar dan tetap ringan di dock.
  users: svg('<circle cx="6" cy="5.2" r="2.4"/><path d="M1.9 13.2a4.3 4.3 0 0 1 8.2 0"/><path d="M10.4 3.2a2.4 2.4 0 0 1 0 4.3"/><path d="M11.4 9.4a4.3 4.3 0 0 1 2.7 3.8"/>'),

  // Piringan: stack + platter.
  disk: svg('<ellipse cx="8" cy="4" rx="5.2" ry="2.2"/><path d="M2.8 4v8c0 1.2 2.3 2.2 5.2 2.2s5.2-1 5.2-2.2V4"/><path d="M2.8 8c0 1.2 2.3 2.2 5.2 2.2s5.2-1 5.2-2.2"/>'),

  // Grid 9 titik untuk Activities.
  grid: svg('<circle cx="4" cy="4" r="1.15" fill="currentColor" stroke="none"/><circle cx="8" cy="4" r="1.15" fill="currentColor" stroke="none"/><circle cx="12" cy="4" r="1.15" fill="currentColor" stroke="none"/><circle cx="4" cy="8" r="1.15" fill="currentColor" stroke="none"/><circle cx="8" cy="8" r="1.15" fill="currentColor" stroke="none"/><circle cx="12" cy="8" r="1.15" fill="currentColor" stroke="none"/><circle cx="4" cy="12" r="1.15" fill="currentColor" stroke="none"/><circle cx="8" cy="12" r="1.15" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.15" fill="currentColor" stroke="none"/>'),

  // Palet: setengah lingkaran gelap + titik warna, untuk pemilih tema.
  palette: svg('<path d="M8 1.6a6.4 6.4 0 0 0 0 12.8c.9 0 1.6-.7 1.6-1.6 0-.4-.2-.8-.5-1.1a1.6 1.6 0 0 1 1.2-2.7h1.3a2.8 2.8 0 0 0 2.8-2.8c0-2.6-2.8-4.6-6.4-4.6Z"/><circle cx="4.6" cy="7" r=".85" fill="currentColor" stroke="none"/><circle cx="6.6" cy="4.4" r=".85" fill="currentColor" stroke="none"/><circle cx="9.6" cy="4.6" r=".85" fill="currentColor" stroke="none"/>'),

  /* ---------------------------------------------------------- navigasi */
  back: svg('<path d="M9.8 3.5 5.3 8l4.5 4.5"/>'),
  up: svg('<path d="M3.5 9.8 8 5.3l4.5 4.5"/>'),
  refresh: svg('<path d="M13.2 8a5.2 5.2 0 1 1-1.6-3.75"/><path d="M13.4 2.6v3h-3"/>'),
  close: svg('<path d="M4 4l8 8M12 4l-8 8"/>'),

  /* ---------------------------------------------------------- file type */
  file: svg('<path d="M9 1.8H4.3a1 1 0 0 0-1 1v10.4a1 1 0 0 0 1 1h7.4a1 1 0 0 0 1-1V5.5Z"/><path d="M9 1.8v3.7h3.7"/>'),
  symlink: svg('<path d="M6.6 9.4a2.6 2.6 0 0 0 3.7 0l2.1-2.1a2.6 2.6 0 0 0-3.7-3.7l-.9.9"/><path d="M9.4 6.6a2.6 2.6 0 0 0-3.7 0L3.6 8.7a2.6 2.6 0 0 0 3.7 3.7l.9-.9"/>'),

  // Perangkat & soket: bentuk POSIX-nya memang berbeda, bukan "file biasa".
  charDevice: svg('<rect x="2.5" y="2.5" width="11" height="11" rx="1.5"/><circle cx="5.6" cy="5.6" r="1.1"/><path d="M7.4 5.6h3.4M5.6 7.4v3.4"/>'),
  blockDevice: svg('<rect x="2.5" y="2.5" width="11" height="11" rx="1.5"/><circle cx="8" cy="8" r="2.6"/><circle cx="8" cy="8" r=".5" fill="currentColor" stroke="none"/>'),
  socket: svg('<circle cx="8" cy="8" r="5.2"/><path d="M8 2.8v1.8M8 11.4v1.8M2.8 8h1.8M11.4 8h1.8"/>'),
  fifo: svg('<circle cx="4" cy="8" r="1.9"/><circle cx="12" cy="8" r="1.9"/><path d="M5.9 8h4.2"/>'),
  unknown: svg('<circle cx="8" cy="8" r="5.4"/><path d="M6.4 6.2a1.7 1.7 0 1 1 2.2 1.6v1"/><circle cx="8" cy="11.1" r=".55" fill="currentColor" stroke="none"/>'),

  /* -------------------------------------------------------------- status */
  bolt: svg('<path d="M8.8 1.6 3.4 9h3.6l-.8 5.4L12.6 7H9Z"/>'),
  power: svg('<path d="M8 1.9v5.2"/><path d="M11.7 4a5.2 5.2 0 1 1-7.4 0"/>'),
  gear: svg('<circle cx="8" cy="8" r="2.2"/><path d="M8 1.6v1.6M8 12.8v1.6M14.4 8h-1.6M3.2 8H1.6M12.5 3.5l-1.1 1.1M4.6 11.4l-1.1 1.1M12.5 12.5l-1.1-1.1M4.6 4.6 3.5 3.5"/>'),
  unplug: svg('<path d="M6.2 9.8 3.4 12.6M9.8 6.2l2.8-2.8"/><path d="M2.6 2.6l10.8 10.8"/>'),
  plus: svg('<path d="M8 3.2v9.6M3.2 8h9.6"/>'),
  save: svg('<path d="M3.4 2.6h7.2L13.4 5.4v8a1 1 0 0 1-1 1H3.4a1 1 0 0 1-1-1v-9.8a1 1 0 0 1 1-1Z"/><path d="M5.2 2.6v3.8h5V2.6M5.2 14.4v-3.8h5.6v3.8"/>'),
  download: svg('<path d="M8 2.2v7.4"/><path d="m4.9 6.7 3.1 3.1 3.1-3.1"/><path d="M2.6 12.2v.6a1 1 0 0 0 1 1h8.8a1 1 0 0 0 1-1v-.6"/>'),
  upload: svg('<path d="M8 9.9V2.5"/><path d="m4.9 5.6 3.1-3.1 3.1 3.1"/><path d="M2.6 12.2v.6a1 1 0 0 0 1 1h8.8a1 1 0 0 0 1-1v-.6"/>'),
  trash: svg('<path d="M2.8 4.2h10.4"/><path d="M6.2 4.2V2.9a.8.8 0 0 1 .8-.8h2a.8.8 0 0 1 .8.8v1.3"/><path d="M4.2 4.2v8.3a1 1 0 0 0 1 1h5.6a1 1 0 0 0 1-1V4.2"/><path d="M6.6 6.6v4M9.4 6.6v4"/>'),
  chevronDown: svg('<path d="m4.5 6.5 3.5 3.5 3.5-3.5"/>'),
  pencil: svg('<path d="M10.6 2.6 13.4 5.4 5.8 13H3v-2.8Z"/><path d="M9.4 3.8 12.2 6.6"/>'),
};

/** Ikon untuk jenis entri file dari server. */
export function fileIcon(type) {
  return icons[type] || icons.unknown;
}