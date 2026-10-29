import { api } from '../api.js';
import { icons } from '../icons.js';
import { el, bar, formatBytes } from '../ui.js';

const HISTORY = 60; // titik yang disimpan untuk sparkline

/** System Monitor: kartu status + riwayat singkat untuk tiap metrik. */
export const systemMonitorApp = {
  id: 'sysmon',
  name: 'System Monitor',
  icon: icons.sysmon,
  resizable: true,

  mount(body, ctx) {
    const history = { cpu: [], mem: [], disk: [] };
    let timer = null;

    const cards = el('div', { class: 'mon-cards' });
    const charts = el('div', { class: 'mon-charts' });
    const foot = el('div', { class: 'mon-foot' });

    body.append(cards, charts, foot);

    /**
 * Kartu dibelah dua kelompok karena isinya memang berbeda jenis, bukan
 * karena pemanis visual: tiga angka "tingkat pakai" yang punya bar dan riwayat
 * (CPU, Memori, Disk), dan dua fakta yang tidak punya tingkat (OS, Uptime).
 * Lima kartu seragam akan membuat semuanya terlihat setara, padahal tidak.
 */
    function factCard(label, value, note) {
      return el('div', { class: 'mon-fact' },
        el('div', { class: 'mon-label', text: label }),
        el('div', { class: 'mon-fact-value', text: value }),
        note ? el('div', { class: 'mon-note', text: note }) : null,
      );
    }

    function gaugeCard(label, percent, detail, points, color) {
      return el('div', { class: 'mon-gauge' },
        el('div', { class: 'mon-gauge-head' },
          el('span', { class: 'mon-label', text: label }),
          el('span', { class: 'mon-gauge-value', text: `${percent}%` })),
        bar(percent),
        el('div', { class: 'mon-note', text: detail }),
        sparkline(points, color),
      );
    }

    /** Sparkline digambar sebagai deretan kolom div: jauh lebih ringan dari canvas. */
    function sparkline(points, color) {
      if (points.length < 2) {
        return el('div', { class: 'spark is-empty', title: 'Menunggu titik kedua' });
      }
      const max = Math.max(...points, 1);

      return el('div', { class: 'spark' },
        points.map((v) => el('span', {
          class: 'spark-bar',
          style: { height: `${Math.max(3, (v / max) * 100)}%`, background: color },
        })));
    }

    async function refresh() {
      try {
        const m = await api.metrics(ctx.session.id);

        const cpuPct = m.cpuCores ? Math.min(((m.load?.[0] || 0) / m.cpuCores) * 100, 100) : 0;
        const memPct = m.mem.usedPercent;
        const diskPct = m.disk?.usedPercent ?? 0;

        push(history.cpu, cpuPct);
        push(history.mem, memPct);
        push(history.disk, diskPct);

        cards.replaceChildren(
          // kelompok fakta: tidak punya tingkat pakai
          factCard('Sistem', m.os.name.split(' ')[0], m.os.version || m.os.kernel),
          factCard('Uptime', m.uptimeText || '-', m.load?.length ? `load ${m.load.map((n) => n.toFixed(2)).join(' ')}` : ''),
          // kelompok tingkat pakai: punya bar + riwayat
          gaugeCard('CPU', Math.round(cpuPct),
            `${m.cpuCores} core, dipakai ${cpuPct.toFixed(0)}%`, history.cpu, '#e95420'),
          gaugeCard('Memori', memPct,
            `${formatBytes(m.mem.usedBytes)} dari ${formatBytes(m.mem.totalBytes)}`, history.mem, '#4ec9a0'),
          gaugeCard('Disk /', diskPct,
            m.disk ? `${formatBytes(m.disk.usedBytes)} dari ${formatBytes(m.disk.totalBytes)}` : 'tidak ada mount', history.disk, '#f5a623'),
        );

        // Judul grafik menyebut apa yang diukur dan rentang waktunya, bukan
        // sekadar nama metrik.
        const window = `${HISTORY} titik tiap 10 detik`;
        charts.replaceChildren(
          el('div', { class: 'mon-chart' },
            el('div', { class: 'mon-chart-title', text: `Beban CPU (${window})` }), sparkline(history.cpu, '#e95420')),
          el('div', { class: 'mon-chart' },
            el('div', { class: 'mon-chart-title', text: `Memori terpakai (${window})` }), sparkline(history.mem, '#4ec9a0')),
          el('div', { class: 'mon-chart' },
            el('div', { class: 'mon-chart-title', text: `Disk / terpakai (${window})` }), sparkline(history.disk, '#f5a623')),
        );

        foot.replaceChildren(
          el('span', { class: 'muted', text: `Kernel ${m.os.kernel || '-'}` }),
          el('span', { class: 'muted', text: `Diperbarui ${new Date().toLocaleTimeString('id-ID')}` }),
        );
      } catch (err) {
        stop();
        foot.replaceChildren(el('span', { class: 'ed-status err', text: `Berhenti: ${err.message}` }));
      }
    }

    function push(bucket, value) {
      bucket.push(Number(value) || 0);
      if (bucket.length > HISTORY) bucket.shift();
    }

    function start() {
      if (timer) return;
      refresh();
      timer = setInterval(refresh, 10_000);
    }

    function stop() {
      clearInterval(timer);
      timer = null;
    }

    ctx.win.node.addEventListener('win:resize', refresh);
    ctx.setMenus(() => [
      { label: 'Berkas', items: [{ label: 'Tutup', hint: 'Ctrl+W', onSelect: () => ctx.win.close() }] },
      { label: 'Tampilan', items: () => [
        { label: 'Segarkan Sekarang', hint: 'F5', onSelect: () => refresh() },
        '-',
        {
          label: 'Refresh Otomatis',
          checked: Boolean(timer),
          onSelect: () => { if (timer) stop(); else start(); ctx.refreshMenus?.(); },
        },
        '-',
        { label: 'Jeda', checked: !timer, onSelect: () => { stop(); ctx.refreshMenus?.(); } },
      ] },
    ]);

    ctx.registerCleanup?.(stop);

    start();
  },
};