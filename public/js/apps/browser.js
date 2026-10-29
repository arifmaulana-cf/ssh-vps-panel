import { icons } from '../icons.js';
import { el, toast } from '../ui.js';

/** Target yang pernah dibuka, supaya tidak perlu mengetik ulang. */
const KEY = 'panel.browserTargets';

const loadTargets = () => {
  try { return JSON.parse(localStorage.getItem(KEY) || '[]'); } catch { return []; }
};

const saveTargets = (list) => {
  try { localStorage.setItem(KEY, JSON.stringify(list.slice(0, 12))); } catch { /* mode privat */ }
};

/**
 * Preset yang paling sering dibuka orang yang mengelola VPS.
 * Portnya hanya tebakan yang umum; kalau Jenkins Anda di port lain, ubah saja
 * di kolom alamat - tidak perlu menyunting berkas ini.
 */
const PRESETS = [
  { name: 'Jenkins', host: 'localhost', port: 8080 },
  { name: 'ArgoCD', host: 'localhost', port: 443, secure: true },
  { name: 'Grafana', host: 'localhost', port: 3000 },
  { name: 'Portainer', host: 'localhost', port: 9000 },
];

/**
 * Susun URL proksi untuk sebuah target.
 *
 * Skema, host, dan port ada di PATH, bukan di query. Alasannya ada di server:
 * URL yang ditulis ulang ke dalam HTML untuk aset dan form tidak pernah
 * membawa query string. Kalau host dan port hanya ada di query, setiap aset
 * akan datang tanpa keduanya lalu ditolak.
 */
function proxyUrl(sessionId, target, path = '/') {
  const scheme = target.secure ? 'https' : 'http';
  return `/api/proxy/${encodeURIComponent(sessionId)}/${scheme}`
    + `/${encodeURIComponent(target.host)}/${target.port}${path}`;
}

/**
 * Terjemahkan input bebas jadi target.
 *
 * Menerima "localhost:8080", "http://jenkins.internal:8080/jenkins",
 * "https://argo.example.com", dan "192.168.1.5:9000".
 */
function parseTarget(input) {
  const text = String(input || '').trim();
  if (!text) throw new Error('Alamat masih kosong.');

  const withScheme = /^[a-z]+:\/\//i.test(text) ? text : `http://${text}`;

  let url;
  try { url = new URL(withScheme); } catch {
    throw new Error(`Tidak bisa membaca "${text}" sebagai alamat.`);
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Hanya http dan https yang bisa diproksi.');
  }

  const port = url.port ? Number(url.port) : (url.protocol === 'https:' ? 443 : 80);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Port tidak valid: ${url.port || '(kosong)'}`);
  }

  return {
    host: url.hostname,
    port,
    secure: url.protocol === 'https:',
    path: (url.pathname + url.search) || '/',
  };
}

/**
 * Browser ringan: membuka halaman di dalam VPS tanpa tunneling manual.
 *
 * Cara kerjanya: halaman tujuan diambil server lewat channel SSH
 * (direct-tcpip), lalu disajikan sebagai iframe. Tidak ada listener TCP baru
 * di panel, jadi tetap jalan di belakang reverse proxy seperti Cloudflare.
 */
export const browserApp = {
  id: 'browser',
  name: 'Browser',
  icon: icons.globe,
  resizable: true,

  /**
   * Sengaja TIDAK needsSession.
   *
   * Dengan needsSession, mengklik Browser tanpa sesi hanya memunculkan toast
   * dan membuka modal koneksi - jendela Browser-nya tidak pernah muncul, dan
   * karena tidak ada permintaan ke server, log juga tidak mencatat apa pun.
   * Akibatnya mengira aplikasinya rusak, padahal ia tidak pernah dibuka.
   *
   * Itu mahal: satu klik mati tanpa jejak sama sekali. Sekarang jendelanya
   * selalu muncul, dengan keadaan kosong yang menjelaskan apa yang harus
   * dilakukan dan offer tombol untuk melakukannya.
   */
  needsSession: false,

  mount(body, ctx) {
    const sessionId = ctx.session?.id;
    const history = [];
    let position = -1;
    let current = null;

    /**
     * Ikon di sini memakai kelas `icon-btn`, sama seperti File Manager, dan
     * itu bukan soal selera: SVG dari icons.js sengaja dibuat TANPA atribut
     * width/height supaya ukurannya diwarisi dari CSS.
     *
     * Versi pertama tombol ini memakai kelas `btn btn-ghost btn-xs`, yang tidak
     * punya aturan ukuran ikon sama sekali. Akibatnya ikon dirender sebesar
     * elemen terganti default dan toolbar Browser menampilkan gambar raksasa
     * di bagian atas jendela - persis yang dilaporkan user.
     */
    const navIconBtn = (glyph, label, onClick, extra = '') => el('button', {
      class: `icon-btn ${extra}`.trim(),
      type: 'button',
      title: label,
      'aria-label': label,
      html: glyph,
      onClick,
    });

    const backBtn = navIconBtn(icons.back, 'Kembali', () => navigate(-1));
    const fwdBtn = navIconBtn(icons.back, 'Maju', () => navigate(1), 'is-fwd');
    const reloadBtn = navIconBtn(icons.refresh, 'Muat ulang', reload);

    const urlInput = el('input', {
      class: 'br-url',
      type: 'text',
      placeholder: 'localhost:8080',
      spellcheck: 'false',
      autocomplete: 'off',
    });

    const goBtn = el('button', { class: 'btn btn-xs', type: 'button', text: 'Buka' });

    const bar = el('div', { class: 'br-bar' }, [backBtn, fwdBtn, reloadBtn, urlInput, goBtn]);
    const targetsRow = el('div', { class: 'br-targets' });
    const status = el('div', { class: 'br-status', text: 'Siap.' });
    const stage = el('div', { class: 'br-stage' });

    /**
     * Iframe halaman terproksi.
     *
     * allow-same-origin HARUS ada, dan ini bukan hal yang bisa ditawar.
     *
     * Tanpa token itu dokumen dalam iframe mendapat asal buram (opaque
     * origin). Akibatnya setiap fetch() dari JavaScript situs tujuan
     * dianggap lintas asal, dan route proksi tidak pernah mengirim
     * Access-Control-Allow-Origin - jadi setiap permintaan ditolak browser.
     * Cookie pun tidak ikut, karena fetch bawaan memakai credentials
     * 'same-origin' yang otomatis gagal untuk asal buram.
     *
     * Gejalanya bukan halaman error: dokumen HTML, CSS, dan JS tetap termuat,
     * lalu tidak ada satu pun data yang bisa diambil. Jenkins tampil sebagai
     * halaman kosong, karena seluruh UI-nya dibangun dari XHR.
     *
     * Yang ditukar: JavaScript situs tujuan kini berbagi asal dengan panel,
     * sehingga bisa membaca localStorage panel dan memanggil /api/* sebagai
     * Anda - termasuk /api/users dan /api/auth/password. Yang terekspos di
     * localStorage hanya host/port/username dan pilihan tema; tidak ada
     * password maupun private key yang pernah disimpan (lihat README).
     *
     * Batas akhir yang sesungguhnya adalah asal, bukan sandbox: selama
     * halaman ber-asal sama dengan panel, sandbox tidak bisa memisahkannya.
     * Satu-satunya pemulihan adalah menyajikan proksi dari asal sendiri.
     */
    const frame = el('iframe', {
      class: 'br-frame',
      title: 'Halaman terproksi',
      sandbox: 'allow-scripts allow-same-origin allow-forms allow-popups'
        + ' allow-popups-to-escape-sandbox allow-modals allow-downloads',
      referrerpolicy: 'no-referrer',
    });

    /**
     * Keadaan kosong.
     *
     * Dua kondisi, karena satu saja tidak cukup: tanpa sesi SSH tidak ada
     * yang bisa diproksi sama sekali, jadi menawarkan preset hanya menambah
     * langkah yang sia-sia.
     */
    const emptyTitle = el('p', { class: 'br-empty-title' });
    const emptySub = el('p', { class: 'br-empty-sub' });
    const emptyAction = el('div', { class: 'br-empty-action' });
    const emptyBox = el('div', { class: 'br-empty' },
      emptyTitle, emptySub, emptyAction);

    function renderEmpty() {
      if (!sessionId) {
        emptyTitle.textContent = 'Belum ada koneksi SSH';
        emptySub.textContent = 'Browser membuka halaman di dalam VPS lewat koneksi SSH. '
          + 'Buat koneksi dulu, lalu buka lagi.';
        emptyAction.replaceChildren(el('button', {
          class: 'btn btn-primary btn-sm', type: 'button', text: 'Buka Terminal & hubungkan',
          onClick: () => ctx.launch('terminal'),
        }));
      } else {
        emptyTitle.textContent = 'Belum ada halaman terbuka';
        emptySub.textContent = 'Pilih preset di atas atau ketik alamat, lalu tekan Buka.';
        emptyAction.replaceChildren();
      }
    }

    stage.append(frame, emptyBox);
    body.append(bar, targetsRow, status, stage);

    const setStatus = (text, err = false) => {
      status.textContent = text;
      status.className = `br-status${err ? ' is-err' : ''}`;
    };

    const syncNav = () => {
      backBtn.disabled = position <= 0;
      fwdBtn.disabled = position >= history.length - 1;
    };

    /** Chip satu target tersimpan. */
    const chipFor = (entry, onRemove) => {
      const chip = el('div', { class: 'br-chip', title: entry.path || '/' },
        el('span', { class: 'br-chip-name', text: entry.name }),
        el('span', { class: 'br-chip-host', text: `${entry.host}:${entry.port}` }));

      chip.addEventListener('click', () => {
        urlInput.value = entry.secure ? `https://${entry.host}:${entry.port}` : `${entry.host}:${entry.port}`;
        go();
      });

      if (onRemove) {
        chip.append(el('button', {
          class: 'br-chip-save', type: 'button', text: '×', title: `Lupakan ${entry.host}:${entry.port}`,
          onClick: (e) => { e.stopPropagation(); onRemove(); },
        }));
      }
      return chip;
    };

    function renderTargets() {
      const presets = PRESETS.map((p) => chipFor(p));
      const saved = loadTargets().map((entry) => chipFor(entry, () => {
        saveTargets(loadTargets().filter((s) => !(s.host === entry.host && s.port === entry.port)));
        renderTargets();
      }));
      targetsRow.replaceChildren(...presets, ...saved);
    }

    async function go() {
      if (!sessionId) {
        setStatus('Belum ada koneksi SSH. Hubungkan ke VPS dulu.', true);
        return;
      }

      let target;
      try {
        target = parseTarget(urlInput.value);
      } catch (err) {
        setStatus(err.message, true);
        return;
      }

      setStatus(`Menyambung ke ${target.host}:${target.port}...`);

      // Probe dulu: tanpa ini, kegagalan tidak pernah terlihat, karena iframe
      // hanya menampilkan layar kosong.
      //
      // Dua kategori harus dibedakan, dan ini yang sempat terbalik:
      //
      //   - GAGAT menghubungi  -> tidak ada kanal, timeout, DNS gagal.
      //     Pesannya "tidak bisa menjangkau".
      //   - DITOLAK oleh target -> target menjawab 401/403. Jenkins memang
      //     begitu untuk anonymously, dan itu jawaban yang normal, bukan
      //     kegagalan jaringan.
      //
      // Versi sebelumnya melempar error untuk keduanya dan menulis "tidak bisa
      // menjangkau" saat sebenarnya target sudah menjawab 403 - jadi user diberi
      // petunjuk yang salah arah.
      let refusal = null;
      try {
        const res = await fetch(`/api/proxy/${encodeURIComponent(sessionId)}/probe`
          + `?host=${encodeURIComponent(target.host)}&port=${target.port}&secure=${target.secure ? '1' : '0'}`,
          { credentials: 'same-origin' });

        // Envelope probe selalu HTTP 200 kalau kanal SSH-nya hidup, jadi
        // res.ok selalu true dan tidak berguna untuk menilai apa pun. Status
        // yang ada di dalam JSON itulah jawaban TARGET.
        const probe = await res.json().catch(() => ({}));
        if (!probe.status) {
          throw new Error(probe.error || `Server menjawab ${res.status}`);
        }
        if (probe.usable === false) {
          refusal = `HTTP ${probe.status}`
            + (probe.hint ? ` — ${probe.hint}` : ` — server tujuan menjawab ${probe.status}`);
        }
      } catch (err) {
        setStatus(`Tidak bisa menghubungi ${target.host}:${target.port} — ${err.message}`, true);
        return;
      }

      const url = proxyUrl(sessionId, target, target.path);

      // Memotong riwayat setelah navigasi baru, seperti peramban biasa.
      if (position < history.length - 1) history.length = position + 1;
      history.push(url);
      position = history.length - 1;

      current = target;
      const list = loadTargets().filter((s) => !(s.host === target.host && s.port === target.port));
      list.unshift({ ...target, name: `${target.host}:${target.port}`, path: target.path });
      saveTargets(list);

      emptyBox.hidden = true;
      frame.src = url;
      syncNav();
      renderTargets();

      const shown = `${target.secure ? 'https' : 'http'}://${target.host}:${target.port}${target.path}`;
      if (refusal) {
        // Halaman tetap dimuat supaya isinya terlihat, tapi status merah
        // menjelaskan kenapa ia mungkin kosong atau meminta login.
        setStatus(`${shown} — ditolak target: ${refusal}`, true);
      } else {
        setStatus(shown);
      }
    }

    function navigate(delta) {
      const next = position + delta;
      if (next < 0 || next >= history.length) return;
      position = next;
      frame.src = history[position];
      syncNav();
    }

    function reload() {
      if (!frame.src) return;
      // Ditambah param acak supaya iframe benar-benar memuat ulang; menyetel
      // src yang sama persis tidak memicu navigasi.
      frame.src = `${frame.src}${frame.src.includes('?') ? '&' : '?'}_r=${Date.now()}`;
    }

    function setZoom(zoom) {
      frame.style.zoom = String(zoom);
      setStatus(`Zoom ${Math.round(zoom * 100)}%`);
    }

    urlInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); go(); }
    });
    goBtn.addEventListener('click', go);

    ctx.setMenus(() => [
      {
        label: 'Berkas',
        items: [
          { label: 'Muat Ulang', hint: 'F5', onSelect: reload },
          { label: 'Buka di Tab Baru', onSelect: () => { if (frame.src) window.open(frame.src, '_blank', 'noopener'); } },
          '-',
          {
            label: 'Lupakan Semua Alamat',
            onSelect: () => { saveTargets([]); renderTargets(); toast('Daftar alamat dibersihkan.'); },
          },
        ],
      },
      {
        label: 'Tujuan',
        items: PRESETS.map((p) => ({
          label: `${p.name}  :${p.port}`,
          onSelect: () => { urlInput.value = p.secure ? `https://${p.host}:${p.port}` : `${p.host}:${p.port}`; go(); },
        })),
      },
      {
        label: 'Tampilan',
        items: [
          { label: 'Zoom 100%', onSelect: () => setZoom(1) },
          { label: 'Zoom 75%', onSelect: () => setZoom(0.75) },
          { label: 'Zoom 50%', onSelect: () => setZoom(0.5) },
        ],
      },
    ]);

    ctx.registerCleanup?.(() => { frame.src = 'about:blank'; });

    renderTargets();
    renderEmpty();
    syncNav();

    if (sessionId) {
      // Buka Jenkins langsung: hampir selalu itu yang dicari pertama, dan
      // satu klik lebih cepat daripada mengetik.
      urlInput.value = 'localhost:8080';
      go();
    } else {
      setStatus('Belum ada koneksi SSH. Browser butuh satu sebelum bisa membuka halaman.', true);
    }
  },
};
