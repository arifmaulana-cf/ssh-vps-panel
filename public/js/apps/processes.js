import { api } from '../api.js';
import { icons } from '../icons.js';
import { el, table, formatBytes, toast } from '../ui.js';

const COLUMNS = [
  { key: 'pid', label: 'PID', align: 'right' },
  { key: 'user', label: 'User' },
  { key: 'cpu', label: 'CPU %', align: 'right' },
  { key: 'mem', label: 'MEM %', align: 'right' },
  { key: 'rss', label: 'RSS', align: 'right' },
  { key: 'elapsed', label: 'Waktu' },
  { key: 'state', label: 'Status' },
  { key: 'command', label: 'Perintah' },
];

/** Process Viewer: daftar proses di server, bisa diurutkan dan di-refresh. */
export const processesApp = {
  id: 'processes',
  name: 'Process Viewer',
  icon: icons.processes,
  resizable: true,

  mount(body, ctx) {
    let rows = [];
    let sortKey = 'cpu';
    let sortDesc = true;
    let auto = true;
    let timer = null;

    const toolbar = el('div', { class: 'mon-toolbar' });
    const holder = el('div', { class: 'proc-holder' });
    const foot = el('span', { class: 'muted' });

    const autoLabel = el('label', { class: 'switch' },
      el('input', { type: 'checkbox', checked: true }),
      el('span', { text: 'Auto refresh' }));

    autoLabel.querySelector('input').addEventListener('change', (event) => {
      auto = event.target.checked;
      if (auto) start(); else stop();
    });

    toolbar.append(
      el('span', { class: 'muted', text: 'Klik judul kolom untuk mengurutkan' }),
      el('div', { class: 'spacer' }),
      autoLabel,
      el('button', { class: 'btn btn-ghost btn-xs', type: 'button', text: 'Segarkan', onClick: () => refresh() }),
    );

    body.append(toolbar, holder, el('div', { class: 'mon-foot' }, foot));

    function sorted() {
      const copy = [...rows];
      copy.sort((a, b) => {
        const x = a[sortKey];
        const y = b[sortKey];
        const result = (typeof x === 'number' ? x - y : String(x).localeCompare(String(y)));
        return sortDesc ? -result : result;
      });
      return copy;
    }

    function render() {
      const data = sorted();
      holder.replaceChildren(
        table(
          COLUMNS.map((c) => ({ label: c.label, class: c.align === 'right' ? 'right' : '' })),
          data.map((p) => ({
            raw: p,
            cells: [
              { text: p.pid, class: 'right mono' },
              { text: p.user },
              { text: p.cpu.toFixed(1), class: `right mono${p.cpu > 20 ? ' hot' : ''}` },
              { text: p.mem.toFixed(1), class: 'right mono' },
              { text: formatBytes(p.rss), class: 'right mono' },
              { text: p.elapsed },
              { text: p.state },
              { text: p.command, class: 'proc-cmd' },
            ],
          })),
          {
            onRowClick: (row) => {
              navigator.clipboard?.writeText(row.raw.command).then(
                () => toast('Perintah disalin ke clipboard.'),
                () => toast('Tidak bisa mengakses clipboard.', 'warn'),
              );
            },
            empty: 'Tidak ada proses. Ini jarang terjadi: tekan Segarkan, atau pastikan sesi SSH masih tersambung.',
          },
        ),
      );

      // Judul kolom sebagai pemicu urutan.
      holder.querySelectorAll('thead th').forEach((th, index) => {
        th.classList.add('sortable');
        th.addEventListener('click', () => {
          const key = COLUMNS[index].key;
          if (key === 'command') return;
          sortDesc = key === sortKey ? !sortDesc : true;
          sortKey = key;
          render();
        });
      });

      const total = data.reduce((sum, p) => sum + p.rss, 0);
      foot.textContent = `${data.length} proses \u00b7 total RSS ${formatBytes(total)}`;
    }

    async function refresh() {
      try {
        const result = await api.processes(ctx.session.id);
        rows = result.processes;
        render();
      } catch (err) {
        stop();
        foot.textContent = `Berhenti: ${err.message}`;
        toast(err.message, 'error');
      }
    }

    function start() {
      if (timer) return;
      refresh();
      timer = setInterval(refresh, 5000);
    }

    function stop() { clearInterval(timer); timer = null; }

    ctx.setMenus(() => [
      { label: 'Berkas', items: [{ label: 'Tutup', hint: 'Ctrl+W', onSelect: () => ctx.win.close() }] },
      { label: 'Tampilan', items: () => [
        { label: 'Segarkan', hint: 'F5', onSelect: () => refresh() },
        {
          label: 'Refresh Otomatis',
          checked: auto,
          onSelect: () => {
            auto = !auto;
            autoLabel.querySelector('input').checked = auto;
            if (auto) start(); else stop();
            ctx.refreshMenus?.();
          },
        },
        '-',
        ...COLUMNS.filter((c) => c.key !== 'command').map((c) => ({
          label: `Urutkan: ${c.label}`,
          checked: sortKey === c.key,
          onSelect: () => { sortKey = c.key; sortDesc = true; render(); ctx.refreshMenus?.(); },
        })),
      ] },
    ]);

    ctx.registerCleanup?.(stop);    ctx.registerCleanup?.(stop);
    start();
  },
};