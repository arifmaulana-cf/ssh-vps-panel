import { api } from '../api.js';
import { icons } from '../icons.js';
import { el, bar, table, formatBytes, toast, emptyState } from '../ui.js';

/** Disk Usage: kapasitas tiap mount + breakdown folder terbesar. */
export const diskUsageApp = {
  id: 'disk',
  name: 'Disk Usage',
  icon: icons.disk,
  resizable: true,

  mount(body, ctx) {
    let target = ctx.startPath || '/';
    let timer = null;

    const pathInput = el('input', { class: 'path-input', type: 'text', value: target, spellcheck: 'false' });
    pathInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        target = pathInput.value.trim() || '/';
        refresh();
      }
    });

    const toolbar = el('div', { class: 'mon-toolbar' },
      el('span', { class: 'muted', text: 'Folder:' }),
      el('div', { class: 'fs-path' }, pathInput),
      el('div', { class: 'spacer' }),
      el('button', {
        class: 'btn btn-ghost btn-xs',
        type: 'button',
        text: 'Refresh',
        onClick: () => refresh(),
      }),
    );

    const mounts = el('div', { class: 'mon-section' });
    const usage = el('div', { class: 'mon-section' });
    const foot = el('div', { class: 'mon-foot' });

    body.append(toolbar, mounts, usage, foot);

    async function refresh() {
      try {
        const data = await api.diskUsage(ctx.session.id, target);

        // --- kapasitas tiap mount ---
        mounts.replaceChildren(
          el('h3', { class: 'mon-section-title', text: 'Kapasitas tiap mount' }),
          table(
            [{ label: 'Mount' }, { label: 'Terpakai', class: 'right' }, { label: 'Bebas', class: 'right' }, { label: 'Total', class: 'right' }, { label: '' }],
            data.mounts.map((m) => ({
              cells: [
                { text: m.mount, class: 'mono' },
                { text: formatBytes(m.usedBytes), class: 'right mono' },
                { text: formatBytes(m.availableBytes), class: 'right mono' },
                { text: formatBytes(m.totalBytes), class: 'right mono' },
                { node: bar(m.usedPercent), class: 'bar-cell' },
              ],
            })),
            { empty: 'Server tidak melaporkan mount disk. Perintah df mungkin tidak tersedia di sistem ini.' },
          ),
        );

        // --- breakdown folder ---
        const largest = data.usage.reduce((max, u) => Math.max(max, u.size), 0) || 1;

        usage.replaceChildren(
          el('h3', { class: 'mon-section-title', text: `Folder terbesar di ${data.path}` }),
          data.usage.length
            ? el('div', { class: 'du-list' }, data.usage.map((u) => el('div', {
              class: 'du-row',
              title: u.name,
              onClick: () => { pathInput.value = u.name; target = u.name; refresh(); },
            },
            el('span', { class: 'du-name', text: u.name }),
            el('div', { class: 'du-bar' }, bar((u.size / largest) * 100)),
            el('span', { class: 'du-size mono', text: u.sizeText }),
            )))
            : emptyState({
              title: 'Tidak ada data ukuran folder.',
              cause: `du tidak melaporkan apa pun untuk ${data.path}. Folder mungkin kosong, atau du tidak tersedia di sistem ini.`,
              action: { label: 'Kembali ke root', onClick: () => { target = '/'; pathInput.value = '/'; refresh(); } },
            }),
        );

        foot.replaceChildren(el('span', {
          class: 'muted',
          text: `Diperbarui ${new Date().toLocaleTimeString('id-ID')} \u00b7 klik nama folder untuk menelusuri`,
        }));
      } catch (err) {
        stop();
        foot.replaceChildren(el('span', { class: 'ed-status err', text: `Berhenti: ${err.message}` }));
        toast(err.message, 'error');
      }
    }

    function start() {
      if (timer) return;
      refresh();
      timer = setInterval(refresh, 20_000);
    }

    function stop() { clearInterval(timer); timer = null; }

    ctx.setMenus(() => [
      { label: 'Berkas', items: [{ label: 'Tutup', hint: 'Ctrl+W', onSelect: () => ctx.win.close() }] },
      { label: 'Tampilan', items: () => [
        { label: 'Pindai Ulang', hint: 'F5', onSelect: () => refresh() },
        '-',
        {
          label: 'Refresh Otomatis',
          checked: Boolean(timer),
          onSelect: () => { if (timer) stop(); else start(); ctx.refreshMenus?.(); },
        },
        '-',
        { label: 'Ke Folder Beranda', onSelect: () => { target = ctx.session?.home || '/'; pathInput.value = target; refresh(); } },
      ] },
    ]);

    ctx.registerCleanup?.(stop);    ctx.registerCleanup?.(stop);
    start();
  },
};