import { api } from '../api.js';
import { icons } from '../icons.js';
import { el, table, toast, confirmDialog, promptDialog } from '../ui.js';

const fmtDate = (ms) => (ms
  ? new Date(ms).toLocaleString('id-ID', {
    day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
  })
  : '-');

const fmtAge = (ms) => {
  if (!ms) return '-';
  const days = Math.floor((Date.now() - ms) / 86_400_000);
  if (days <= 0) return 'hari ini';
  if (days === 1) return 'kemarin';
  if (days < 30) return `${days} hari lalu`;
  const months = Math.floor(days / 30);
  return months === 1 ? '1 bulan lalu' : `${months} bulan lalu`;
};

/**
 * Dasbor admin: siapa saja yang punya akun, dan aktivitas masing-masing.
 *
 * Aplikasi ini tidak butuh koneksi SSH, jadi `needsSession: false`. Bedanya
 * penting: tanpa penanda itu, launch() akan menuntut sesi SSH dan membuka
 * form koneksi saat admin baru ingin melihat siapa saja yang terdaftar.
 */
export const usersApp = {
  id: 'users',
  name: 'Pengguna',
  icon: icons.users,
  resizable: true,
  needsSession: false,
  role: 'admin',

  mount(body, ctx) {
    let data = { users: [], summary: {}, sessionCap: 0 };
    let timer = null;

    const cards = el('div', { class: 'user-cards' });
    const holder = el('div', { class: 'user-holder' });
    const status = el('span', { class: 'muted' });

    body.append(
      el('div', { class: 'mon-toolbar' },
        el('span', { class: 'muted', text: 'Akun panel. Tiap orang hanya melihat dan memakai sesinya sendiri.' }),
        el('div', { class: 'spacer' }),
        el('button', {
          class: 'btn btn-ghost btn-xs',
          type: 'button',
          html: `${icons.plus}<span>Buat akun</span>`,
          onClick: createUser,
        }),
        el('button', {
          class: 'btn btn-ghost btn-xs',
          type: 'button',
          html: `${icons.refresh}<span>Segarkan</span>`,
          onClick: () => refresh(),
        })),
      cards,
      holder,
      el('div', { class: 'mon-foot' }, status),
    );

    function renderCards() {
      const { total = 0, active = 0, admins = 0, disabled = 0 } = data.summary;
      const live = data.users.reduce((sum, u) => sum + (u.liveSessions || 0), 0);

      const card = (label, value, hint) => el('div', { class: 'user-card' },
        el('div', { class: 'user-card-value', text: String(value) }),
        el('div', { class: 'user-card-label', text: label }),
        el('div', { class: 'user-card-hint', text: hint }));

      cards.replaceChildren(
        card('Total akun', total, `${active} aktif`),
        card('Admin', admins, disabled ? `${disabled} dinonaktifkan` : 'semua aktif'),
        card('Sesi SSH', live, `batas ${data.sessionCap}/orang`),
      );
    }

    function roleBadge(user) {
      const cls = user.role === 'admin' ? 'badge badge-admin' : 'badge';
      return el('span', { class: cls, text: user.role === 'admin' ? 'admin' : 'user' });
    }

    function statusBadge(user) {
      return el('span', {
        class: `badge ${user.disabled ? 'badge-off' : 'badge-on'}`,
        text: user.disabled ? 'nonaktif' : 'aktif',
      });
    }

    function sessionCell(user) {
      const n = user.liveSessions || 0;
      const dot = el('span', { class: `dot ${n ? 'dot-on' : 'dot-off'}` });
      return { node: el('span', { class: 'user-sessions' }, dot, `${n} / ${data.sessionCap}`) };
    }

    function actionsFor(user) {
      const isSelf = user.id === ctx.me?.id;

      const actions = el('div', { class: 'user-actions' },
        // Aksi pada akun sendiri disembunyikan di sini, tapi tetap ditolak
        // server. UI bukan batas keamanan; itu tugas server.
        !isSelf && el('button', {
          class: 'btn btn-ghost btn-xs',
          type: 'button',
          text: user.disabled ? 'Aktifkan' : 'Nonaktifkan',
          onClick: () => toggleDisabled(user),
        }),
        !isSelf && el('button', {
          class: 'btn btn-ghost btn-xs',
          type: 'button',
          text: user.role === 'admin' ? 'Jadikan user' : 'Jadikan admin',
          onClick: () => toggleRole(user),
        }),
        el('button', {
          class: 'btn btn-ghost btn-xs',
          type: 'button',
          text: 'Password',
          onClick: () => resetPassword(user),
        }),
        (user.liveSessions || 0) > 0 && el('button', {
          class: 'btn btn-ghost btn-xs',
          type: 'button',
          text: 'Putuskan',
          onClick: () => revoke(user),
        }),
        !isSelf && el('button', {
          class: 'btn btn-ghost btn-xs is-danger',
          type: 'button',
          html: `${icons.trash}<span>Hapus</span>`,
          onClick: () => remove(user),
        }),
      );
      return { node: actions };
    }

    function render() {
      renderCards();

      holder.replaceChildren(
        table(
          [
            { label: 'Akun' },
            { label: 'Peran' },
            { label: 'Status' },
            { label: 'Sesi SSH' },
            { label: 'Dibuat' },
            { label: 'Oleh' },
            { label: '', class: 'right' },
          ],
          data.users.map((user) => {
            const sessions = sessionCell(user);
            const actions = actionsFor(user);
            return {
              raw: user,
              cells: [
                {
                  node: el('span', { class: 'user-name' },
                    el('span', { text: user.username }),
                    user.id === ctx.me?.id && el('span', { class: 'badge badge-self', text: 'kamu' })),
                },
                { node: roleBadge(user) },
                { node: statusBadge(user) },
                { node: sessions.node, class: 'mono' },
                { text: fmtDate(user.createdAt) },
                { text: user.createdBy || '-' },
                { node: actions.node, class: 'right' },
              ],
            };
          }),
          { empty: 'Belum ada akun selain admin.' },
        ),
      );
    }

    async function refresh() {
      try {
        data = await api.listUsers();
        render();
        status.textContent = `${data.users.length} akun \u00b7 diperbarui ${new Date().toLocaleTimeString('id-ID')}`;
      } catch (err) {
        stop();
        status.textContent = `Berhenti: ${err.message}`;
        toast(err.message, 'error');
      }
    }

    async function createUser() {
      const username = await promptDialog({
        title: 'Buat akun',
        label: 'Username (3-32 karakter: huruf, angka, titik, strip)',
        confirmText: 'Lanjut',
      });
      if (!username) return;

      const password = await promptDialog({
        title: 'Buat akun',
        label: 'Password (minimal 8 karakter)',
        confirmText: 'Buat akun',
      });
      if (!password) return;

      try {
        const { user } = await api.createUser({
          username: username.trim(),
          password,
          role: 'user',
        });
        toast(`Akun "${user.username}" dibuat.`);
        await refresh();
      } catch (err) {
        toast(err.message, 'error');
      }
    }

    async function toggleDisabled(user) {
      const next = !user.disabled;
      const ok = await confirmDialog({
        title: next ? 'Nonaktifkan akun' : 'Aktifkan kembali',
        message: next
          ? `"${user.username}" tidak akan bisa login lagi, dan semua sesinya (web maupun SSH) langsung diputus.`
          : `"${user.username}" akan bisa login kembali dengan password yang sekarang.`,
        confirmText: next ? 'Nonaktifkan' : 'Aktifkan',
        danger: next,
      });
      if (!ok) return;

      try {
        const result = await api.updateUser(user.id, { disabled: next });
        toast(`"${user.username}" ${next ? 'dinonaktifkan' : 'diaktifkan kembali'}.`);
        if (result.revoked?.ssh) toast(`${result.revoked.ssh} sesi SSH diputus.`, 'warn');
        await refresh();
      } catch (err) {
        toast(err.message, 'error');
      }
    }

    async function toggleRole(user) {
      const next = user.role === 'admin' ? 'user' : 'admin';
      const ok = await confirmDialog({
        title: next === 'admin' ? 'Naikkan ke admin' : 'Turunkan ke user biasa',
        message: next === 'admin'
          ? `"${user.username}" akan bisa melihat dan mengubah semua akun.`
          : `"${user.username}" akan kehilangan akses ke daftar akun, dan semua sesinya diputus.`,
        confirmText: next === 'admin' ? 'Jadikan admin' : 'Turunkan',
        danger: next !== 'admin',
      });
      if (!ok) return;

      try {
        const result = await api.updateUser(user.id, { role: next });
        toast(`"${user.username}" sekarang ${next === 'admin' ? 'admin' : 'user biasa'}.`);
        if (result.revoked?.ssh) toast(`${result.revoked.ssh} sesi SSH diputus.`, 'warn');
        await refresh();
      } catch (err) {
        toast(err.message, 'error');
      }
    }

    async function resetPassword(user) {
      const password = await promptDialog({
        title: `Password baru untuk "${user.username}"`,
        label: 'Minimal 8 karakter',
        confirmText: 'Simpan',
      });
      if (!password) return;

      try {
        const result = await api.setUserPassword(user.id, password);
        toast(`Password "${user.username}" diganti. Semua sesinya diputus.`);
        if (result.revoked?.ssh) toast(`${result.revoked.ssh} sesi SSH diputus.`, 'warn');
        await refresh();
      } catch (err) {
        toast(err.message, 'error');
      }
    }

    async function revoke(user) {
      const ok = await confirmDialog({
        title: 'Putuskan semua sesi',
        message: `"${user.username}" akan logout dan koneksi SSH-nya ditutup. Akunnya tetap ada.`,
        confirmText: 'Putuskan',
        danger: true,
      });
      if (!ok) return;

      try {
        const result = await api.revokeUser(user.id);
        const web = result.revoked?.web || 0;
        const ssh = result.revoked?.ssh || 0;
        toast(`Sesi diputus: ${web} web, ${ssh} SSH.`);
        await refresh();
      } catch (err) {
        toast(err.message, 'error');
      }
    }

    async function remove(user) {
      const ok = await confirmDialog({
        title: 'Hapus akun',
        message: `"${user.username}" akan dihapus permanen, bersama seluruh sesinya. Akun tidak bisa dipulihkan.`,
        confirmText: 'Hapus permanen',
        danger: true,
      });
      if (!ok) return;

      try {
        await api.deleteUser(user.id);
        toast(`Akun "${user.username}" dihapus.`);
        await refresh();
      } catch (err) {
        toast(err.message, 'error');
      }
    }

    function start() {
      if (timer) return;
      refresh();
      timer = setInterval(refresh, 10_000);
    }

    function stop() { clearInterval(timer); timer = null; }

    ctx.setMenus(() => [
      { label: 'Berkas', items: () => [
        { label: 'Buat Akun', onSelect: () => createUser() },
        '-',
        { label: 'Tutup', hint: 'Ctrl+W', onSelect: () => ctx.win.close() },
      ] },
      { label: 'Tampilan', items: () => [
        { label: 'Segarkan', hint: 'F5', onSelect: () => refresh() },
        {
          label: 'Refresh Otomatis',
          checked: Boolean(timer),
          onSelect: () => {
            if (timer) stop(); else start();
            ctx.refreshMenus?.();
          },
        },
      ] },
    ]);

    ctx.registerCleanup?.(stop);    ctx.registerCleanup?.(stop);
    start();
  },
};