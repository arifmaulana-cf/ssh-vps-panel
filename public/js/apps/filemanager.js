import { api } from '../api.js';
import { icons, fileIcon } from '../icons.js';
import {
  el, toast, formatBytes, formatTime, contextMenu, promptDialog, confirmDialog, emptyState,
} from '../ui.js';

// CATATAN: jangan meng-import iconBtn dari ui.js - helper itu TIDAK ada di sana.
// File Manager punya fungsi iconBtn sendiri di dalam mount(). Menambahkan
// import yang menggantung di sini adalah module link error: seluruh graf modul
// gagal dimuat, desktop.js tidak pernah jalan, dan form login yang ada di HTML
// statis tetap tampil tapi tidak punya penangan submit - menekan tombol tidak
// terjadi apa-apa tanpa pesan apa pun. Suite DOM tidak menangkapnya karena
// modulnya disatukan dengan window.eval, bukan dimuat sebagai ES module.

const iconFor = (type) => fileIcon(type);

/** File manager: jelajah server, buka file, upload, download, hapus. */
export const fileManagerApp = {
  id: 'files',
  name: 'File Manager',
  icon: icons.folder,
  resizable: true,

  mount(body, ctx) {
    let cwd = ctx.startPath || '/';
    const history = [cwd];
    let historyIndex = 0;
    let busy = false;

    // ------------------------------------------------------------ kerangka
    const backBtn = iconBtn(icons.back, 'Kembali', () => goBack());
    const upBtn = iconBtn(icons.up, 'Naik satu level', () => goUp());
    const refreshBtn = iconBtn(icons.refresh, 'Segarkan', () => load(cwd));

    const pathInput = el('input', {
      class: 'path-input',
      type: 'text',
      spellcheck: 'false',
      title: 'Ketik path lalu tekan Enter',
    });
    pathInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') load(pathInput.value.trim());
    });

    const homeBtn = el('button', { class: 'btn btn-ghost btn-xs', type: 'button', text: 'Beranda' });
    const rootBtn = el('button', { class: 'btn btn-ghost btn-xs', type: 'button', text: '/' });
    const newFolderBtn = el('button', { class: 'btn btn-ghost btn-xs', type: 'button', text: '+ Folder' });
    const uploadBtn = el('button', { class: 'btn btn-primary btn-xs', type: 'button', text: 'Upload' });

    const status = el('span', { class: 'fs-status' });
    const listing = el('div', { class: 'fs-listing' });
    const dropHint = el('div', { class: 'fs-drop', hidden: true },
      el('div', { class: 'fs-drop-inner', text: 'Lepas file di sini untuk mengupload ke folder ini' }));

    const fileInput = el('input', { type: 'file', multiple: true, hidden: true });
    fileInput.addEventListener('change', () => {
      if (fileInput.files?.length) uploadAll([...fileInput.files]);
      fileInput.value = '';
    });

    body.append(
      el('div', { class: 'fs-toolbar' },
        backBtn, upBtn, refreshBtn,
        el('div', { class: 'fs-path' }, pathInput),
        homeBtn, rootBtn, newFolderBtn, uploadBtn),
      el('div', { class: 'fs-wrap' }, listing, dropHint),
      el('div', { class: 'fs-foot' }, status),
    );

    homeBtn.addEventListener('click', () => load('/home'));
    rootBtn.addEventListener('click', () => load('/'));
    uploadBtn.addEventListener('click', () => fileInput.click());
    newFolderBtn.addEventListener('click', () => createFolder());

    // drag & drop langsung ke area listing
    let dragDepth = 0;
    body.addEventListener('dragenter', (event) => {
      event.preventDefault();
      dragDepth += 1;
      dropHint.hidden = false;
    });
    body.addEventListener('dragover', (event) => event.preventDefault());
    body.addEventListener('dragleave', () => {
      dragDepth = Math.max(0, dragDepth - 1);
      if (dragDepth === 0) dropHint.hidden = true;
    });
    body.addEventListener('drop', (event) => {
      event.preventDefault();
      dragDepth = 0;
      dropHint.hidden = true;
      const files = [...(event.dataTransfer?.files || [])];
      if (files.length) uploadAll(files);
    });

    function iconBtn(glyph, label, onClick) {
      return el('button', {
        class: 'icon-btn',
        type: 'button',
        title: label,
        'aria-label': label,
        html: glyph,
        onClick,
      });
    }

    // -------------------------------------------------------------- navigasi
    async function load(target, { push = true } = {}) {
      if (busy) return;
      busy = true;
      setStatus('Membaca folder\u2026');

      try {
        const data = await api.listFiles(ctx.session.id, target);
        cwd = data.path;
        if (push) {
          history.splice(historyIndex + 1);
          history.push(cwd);
          historyIndex = history.length - 1;
        }
        render(data);
      } catch (err) {
        listing.replaceChildren(emptyState({
          title: 'Folder tidak bisa dibuka.',
          cause: err.message,
          action: { label: 'Kembali', onClick: goBack },
        }));
        setStatus('');
        pathInput.value = target;
      } finally {
        busy = false;
      }
    }

    function goBack() {
      if (historyIndex > 0) {
        historyIndex -= 1;
        load(history[historyIndex], { push: false });
      }
    }

    function goUp() {
      const parent = cwd.replace(/\/+$/, '').split('/').slice(0, -1).join('/') || '/';
      load(parent);
    }

    // ---------------------------------------------------------------- render
    function render(data) {
      pathInput.value = data.path;
      backBtn.disabled = historyIndex === 0;
      upBtn.disabled = data.path === '/';

      if (!data.items.length) {
        listing.replaceChildren(emptyState({
          title: 'Folder ini kosong.',
          cause: `Tidak ada berkas atau subfolder di ${data.path}. Drag file dari komputer Anda ke jendela ini untuk mengupload, atau tekan tombol Upload.`,
          action: { label: 'Pilih folder lain', onClick: goUp },
        }));
        setStatus('');
        return;
      }

      const grid = el('div', { class: 'fs-grid' });
      for (const item of data.items) {
        grid.append(renderItem(item));
      }
      listing.replaceChildren(grid);

      const folders = data.items.filter((i) => i.type === 'folder').length;
      setStatus(`${data.items.length} entri \u00b7 ${folders} folder \u00b7 ${formatTime(Date.now())}`);
    }

    function renderItem(item) {
      const full = `${cwd.replace(/\/+$/, '')}/${item.name}`;

      const node = el('div', { class: `fs-item fs-${item.type}`, title: item.name },
        el('div', { class: 'fs-icon', html: iconFor(item.type) }),
        el('div', { class: 'fs-name', text: item.name }),
        el('div', { class: 'fs-meta', text: item.type === 'folder' ? '-' : formatBytes(item.size) }),
      );

      node.addEventListener('click', () => {
        listing.querySelectorAll('.fs-item.is-selected').forEach((n) => n.classList.remove('is-selected'));
        node.classList.add('is-selected');
      });

      node.addEventListener('dblclick', () => open(full, item));

      node.addEventListener('contextmenu', (event) => {
        event.preventDefault();
        showMenu(event, full, item);
      });

      return node;
    }

    function showMenu(event, full, item) {
      const isFolder = item.type === 'folder';
      contextMenu(event, [
        { label: 'Buka', onSelect: () => open(full, item) },
        !isFolder && item.type === 'file' && { label: 'Edit teks', onSelect: () => ctx.openEditor(full) },
        !isFolder && { label: 'Download', onSelect: () => download(full, item.name) },
        '-',
        { label: 'Ganti nama', onSelect: () => rename(full) },
        {
          label: isFolder ? 'Hapus folder' : 'Hapus file',
          onSelect: () => remove(full, item),
        },
      ].filter(Boolean));
    }

    function open(full, item) {
      if (item.type === 'folder') {
        load(full);
      } else if (item.type === 'file') {
        ctx.openEditor(full);
      } else {
        toast(`${item.type} tidak bisa dibuka dari sini.`, 'warn');
      }
    }

    function download(full, name) {
      const link = el('a', { href: api.downloadUrl(ctx.session.id, full), download: name });
      document.body.append(link);
      link.click();
      link.remove();
      toast(`Mengunduh ${name}\u2026`);
    }

    async function rename(full) {
      const current = full.split('/').pop();
      const next = await promptDialog({ title: 'Ganti nama', label: 'Nama baru', value: current });
      if (!next || next === current) return;

      try {
        await api.rename(ctx.session.id, full, `${full.replace(/\/[^/]*$/, '')}/${next}`);
        toast('Nama diganti.');
        load(cwd, { push: false });
      } catch (err) { toast(err.message, 'error'); }
    }

    async function remove(full, item) {
      const isFolder = item.type === 'folder';
      const ok = await confirmDialog({
        title: `Hapus ${isFolder ? 'folder' : 'file'}?`,
        message: isFolder
          ? `"${item.name}" beserta seluruh isinya akan dihapus permanen di server.`
          : `"${item.name}" akan dihapus permanen di server.`,
        confirmText: 'Hapus',
        danger: true,
      });
      if (!ok) return;

      try {
        await api.remove(ctx.session.id, full);
        toast(`${item.name} dihapus.`);
        load(cwd, { push: false });
      } catch (err) { toast(err.message, 'error'); }
    }

    async function createFolder() {
      const name = await promptDialog({ title: 'Folder baru', label: 'Nama folder', confirmText: 'Buat' });
      if (!name) return;

      try {
        await api.mkdir(ctx.session.id, `${cwd.replace(/\/+$/, '')}/${name}`);
        toast(`Folder ${name} dibuat.`);
        load(cwd, { push: false });
      } catch (err) { toast(err.message, 'error'); }
    }

    // --------------------------------------------------------------- upload
    async function uploadAll(files) {
      const total = files.reduce((sum, f) => sum + f.size, 0);
      let done = 0;
      const failed = [];

      for (const file of files) {
        setStatus(`Mengupload ${file.name} (${done + 1}/${files.length})`);
        try {
          await api.upload(ctx.session.id, cwd, file.name, file);
          done += 1;
        } catch (err) {
          failed.push(`${file.name}: ${err.message}`);
        }
      }

      if (failed.length) toast(`Gagal: ${failed[0]}`, 'error');
      else toast(`${files.length} file (${formatBytes(total)}) terupload.`);
      load(cwd, { push: false });
    }

    function setStatus(text) {
      status.textContent = text;
    }

    // Mulai dari home user remote; path yang dikontekskan dari desktop diterima.
    load(ctx.startPath || '/');

    /* --------------------------------------------------------------- menu */
    ctx.setMenus(() => [
      { label: 'Berkas', items: () => [
        { label: 'Muat Ulang', hint: 'F5', onSelect: () => load(path) },
        '-',
        { label: 'Folder Baru', onSelect: () => createFolder() },
        { label: 'Unggah File...', onSelect: () => fileInput.click() },
        '-',
        { label: 'Tutup', hint: 'Ctrl+W', onSelect: () => ctx.win.close() },
      ] },
      { label: 'Tampilan', items: () => [
        { label: 'Folder Beranda', onSelect: () => load(ctx.session?.home || '/') },
        { label: 'Folder Atas', onSelect: () => goUp() },
        '-',
        { label: 'Buka Terminal di Sini', onSelect: () => ctx.launch('terminal') },
      ] },
    ]);

    ctx.registerCleanup?.(() => {});
  },
};