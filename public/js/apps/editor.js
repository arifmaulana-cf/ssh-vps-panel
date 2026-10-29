import { api } from '../api.js';
import { icons } from '../icons.js';
import {
  el, toast, formatBytes, formatTime, confirmDialog, promptDialog,
} from '../ui.js';

/**
 * Text editor untuk file di server.
 * Menyimpan lewat API PUT yang menulis ke berkas sementara lalu mv, jadi
 * file asli tidak pernah tertinggal setengah tertulis.
 */
export const editorApp = {
  id: 'editor',
  name: 'Text Editor',
  icon: icons.editor,
  resizable: true,

  mount(body, ctx) {
    let path = ctx.path || null;
    let original = '';
    let dirty = false;

    const pathLabel = el('span', { class: 'ed-path', text: 'Pilih file dari File Manager' });
    const infoLabel = el('span', { class: 'muted' });
    const saveBtn = el('button', { class: 'btn btn-primary btn-xs', type: 'button', text: 'Simpan (Ctrl+S)' });
    const reloadBtn = el('button', { class: 'btn btn-ghost btn-xs', type: 'button', text: 'Muat ulang' });
    const renameBtn = el('button', { class: 'btn btn-ghost btn-xs', type: 'button', text: 'Save As\u2026' });

    const area = el('textarea', {
      class: 'ed-area',
      spellcheck: 'false',
      placeholder: 'Isi file akan tampil di sini.',
    });
    area.addEventListener('input', () => setDirty(area.value !== original));
    area.addEventListener('keydown', (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        save();
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'w') {
        event.preventDefault();
        ctx.win.close();
      }
      // Tab harus menyisipkan spasi, bukan memindah fokus.
      if (event.key === 'Tab' && !event.shiftKey) {
        event.preventDefault();
        const { selectionStart: s, selectionEnd: e, value } = area;
        area.value = `${value.slice(0, s)}  ${value.slice(e)}`;
        area.selectionStart = area.selectionEnd = s + 2;
        setDirty(area.value !== original);
      }
    });

    const status = el('div', { class: 'ed-status' });

    body.append(
      el('div', { class: 'ed-toolbar' }, pathLabel, el('div', { class: 'ed-tools' }, reloadBtn, renameBtn, saveBtn)),
      el('div', { class: 'ed-wrap' }, area),
      el('div', { class: 'ed-foot' }, infoLabel, status),
    );

    reloadBtn.addEventListener('click', () => path && load(path));
    saveBtn.addEventListener('click', () => save());
    renameBtn.addEventListener('click', () => saveAs());

    function setDirty(value) {
      dirty = value;
      ctx.win.setTitle(`${value ? '\u25cf ' : ''}${path ? path.split('/').pop() : 'Text Editor'}`);
    }

    function setStatus(text, kind = '') {
      status.textContent = text;
      status.className = `ed-status ${kind}`;
    }

    async function load(target) {
      setStatus('Membaca\u2026');
      setBusy(true);
      try {
        const data = await api.readFile(ctx.session.id, target);

        if (data.binary) {
          area.value = '';
          area.disabled = true;
          area.placeholder = 'Ini file biner \u2014 buka lewat download, bukan editor.';
          setStatus('File biner, tidak bisa diedit di teks.', 'warn');
        } else {
          area.disabled = false;
          area.value = data.content;
          original = data.content;
        }

        path = data.path;
        pathLabel.textContent = data.path;
        infoLabel.textContent = `${formatBytes(data.size)} \u00b7 diubah ${formatTime(data.modified)}`;
        setDirty(false);
        ctx.win.setTitle(path.split('/').pop());
        saveBtn.disabled = !!data.binary;
      } catch (err) {
        setStatus(err.message, 'err');
        toast(err.message, 'error');
      } finally {
        setBusy(false);
      }
    }

    function setBusy(value) {
      reloadBtn.disabled = value;
      renameBtn.disabled = value;
      saveBtn.disabled = value || area.disabled;
    }

    async function save() {
      if (!path || area.disabled) return;

      setBusy(true);
      try {
        const result = await api.writeFile(ctx.session.id, path, area.value);
        original = area.value;
        setDirty(false);
        infoLabel.textContent = `${formatBytes(result.size)} \u00b7 baru saja disimpan`;
        setStatus('Tersimpan.', 'ok');
      } catch (err) {
        setStatus(err.message, 'err');
        toast(err.message, 'error');
      } finally {
        setBusy(false);
      }
    }

    async function saveAs() {
      if (!path || area.disabled) return;

      const next = await promptDialog({
        title: 'Simpan sebagai',
        label: 'Path baru di server',
        value: path,
        confirmText: 'Simpan',
      });
      if (!next || next === path) return;

      setBusy(true);
      try {
        await api.writeFile(ctx.session.id, next, area.value);
        path = next;
        pathLabel.textContent = next;
        original = area.value;
        setDirty(false);
        ctx.win.setTitle(next.split('/').pop());
        setStatus('Tersimpan.', 'ok');
      } catch (err) {
        setStatus(err.message, 'err');
      } finally {
        setBusy(false);
      }
    }

    // Cegah jendela tertutup saat ada perubahan yang belum disimpan.
    ctx.setMenus(() => [
      { label: 'Berkas', items: () => [
        { label: 'Simpan', hint: 'Ctrl+S', disabled: area.disabled, onSelect: () => save() },
        { label: 'Simpan Sebagai...', disabled: area.disabled, onSelect: () => saveAs() },
        { label: 'Muat Ulang', disabled: dirty || !path, onSelect: () => load(path) },
        '-',
        { label: 'Tutup', hint: 'Ctrl+W', onSelect: () => ctx.win.close() },
      ] },
      { label: 'Edit', items: () => [
        {
          label: 'Batalkan Perubahan',
          disabled: !dirty,
          onSelect: async () => {
            const ok = await confirmDialog({
              title: 'Batalkan perubahan?',
              message: 'Isi editor akan dikembalikan ke isi berkas di server.',
              confirmText: 'Batalkan perubahan',
              danger: true,
            });
            if (ok) load(path);
          },
        },
      ] },
    ]);

    ctx.onBeforeClose = async () => {
      if (!dirty) return true;
      const ok = await confirmDialog({
        title: 'Perubahan belum disimpan',
        message: `Simpan perubahan ke ${path || 'file ini'} sebelum menutup?`,
        confirmText: 'Simpan',
      });
      if (!ok) return true;
      await save();
      return true;
    };

    if (path) load(path);
    else {
      area.disabled = true;
      saveBtn.disabled = true;
      renameBtn.disabled = true;
    }

    ctx.registerCleanup?.(() => {});
  },
};