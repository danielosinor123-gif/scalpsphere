/**
 * ScalpSphere Admin — application shell, router and every section view.
 *
 * Every screen is wired ONLY to endpoints that exist in the backend
 * (backend/openapi.yaml is the contract). Sections the backend does not
 * support render an explicit "Not available in this backend" state that names
 * what would be required — never sample data, never simulated actions.
 *
 * Section inventory follows the supplied admin mockup's navigation, in spirit
 * and order, grouped for scanning. One addition: "Audit Log", which the
 * backend supports but the mockup did not list; it is marked as an extra.
 */
(() => {
  const { el, clear, fmtDate, fmtDateTime, fmtUptime, pill, initials } = UI;

  // ---- session ----------------------------------------------------------------
  // Held in memory only. Identity is re-derived from /auth/me on every load;
  // nothing about the session is ever written to localStorage/sessionStorage.
  let session = null;

  const canWrite = () => session?.role === 'owner' || session?.role === 'admin';
  const isOwner = () => session?.role === 'owner';

  // ---- section inventory (id, icon, label, group) -------------------------------
  const SECTIONS = [
    { id: 'dashboard',     icon: '⌂', label: 'Dashboard',        group: 'Overview' },
    { id: 'users',         icon: '♟', label: 'Manage Users',     group: 'Records' },
    { id: 'kyc',           icon: '▣', label: 'KYC Applications', group: 'Records' },
    { id: 'withdrawals',   icon: '⇩', label: 'Manage Withdrawals', group: 'Records' },
    { id: 'deposits',      icon: '⇧', label: 'Manage Deposits',  group: 'Records' },
    { id: 'investment-plans', icon: '◈', label: 'Investment Plans', group: 'Trading' },
    { id: 'copy-trading',  icon: '⧉', label: 'Copy Trading',     group: 'Trading' },
    { id: 'bot-trading',   icon: '⌘', label: 'Bot Trading',      group: 'Trading' },
    { id: 'crypto-staking', icon: '♧', label: 'Crypto Staking',  group: 'Trading' },
    { id: 'stock-trading', icon: '▥', label: 'Stock Trading',    group: 'Trading' },
    { id: 'crypto-trading', icon: '₿', label: 'Crypto Trading',  group: 'Trading' },
    { id: 'email-services', icon: '✉', label: 'Email Services',  group: 'Operations' },
    { id: 'tasks',         icon: '✓', label: 'Tasks',            group: 'Operations' },
    { id: 'leads',         icon: '♧', label: 'Leads',            group: 'Operations' },
    { id: 'accounts',      icon: '▤', label: 'Manage Accounts',  group: 'Operations' },
    { id: 'administrators', icon: '♙', label: 'Administrators', group: 'System' },
    { id: 'audit-log',     icon: '❐', label: 'Audit Log',        group: 'System', ownerOnly: true, extra: true },
    { id: 'settings',       icon: '⚙', label: 'Settings',        group: 'System' },
    { id: 'about',         icon: 'ⓘ', label: 'About',           group: 'System' },
  ];

  const main = document.getElementById('main');
  const sidebar = document.getElementById('sidebar');
  const backdrop = document.getElementById('backdrop');
  const crumb = document.getElementById('crumb');

  // ---- tiny helpers ---------------------------------------------------------------
  function heading(title, sub, actions = []) {
    return el('div', { class: 'pagehead' },
      el('div', {},
        el('h1', { text: title }),
        sub ? el('div', { class: 'pagehead__sub', text: sub }) : null),
      actions.length ? el('div', { class: 'pagehead__actions' }, actions) : null);
  }

  /** Wraps a view render so loading / error / permission states are uniform. */
  async function withState(fn, rerun) {
    clear(main);
    main.appendChild(UI.stateLoading());
    try {
      await fn();
      // Views append their own content without clearing the placeholder, so
      // sweep away any loading state that survived the render.
      main.querySelectorAll('.state--loading').forEach((n) => n.remove());
    } catch (err) {
      clear(main);
      main.appendChild(err.permission ? UI.stateDenied(err) : UI.stateError(err, rerun ?? (() => route())));
    }
  }

  function personCell(name, email) {
    return el('div', { class: 'person' },
      el('span', { class: 'miniavatar', 'aria-hidden': 'true' }, initials(name)),
      el('div', {},
        el('div', { text: name || '—' }),
        email ? el('small', { class: 'cell-sub', text: email }) : null));
  }

  function moneyCell(display, sub) {
    const wrap = el('div', { class: 'u-mono' }, display ?? '—');
    if (sub) wrap.appendChild(el('span', { class: 'cell-sub', text: sub }));
    return wrap;
  }

  // ==============================================================================
  // DASHBOARD
  // ==============================================================================
  async function viewDashboard() {
    const { data } = await SS.request('GET', '/dashboard/summary');
    clear(main);

    const cards = data.cards ?? {};
    const order = data.card_order ?? Object.keys(cards);

    // --- stat cards (values straight from the API, demo flags preserved) -------
    const grid = el('div', { class: 'stat-grid' },
      order.map((key) => {
        const c = cards[key];
        if (!c) return null;
        return el('div', { class: `stat${c.is_demo ? ' is-demo' : ''}` },
          el('div', { class: 'stat__top' },
            el('span', { text: c.label }),
            el('span', { class: 'stat__icon', 'aria-hidden': 'true' },
              key === 'total_users' ? '♟' : key === 'total_deposits' ? '⇧'
              : key === 'pending_withdrawals' ? '⇩' : '◈')),
          c.is_demo ? el('span', { class: 'stat__flag', title: c.trend?.label ?? 'Demo aggregate' }, 'demo') : null,
          el('strong', { class: 'stat__value', text: c.display_value ?? String(c.value ?? '—') }),
          el('span', { class: 'stat__trend', text: c.trend?.label ?? '' }));
      }).filter(Boolean));

    main.appendChild(heading('Dashboard',
      'Live platform summary. Figures flagged "demo" are synthetic aggregates the backend labels as such.'));

    main.appendChild(grid);

    // --- activity chart (real series from /dashboard/activity) -----------------
    const chartPanel = el('section', { class: 'panel' });
    const rangeSel = UI.select({
      label: 'Activity range',
      className: 'input input--sm',
      value: '7d',
      options: [{ value: '7d', label: 'Last 7 days' }, { value: '30d', label: 'Last 30 days' }],
      onChange: (v) => loadChart(v),
    });
    chartPanel.appendChild(el('div', { class: 'panel__head' },
      el('div', {},
        el('h2', { text: 'Platform activity' }),
        el('span', { class: 'panel__sub', text: 'Deposits and withdrawals, from the API’s daily series' })),
      rangeSel));
    const chartHost = el('div', { class: 'chart-wrap' });
    chartPanel.appendChild(chartHost);
    main.appendChild(chartPanel);

    async function loadChart(range) {
      clear(chartHost);
      chartHost.appendChild(UI.stateLoading('Loading activity…'));
      let activity;
      try {
        const res = await SS.request('GET', '/dashboard/activity', { query: { range } });
        activity = res.data;
      } catch (err) {
        clear(chartHost);
        chartHost.appendChild(UI.stateError(err, () => loadChart(range)));
        return;
      }
      clear(chartHost);
      chartHost.appendChild(buildActivityChart(activity));
    }
    await loadChart('7d');

    // --- recent users + recent withdrawals ---------------------------------------
    const usersPanel = el('section', { class: 'panel' });
    usersPanel.appendChild(el('div', { class: 'panel__head' },
      el('h2', { text: 'Recently registered users' }),
      el('button', { class: 'btn btn--sm', onclick: () => (location.hash = '#/users') }, 'Manage users')));
    usersPanel.appendChild((data.recent_users ?? []).length === 0
      ? UI.stateEmpty('No users yet.', 'Users appear here as they are registered.')
      : UI.buildTable({
          caption: 'Recently registered users',
          rows: data.recent_users ?? [],
          columns: [
            { key: 'name', label: 'User', render: (r) => personCell(r.name, r.email) },
            { key: 'balance_display', label: 'Balance', align: 'right', render: (r) => moneyCell(r.balance_display) },
            { key: 'status', label: 'Status', render: (r) => pill(r.status) },
            { key: 'kyc_status', label: 'KYC', render: (r) => pill(r.kyc_status) },
            { key: 'created_at', label: 'Joined', render: (r) => fmtDate(r.created_at) },
          ],
        }));

    const wdPanel = el('section', { class: 'panel' });
    wdPanel.appendChild(el('div', { class: 'panel__head' },
      el('h2', { text: 'Recent withdrawal requests' }),
      el('button', { class: 'btn btn--sm', onclick: () => (location.hash = '#/withdrawals') }, 'View all')));
    wdPanel.appendChild((data.recent_withdrawals ?? []).length === 0
      ? UI.stateEmpty('No withdrawal requests.', 'Requests appear here when they are created.')
      : UI.buildTable({
          caption: 'Recent withdrawal requests',
          rows: data.recent_withdrawals ?? [],
          columns: [
            { key: 'client_name', label: 'Client', render: (r) => personCell(r.client_name) },
            { key: 'amount_display', label: 'Amount', align: 'right', render: (r) => moneyCell(r.amount_display) },
            { key: 'payment_method', label: 'Method' },
            { key: 'status', label: 'Status', render: (r) => pill(r.status) },
            { key: 'created_at', label: 'Created', render: (r) => fmtDate(r.created_at) },
          ],
        }));

    const cols = el('div', { class: 'two-col' }, usersPanel, wdPanel);
    main.appendChild(cols);
  }

  /** SVG line chart built entirely from API points. No invented data. */
  function buildActivityChart(activity) {
    const points = activity?.points ?? [];
    const host = el('div', {});
    host.appendChild(el('div', { class: 'chart-legend' },
      el('span', {}, el('i', { class: 'is-deposits' }), 'Deposits'),
      el('span', {}, el('i', { class: 'is-withdrawals' }), 'Withdrawals')));

    if (!points.length) {
      host.appendChild(el('div', { class: 'chart-empty', text: 'No activity data for this range.' }));
      return host;
    }

    const W = 600; const H = 210; const PAD_L = 46; const PAD_B = 26; const PAD_T = 14;
    const max = Math.max(1, ...points.map((p) => Math.max(p.deposits_minor ?? 0, p.withdrawals_minor ?? 0)));
    const stepX = points.length > 1 ? (W - PAD_L - 8) / (points.length - 1) : 0;
    const x = (i) => PAD_L + i * stepX;
    const y = (v) => PAD_T + (H - PAD_T - PAD_B) * (1 - v / max);

    const line = (key, color, area) => {
      const coords = points.map((p, i) => `${x(i).toFixed(1)},${y(p[key] ?? 0).toFixed(1)}`);
      const parts = [];
      if (area) {
        parts.push(el('path', {
          d: `M${coords[0]} L${coords.join(' L')} L${x(points.length - 1).toFixed(1)},${H - PAD_B} L${PAD_L},${H - PAD_B} Z`,
          fill: color, opacity: '0.12', stroke: 'none',
        }));
      }
      parts.push(el('polyline', { points: coords.join(' '), fill: 'none', stroke: color, 'stroke-width': 2.5, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }));
      return parts;
    };

    const grid = [];
    for (let i = 0; i <= 4; i += 1) {
      const gy = PAD_T + ((H - PAD_T - PAD_B) * i) / 4;
      grid.push(el('line', { x1: PAD_L, y1: gy, x2: W - 8, y2: gy, stroke: '#1b2a21', 'stroke-width': 1 }));
    }
    const labelIdx = [0, Math.floor(points.length / 2), points.length - 1];
    const xLabels = labelIdx.map((i) => el('text', {
      x: Math.max(PAD_L, Math.min(W - 60, x(i))), y: H - 8,
      fill: '#637168', 'font-size': 10, 'text-anchor': i === 0 ? 'start' : i === points.length - 1 ? 'end' : 'middle',
    }, String(points[i]?.date ?? '').slice(5)));

    const svg = el('svg', {
      class: 'chart', viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'none',
      'aria-label': 'Deposits and withdrawals activity chart',
      role: 'img',
    },
      el('g', {}, ...grid),
      el('text', { x: 4, y: PAD_T + 4, fill: '#637168', 'font-size': 10 }, fmtCompact(max)),
      el('text', { x: 4, y: H - PAD_B, fill: '#637168', 'font-size': 10 }, '0'),
      ...line('withdrawals', '#7cc4ff', false),
      ...line('deposits', '#83ff53', true),
      ...xLabels);

    host.appendChild(svg);
    host.appendChild(el('p', { class: 'chart-note', text: activity?.note ?? '' }));
    return host;
  }

  function fmtCompact(v) {
    if (v >= 1_000_000) return `$${(v / 100 / 1_000_000).toFixed(1)}M`;
    if (v >= 1_000) return `$${Math.round(v / 100 / 1_000)}k`;
    return `$${Math.round(v / 100)}`;
  }

  // ==============================================================================
  // MANAGE USERS
  // ==============================================================================
  const usersState = { q: '', status: '', kyc: '', sort: 'created_at', dir: 'desc', page: 1, per: 20 };

  async function viewUsers() {
    main.appendChild(heading('Manage Users',
      'Search, filter and inspect registered platform users. Read-only: this backend exposes no user write operations.',
      [el('button', { class: 'btn', onclick: () => exportHint() }, 'Export CSV')]));

    const statusSel = UI.select({
      label: 'Filter by status', className: 'input input--sm', value: usersState.status,
      options: [
        { value: '', label: 'All statuses' },
        { value: 'active', label: 'Active' },
        { value: 'inactive', label: 'Inactive' },
      ],
      onChange: (v) => { usersState.status = v; usersState.page = 1; route(); },
    });
    const kycSel = UI.select({
      label: 'Filter by KYC status', className: 'input input--sm', value: usersState.kyc,
      options: [
        { value: '', label: 'All KYC statuses' },
        { value: 'pending', label: 'KYC pending' },
        { value: 'verified', label: 'KYC verified' },
        { value: 'rejected', label: 'KYC rejected' },
      ],
      onChange: (v) => { usersState.kyc = v; usersState.page = 1; route(); },
    });

    main.appendChild(el('div', { class: 'toolbar' },
      el('div', { class: 'toolgroup' },
        UI.searchBox({ value: usersState.q, placeholder: 'Search name, email or reference…', onSearch: (v) => { usersState.q = v; usersState.page = 1; route(); } }),
        statusSel, kycSel),
    ));

    const facetsHost = el('div', { class: 'facets' });
    main.appendChild(facetsHost);

    const tableHost = el('div', {});
    main.appendChild(tableHost);

    const { data, meta } = await SS.request('GET', '/users', {
      query: {
        page: usersState.page, per_page: usersState.per, search: usersState.q,
        status: usersState.status, kyc_status: usersState.kyc,
        sort: usersState.sort, direction: usersState.dir,
      },
    });

    const f = meta?.facets;
    if (f) {
      clear(facetsHost);
      facetsHost.appendChild(el('span', { class: 'facet' }, el('span', {}, 'Active '), el('b', { text: String(f.active ?? 0) })));
      facetsHost.appendChild(el('span', { class: 'facet' }, el('span', {}, 'Inactive '), el('b', { text: String(f.inactive ?? 0) })));
      facetsHost.appendChild(el('span', { class: 'facet' }, el('span', {}, 'KYC pending '), el('b', { text: String(f.kyc_pending ?? 0) })));
      facetsHost.appendChild(el('span', { class: 'facet' }, el('span', {}, 'KYC verified '), el('b', { text: String(f.kyc_verified ?? 0) })));
    }

    const renderTable = () => {
      clear(tableHost);
      tableHost.appendChild(UI.buildTable({
        caption: 'Platform users',
        rows: data,
        sort: usersState.sort,
        direction: usersState.dir,
        onSort: (key) => {
          if (usersState.sort === key) usersState.dir = usersState.dir === 'asc' ? 'desc' : 'asc';
          else { usersState.sort = key; usersState.dir = 'desc'; }
          route();
        },
        empty: 'No matching users found.',
        emptyHint: 'Try clearing the search or filters.',
        columns: [
          { key: 'id', label: 'ID', sortable: true, render: (r) => el('span', { class: 'u-mono' }, r.id) },
          { key: 'name', label: 'Client', sortable: true, render: (r) => personCell(r.name, r.email) },
          { key: 'balance_display', label: 'Account balance', sortable: true, align: 'right', render: (r) => moneyCell(r.balance_display) },
          { key: 'status', label: 'Status', sortable: true, render: (r) => pill(r.status) },
          { key: 'kyc_status', label: 'KYC', render: (r) => pill(r.kyc_status) },
          { key: 'created_at', label: 'Date created', sortable: true, render: (r) => fmtDate(r.created_at) },
          {
            label: 'Actions',
            render: (r) => el('button', {
              class: 'btn btn--sm', type: 'button',
              'aria-label': `View user ${r.name}`,
              onclick: () => showUser(r.id),
            }, 'View'),
          },
        ],
      }));
      if (meta?.pagination) {
        tableHost.appendChild(UI.buildPagination(meta.pagination, {
          onPage: (p) => { usersState.page = p; route(); },
          perPage: meta.pagination.per_page,
          onPerPage: (n) => { usersState.per = n; usersState.page = 1; route(); },
        }));
      }
    };
    renderTable();
  }

  async function showUser(id) {
    const host = el('div', {});
    UI.openDialog({
      title: 'User details',
      body: host,
      confirmLabel: null,
      cancelLabel: 'Close',
    });
    clear(host);
    host.appendChild(UI.stateLoading('Loading user…'));
    try {
      const { data: u } = await SS.request('GET', `/users/${encodeURIComponent(id)}`);
      clear(host);
      host.appendChild(el('dl', { class: 'dl' },
        el('dt', {}, 'Reference'), el('dd', { class: 'u-mono' }, u.id),
        el('dt', {}, 'Name'), el('dd', {}, u.name),
        el('dt', {}, 'Email'), el('dd', {}, u.email),
        el('dt', {}, 'Balance'), el('dd', { class: 'u-mono' }, `${u.balance_display} (${u.balance_minor} minor units)`),
        el('dt', {}, 'Status'), el('dd', {}, pill(u.status)),
        el('dt', {}, 'KYC'), el('dd', {}, pill(u.kyc_status)),
        el('dt', {}, 'Joined'), el('dd', {}, fmtDate(u.created_at)),
        el('dt', {}, 'Demo record'), el('dd', {}, u.is_demo ? 'Yes — synthetic fixture' : 'No')));

      host.appendChild(el('h3', { style: 'margin:18px 0 8px;font-size:13px;', text: 'Recent withdrawal requests' }));
      if ((u.recent_withdrawals ?? []).length === 0) {
        host.appendChild(el('p', { class: 'state__hint state__hint--muted', text: 'No withdrawal requests for this user.' }));
      } else {
        host.appendChild(UI.buildTable({
          caption: 'This user’s recent withdrawal requests',
          rows: u.recent_withdrawals,
          columns: [
            { key: 'id', label: 'ID', render: (r) => el('span', { class: 'u-mono' }, r.id) },
            { key: 'amount_display', label: 'Amount', align: 'right' },
            { key: 'payment_method', label: 'Method' },
            { key: 'status', label: 'Status', render: (r) => pill(r.status) },
            { key: 'created_at', label: 'Created', render: (r) => fmtDate(r.created_at) },
          ],
        }));
      }
    } catch (err) {
      clear(host);
      host.appendChild(err.permission ? UI.stateDenied(err) : UI.stateError(err));
    }
  }

  function exportHint() {
    // The backend has no CSV export endpoint; the list endpoint is paginated,
    // so a true export would need either a dedicated route or page-walking.
    // Rather than silently emitting a partial file, say so.
    UI.toast('CSV export is not available: the backend has no export endpoint. Use the table filters and pagination instead.', 'info');
  }

  // ==============================================================================
  // MANAGE WITHDRAWALS (read-only — no review endpoints exist)
  // ==============================================================================
  const wdState = { q: '', status: '', method: '', from: '', to: '', sort: 'created_at', dir: 'desc', page: 1, per: 20 };

  async function viewWithdrawals() {
    main.appendChild(heading('Manage Withdrawals',
      'Withdrawal requests and their statuses. This backend defines no approve/reject/process actions, so the list is read-only.'));

    const facets = (await SS.request('GET', '/withdrawals/facets')).data;

    const statusSel = UI.select({
      label: 'Filter by status', className: 'input input--sm', value: wdState.status,
      options: [{ value: '', label: 'All statuses' },
        ...facets.statuses.map((s) => ({ value: s, label: s[0].toUpperCase() + s.slice(1) }))],
      onChange: (v) => { wdState.status = v; wdState.page = 1; route(); },
    });
    const methodSel = UI.select({
      label: 'Filter by method', className: 'input input--sm', value: wdState.method,
      options: [{ value: '', label: 'All methods' },
        ...(facets.methods ?? []).map((m) => ({ value: m, label: m }))],
      onChange: (v) => { wdState.method = v; wdState.page = 1; route(); },
    });

    const fromInput = el('input', {
      class: 'input input--sm', type: 'date', value: wdState.from,
      'aria-label': 'Created from date',
      onchange: (e) => { wdState.from = e.target.value; wdState.page = 1; route(); },
    });
    const toInput = el('input', {
      class: 'input input--sm', type: 'date', value: wdState.to,
      'aria-label': 'Created to date',
      onchange: (e) => { wdState.to = e.target.value; wdState.page = 1; route(); },
    });

    main.appendChild(el('div', { class: 'toolbar' },
      el('div', { class: 'toolgroup' },
        UI.searchBox({ value: wdState.q, placeholder: 'Search client, method or email…', onSearch: (v) => { wdState.q = v; wdState.page = 1; route(); } }),
        statusSel, methodSel, fromInput, toInput)));

    const pending = facets.pending;
    const facetsHost = el('div', { class: 'facets' },
      el('span', { class: 'facet' }, el('span', {}, 'Pending requests '), el('b', { text: String(pending?.count ?? 0) })),
      el('span', { class: 'facet' }, el('span', {}, 'Pending total '), el('b', { class: 'u-mono', text: pending?.amount_display ?? '—' })));
    main.appendChild(facetsHost);

    const tableHost = el('div', {});
    main.appendChild(tableHost);

    const { data, meta } = await SS.request('GET', '/withdrawals', {
      query: {
        page: wdState.page, per_page: wdState.per, search: wdState.q,
        status: wdState.status, method: wdState.method, from: wdState.from, to: wdState.to,
        sort: wdState.sort, direction: wdState.dir,
      },
    });

    clear(tableHost);
    tableHost.appendChild(UI.buildTable({
      caption: 'Withdrawal requests',
      rows: data,
      sort: wdState.sort,
      direction: wdState.dir,
      onSort: (key) => {
        if (wdState.sort === key) wdState.dir = wdState.dir === 'asc' ? 'desc' : 'asc';
        else { wdState.sort = key; wdState.dir = 'desc'; }
        route();
      },
      empty: 'No withdrawal requests found.',
      emptyHint: 'Try clearing the search, filters or dates.',
      columns: [
        { key: 'id', label: 'ID', sortable: true, render: (r) => el('span', { class: 'u-mono' }, r.id) },
        { key: 'client_name', label: 'Client name', render: (r) => personCell(r.client_name) },
        { key: 'amount_display', label: 'Amount requested', sortable: true, align: 'right' },
        { key: 'fee_display', label: 'Amount charges', sortable: true, align: 'right' },
        { key: 'payment_method', label: 'Payment method' },
        { key: 'receiver_email', label: 'Receiver’s email' },
        { key: 'status', label: 'Status', sortable: true, render: (r) => pill(r.status) },
        { key: 'created_at', label: 'Date created', sortable: true, render: (r) => fmtDate(r.created_at) },
        {
          label: 'Actions',
          render: (r) => el('button', {
            class: 'btn btn--sm', 'aria-label': `View withdrawal ${r.id}`,
            onclick: () => showWithdrawal(r.id),
          }, 'View'),
        },
      ],
    }));
    if (meta?.pagination) {
      tableHost.appendChild(UI.buildPagination(meta.pagination, {
        onPage: (p) => { wdState.page = p; route(); },
        perPage: meta.pagination.per_page,
        onPerPage: (n) => { wdState.per = n; wdState.page = 1; route(); },
      }));
    }
  }

  async function showWithdrawal(id) {
    const host = el('div', {});
    UI.openDialog({ title: 'Withdrawal request', body: host, confirmLabel: null, cancelLabel: 'Close' });
    clear(host);
    host.appendChild(UI.stateLoading('Loading request…'));
    try {
      const { data: w } = await SS.request('GET', `/withdrawals/${encodeURIComponent(id)}`);
      clear(host);
      host.appendChild(el('dl', { class: 'dl' },
        el('dt', {}, 'Reference'), el('dd', { class: 'u-mono' }, w.id),
        el('dt', {}, 'Client'), el('dd', {}, w.client_name ?? '—'),
        el('dt', {}, 'Client reference'), el('dd', { class: 'u-mono' }, w.user_ref ?? '—'),
        el('dt', {}, 'Amount requested'), el('dd', { class: 'u-mono' }, w.amount_display),
        el('dt', {}, 'Charges'), el('dd', { class: 'u-mono' }, w.fee_display),
        el('dt', {}, 'Net'), el('dd', { class: 'u-mono' }, w.net_display),
        el('dt', {}, 'Payment method'), el('dd', {}, w.payment_method),
        el('dt', {}, 'Receiver email'), el('dd', {}, w.receiver_email),
        el('dt', {}, 'Status'), el('dd', {}, pill(w.status)),
        el('dt', {}, 'Created'), el('dd', {}, fmtDateTime(w.created_at)),
        el('dt', {}, 'Last updated'), el('dd', {}, w.updated_at ? fmtDateTime(w.updated_at) : '—'),
        el('dt', {}, 'Demo record'), el('dd', {}, w.is_demo ? 'Yes — synthetic fixture' : 'No')));
      host.appendChild(el('p', { class: 'state__hint state__hint--muted', style: 'margin-top:14px;',
        text: 'No review actions exist in this backend, so none are offered here.' }));
    } catch (err) {
      clear(host);
      host.appendChild(err.permission ? UI.stateDenied(err) : UI.stateError(err));
    }
  }

  // ==============================================================================
  // KYC APPLICATIONS (read-only status view — no documents, no review actions)
  // ==============================================================================
  const kycState = { status: 'pending', page: 1, per: 20 };

  async function viewKyc() {
    main.appendChild(heading('KYC Applications',
      'KYC status per user. This backend stores a status label only — there are no documents, no upload, and no review actions.'));

    main.appendChild(el('div', { class: 'notice notice--warn' },
      el('span', { class: 'notice__icon', 'aria-hidden': 'true' }, '⚠'),
      el('span', {},
        'Read-only status view. The backend deliberately collects no identity documents, so none can be viewed here, and it defines no verify/reject workflow, so none is offered.')));

    const facets = (await SS.request('GET', '/users/facets')).data;
    const chips = el('div', { class: 'facets' });
    const allKyc = facets?.kyc_status ?? [];
    for (const f of allKyc) {
      chips.appendChild(el('button', {
        class: `facet is-filter${kycState.status === f.key ? ' is-on' : ''}`,
        type: 'button',
        'aria-pressed': kycState.status === f.key ? 'true' : 'false',
        onclick: () => { kycState.status = f.key; kycState.page = 1; route(); },
      }, `${f.label} `, el('b', { text: String(f.count ?? 0) })));
    }
    main.appendChild(chips);

    const tableHost = el('div', {});
    main.appendChild(tableHost);

    const { data, meta } = await SS.request('GET', '/users', {
      query: { page: kycState.page, per_page: kycState.per, kyc_status: kycState.status, sort: 'created_at', direction: 'desc' },
    });

    clear(tableHost);
    tableHost.appendChild(UI.buildTable({
      caption: `Users with KYC status ${kycState.status}`,
      rows: data,
      empty: `No users with KYC status “${kycState.status}”.`,
      columns: [
        { key: 'id', label: 'ID', render: (r) => el('span', { class: 'u-mono' }, r.id) },
        { key: 'name', label: 'Client', render: (r) => personCell(r.name, r.email) },
        { key: 'kyc_status', label: 'KYC status', render: (r) => pill(r.kyc_status) },
        { key: 'status', label: 'Account status', render: (r) => pill(r.status) },
        { key: 'created_at', label: 'Joined', render: (r) => fmtDate(r.created_at) },
        {
          label: 'Actions',
          render: (r) => el('button', { class: 'btn btn--sm', 'aria-label': `View user ${r.name}`, onclick: () => showUser(r.id) }, 'View'),
        },
      ],
    }));
    if (meta?.pagination) {
      tableHost.appendChild(UI.buildPagination(meta.pagination, {
        onPage: (p) => { kycState.page = p; route(); },
      }));
    }
  }

  // ==============================================================================
  // ADMINISTRATORS (session + security — the backend exposes no admin listing)
  // ==============================================================================
  async function viewAdministrators() {
    main.appendChild(heading('Administrators',
      'Your administrator session and account security.'));

    main.appendChild(el('div', { class: 'notice' },
      el('span', { class: 'notice__icon', 'aria-hidden': 'true' }, 'ℹ'),
      el('span', {},
        'This backend deliberately exposes no endpoint that lists administrators, so no directory is shown — only your own session. Administrator accounts are provisioned from the server console, never through this UI.')));

    const me = await SS.me();
    const grid = el('div', { class: 'kv-grid' },
      el('div', { class: 'kv' }, el('div', { class: 'kv__label' }, 'Name'), el('div', { class: 'kv__value' }, me.full_name)),
      el('div', { class: 'kv' }, el('div', { class: 'kv__label' }, 'Email'), el('div', { class: 'kv__value' }, me.email)),
      el('div', { class: 'kv' }, el('div', { class: 'kv__label' }, 'Role'), el('div', { class: 'kv__value' }, pill(me.role))),
      el('div', { class: 'kv' }, el('div', { class: 'kv__label' }, 'Status'), el('div', { class: 'kv__value' }, pill(me.status))),
      el('div', { class: 'kv' }, el('div', { class: 'kv__label' }, 'Last sign-in'), el('div', { class: 'kv__value' }, me.last_login_at ? fmtDateTime(me.last_login_at) : '—')));
    const wrap = el('section', { class: 'panel' });
    wrap.appendChild(el('div', { class: 'panel__head' }, el('h2', { text: 'Current session' })));
    wrap.appendChild(grid);
    main.appendChild(wrap);

    // ---- change password (supported by POST /auth/change-password) ---------------
    const pwPanel = el('section', { class: 'panel' });
    pwPanel.appendChild(el('div', { class: 'panel__head' },
      el('h2', { text: 'Change password' }),
      el('span', { class: 'panel__sub', text: 'Revokes every active session — you will be signed out.' })));

    const cur = el('input', { class: 'input', type: 'password', id: 'pw-cur', autocomplete: 'current-password' });
    const next = el('input', { class: 'input', type: 'password', id: 'pw-next', autocomplete: 'new-password' });
    const confirm = el('input', { class: 'input', type: 'password', id: 'pw-conf', autocomplete: 'new-password' });
    const pwErr = el('p', { class: 'field__error', role: 'alert' });

    pwPanel.appendChild(el('form', { novalidate: true, onsubmit: async (e) => {
      e.preventDefault();
      pwErr.textContent = '';
      const a = cur.value; const b = next.value; const c = confirm.value;
      if (!a || !b) { pwErr.textContent = 'Fill in every field.'; return; }
      if (b !== c) { pwErr.textContent = 'The new passwords do not match.'; return; }
      if (b.length < 12 || !/[a-z]/.test(b) || !/[A-Z]/.test(b) || !/[0-9]/.test(b) || !/[^A-Za-z0-9]/.test(b)) {
        pwErr.textContent = 'New password needs 12+ characters with upper, lower, number and symbol.';
        return;
      }
      try {
        await SS.changePassword(a, b);
        UI.toast('Password changed. All sessions were revoked — signing you out…', 'success');
        setTimeout(() => { location.href = 'login.html?changed=1'; }, 1400);
      } catch (err) {
        pwErr.textContent = SS.describe(err);
      }
    } },
      el('div', { class: 'field' }, el('label', { for: 'pw-cur' }, 'Current password'), cur),
      el('div', { class: 'field' }, el('label', { for: 'pw-next' }, 'New password'),
        next, el('p', { class: 'field__hint' }, 'At least 12 characters with upper, lower, number and symbol.')),
      el('div', { class: 'field' }, el('label', { for: 'pw-conf' }, 'Confirm new password'), confirm),
      pwErr,
      el('button', { class: 'btn btn--primary', type: 'submit' }, 'Change password')));
    main.appendChild(pwPanel);

    // ---- revoke all sessions ------------------------------------------------------
    const revokePanel = el('section', { class: 'panel' });
    revokePanel.appendChild(el('div', { class: 'panel__head' },
      el('h2', { text: 'Sign out everywhere' }),
      el('span', { class: 'panel__sub', text: 'POST /auth/logout-all' })));
    revokePanel.appendChild(el('p', { class: 'state__hint', text: 'Revokes every refresh session for your account, on every device. You will be signed out immediately.' }));
    revokePanel.appendChild(el('button', {
      class: 'btn btn--danger', type: 'button',
      onclick: async () => {
        const ok = await UI.confirmAction({
          title: 'Sign out on every device?',
          message: `This revokes all sessions for ${me.email}. You will need to sign in again on every device.`,
          confirmLabel: 'Sign out everywhere',
        });
        if (!ok) return;
        await SS.logoutAll();
        location.href = 'login.html';
      },
    }, 'Sign out everywhere'));
    main.appendChild(revokePanel);
  }

  // ==============================================================================
  // SETTINGS (payment methods + payment preferences)
  // ==============================================================================
  const pmState = { q: '', type: '', used_for: '', status: '', page: 1, per: 20 };
  let settingsTab = 'methods';

  async function viewSettings() {
    main.appendChild(heading('Settings',
      'Payment configuration shared with the customer portal.',
      canWrite() ? null : [el('span', { class: 'role-badge' }, 'read-only role')]));
    if (!canWrite()) {
      main.appendChild(el('div', { class: 'notice' },
        el('span', { class: 'notice__icon', 'aria-hidden': 'true' }, 'ℹ'),
        el('span', {},
          `Your role (“${session.role}”) can read this configuration but cannot change it. Write controls are hidden; the backend enforces this independently.`)));
    }

    const tabMethods = el('button', {
      class: `tab${settingsTab === 'methods' ? ' is-active' : ''}`, type: 'button',
      'aria-pressed': settingsTab === 'methods' ? 'true' : 'false',
      onclick: () => { settingsTab = 'methods'; route(); },
    }, 'Payment Methods');
    const tabPrefs = el('button', {
      class: `tab${settingsTab === 'prefs' ? ' is-active' : ''}`, type: 'button',
      'aria-pressed': settingsTab === 'prefs' ? 'true' : 'false',
      onclick: () => { settingsTab = 'prefs'; route(); },
    }, 'Payment Preferences');
    main.appendChild(el('div', { class: 'tabs', role: 'tablist' }, tabMethods, tabPrefs));

    if (settingsTab === 'methods') await renderMethodsTab();
    else await renderPrefsTab();
  }

  async function renderMethodsTab() {
    const typeSel = UI.select({
      label: 'Filter by type', className: 'input input--sm', value: pmState.type,
      options: [{ value: '', label: 'All types' }, { value: 'crypto', label: 'Crypto' }, { value: 'currency', label: 'Currency' }],
      onChange: (v) => { pmState.type = v; pmState.page = 1; route(); },
    });
    const usedSel = UI.select({
      label: 'Filter by usage', className: 'input input--sm', value: pmState.used_for,
      options: [{ value: '', label: 'All usages' }, { value: 'deposit', label: 'Deposit' }, { value: 'withdraw', label: 'Withdraw' }, { value: 'both', label: 'Both' }],
      onChange: (v) => { pmState.used_for = v; pmState.page = 1; route(); },
    });
    const statusSel = UI.select({
      label: 'Filter by status', className: 'input input--sm', value: pmState.status,
      options: [{ value: '', label: 'All statuses' }, { value: 'enabled', label: 'Enabled' }, { value: 'disabled', label: 'Disabled' }],
      onChange: (v) => { pmState.status = v; pmState.page = 1; route(); },
    });

    main.appendChild(el('div', { class: 'toolbar' },
      el('div', { class: 'toolgroup' },
        UI.searchBox({ value: pmState.q, placeholder: 'Search methods…', onSearch: (v) => { pmState.q = v; pmState.page = 1; route(); } }),
        typeSel, usedSel, statusSel),
      canWrite()
        ? el('button', { class: 'btn btn--primary', type: 'button', onclick: () => methodDialog(null) }, '＋ Add New')
        : null));

    const { data, meta } = await SS.request('GET', '/payment-methods', {
      query: {
        page: pmState.page, per_page: pmState.per, search: pmState.q,
        type: pmState.type, used_for: pmState.used_for, status: pmState.status,
        sort: 'name', direction: 'asc',
      },
    });

    const f = meta?.facets;
    if (f) {
      main.appendChild(el('div', { class: 'facets' },
        el('span', { class: 'facet' }, 'Enabled ', el('b', { text: String(f.enabled ?? 0) })),
        el('span', { class: 'facet' }, 'Disabled ', el('b', { text: String(f.disabled ?? 0) })),
        el('span', { class: 'facet' }, 'Crypto ', el('b', { text: String(f.crypto ?? 0) })),
        el('span', { class: 'facet' }, 'Currency ', el('b', { text: String(f.currency ?? 0) }))));
    }

    const tableHost = el('div', {});
    main.appendChild(tableHost);
    clear(tableHost);
    tableHost.appendChild(UI.buildTable({
      caption: 'Payment methods',
      rows: data,
      empty: 'No payment methods match.',
      columns: [
        { key: 'name', label: 'Method name' },
        { key: 'type', label: 'Type' },
        { key: 'used_for', label: 'Used for' },
        { key: 'status', label: 'Status', render: (r) => pill(r.status) },
        { key: 'updated_at', label: 'Updated', render: (r) => fmtDate(r.updated_at) },
        {
          label: 'Actions',
          render: (r) => el('div', { class: 'toolgroup' },
            canWrite() ? el('button', {
              class: 'btn btn--sm', type: 'button',
              'aria-label': `${r.status === 'enabled' ? 'Disable' : 'Enable'} ${r.name}`,
              onclick: () => toggleMethod(r),
            }, r.status === 'enabled' ? 'Disable' : 'Enable') : null,
            canWrite() ? el('button', {
              class: 'btn btn--sm', type: 'button', 'aria-label': `Edit ${r.name}`,
              onclick: () => methodDialog(r),
            }, 'Edit') : null,
            canWrite() ? el('button', {
              class: 'btn btn--sm btn--danger', type: 'button', 'aria-label': `Delete ${r.name}`,
              onclick: () => deleteMethod(r),
            }, 'Delete') : el('span', { class: 'state__hint state__hint--muted' }, 'read-only')),
        },
      ],
    }));
    if (meta?.pagination) {
      tableHost.appendChild(UI.buildPagination(meta.pagination, {
        onPage: (p) => { pmState.page = p; route(); },
      }));
    }
  }

  async function toggleMethod(m) {
    const action = m.status === 'enabled' ? 'disable' : 'enable';
    try {
      await SS.request('POST', `/payment-methods/${encodeURIComponent(m.id)}/${action}`);
      UI.toast(`${m.name} ${action}d.`, 'success');
      route();
    } catch (err) {
      UI.toast(SS.describe(err), 'error');
    }
  }

  async function deleteMethod(m) {
    const ok = await UI.confirmAction({
      title: `Delete “${m.name}”?`,
      message: `This permanently removes the payment method “${m.name}” (${m.type}, used for ${m.used_for}) from the shared configuration. The customer portal will stop showing it immediately. There is no undo.`,
      confirmLabel: 'Delete method',
    });
    if (!ok) return;
    try {
      await SS.request('DELETE', `/payment-methods/${encodeURIComponent(m.id)}`);
      UI.toast(`“${m.name}” deleted.`, 'success');
      route();
    } catch (err) {
      UI.toast(SS.describe(err), 'error');
    }
  }

  async function methodDialog(existing) {
    const nameInput = el('input', {
      class: 'input', type: 'text', id: 'm-name', value: existing?.name ?? '',
      'aria-label': 'Method name', maxlength: '80',
    });
    const typeSel = UI.select({
      label: 'Type', value: existing?.type ?? 'crypto',
      options: [{ value: 'crypto', label: 'Crypto' }, { value: 'currency', label: 'Currency' }],
      onChange: () => {},
    });
    const usedSel = UI.select({
      label: 'Used for', value: existing?.used_for ?? 'both',
      options: [{ value: 'both', label: 'Both' }, { value: 'deposit', label: 'Deposit' }, { value: 'withdraw', label: 'Withdraw' }],
      onChange: () => {},
    });
    const statusSel = UI.select({
      label: 'Status', value: existing?.status ?? 'disabled',
      options: [{ value: 'disabled', label: 'Disabled' }, { value: 'enabled', label: 'Enabled' }],
      onChange: () => {},
    });
    const errP = el('p', { class: 'field__error', role: 'alert' });

    const body = el('div', {},
      el('div', { class: 'field' }, el('label', { for: 'm-name' }, 'Method name'), nameInput,
        el('p', { class: 'field__hint' }, '2–80 characters. Must be unique — the server rejects duplicates.')),
      el('div', { class: 'fieldgrid' },
        el('div', { class: 'field' }, el('span', {}, 'Type'), typeSel),
        el('div', { class: 'field' }, el('span', {}, 'Used for'), usedSel)),
      el('div', { class: 'field' }, el('span', {}, 'Status'), statusSel),
      errP);

    UI.openDialog({
      title: existing ? `Edit “${existing.name}”` : 'Add a payment method',
      body,
      confirmLabel: existing ? 'Save changes' : 'Create method',
      danger: false,
      onConfirm: async () => {
        errP.textContent = '';
        const payload = {
          name: nameInput.value.trim(),
          type: typeSel.value,
          used_for: usedSel.value,
          status: statusSel.value,
        };
        if (payload.name.length < 2) { errP.textContent = 'Name must be at least 2 characters.'; throw new Error('validation'); }
        try {
          if (existing) {
            await SS.request('PATCH', `/payment-methods/${encodeURIComponent(existing.id)}`, { body: payload });
            UI.toast(`“${payload.name}” updated.`, 'success');
          } else {
            await SS.request('POST', '/payment-methods', { body: payload });
            UI.toast(`“${payload.name}” created.`, 'success');
          }
          route();
        } catch (err) {
          // Show the server's own validation verdict — never assume success.
          if (err.details?.length) errP.textContent = err.details.map((d) => `${d.field}: ${d.message}`).join(' · ');
          else errP.textContent = SS.describe(err);
          throw err;
        }
      },
    });
  }

  async function renderPrefsTab() {
    const [settings, currencies] = await Promise.all([
      SS.request('GET', '/payment-settings'),
      SS.request('GET', '/payment-settings/currencies'),
    ]);
    const s = settings.data;
    const c = currencies.data;

    const panel = el('section', { class: 'panel' });
    panel.appendChild(el('div', { class: 'panel__head' },
      el('h2', { text: 'Payment preferences' }),
      el('span', { class: 'panel__sub' }, s.updated_at ? `Last updated ${fmtDateTime(s.updated_at)}${s.updated_by_email ? ` by ${s.updated_by_email}` : ''}` : '')));

    const curSel = UI.select({
      label: 'Default currency', value: s.default_currency,
      options: (c.currencies ?? []).map((x) => ({ value: x.code, label: x.label })),
      onChange: () => {},
    });
    const modeSel = UI.select({
      label: 'Payment processing mode', value: s.processing_mode,
      options: (c.processing_modes ?? []).map((x) => ({ value: x.key, label: x.label })),
      onChange: () => {},
    });
    const instructions = el('textarea', {
      class: 'input', id: 's-instr', 'aria-label': 'Payment instructions',
    }, s.payment_instructions ?? '');
    const minDep = el('input', { class: 'input', type: 'text', inputmode: 'decimal', id: 's-mindep', value: minorToAmount(s.minimum_deposit_minor), 'aria-label': 'Minimum deposit' });
    const minWd = el('input', { class: 'input', type: 'text', inputmode: 'decimal', id: 's-minwd', value: minorToAmount(s.minimum_withdrawal_minor), 'aria-label': 'Minimum withdrawal' });
    const errP = el('p', { class: 'field__error', role: 'alert' });
    const readonly = !canWrite();
    if (readonly) { [curSel, modeSel, instructions, minDep, minWd].forEach((n) => { n.disabled = true; }); }

    panel.appendChild(el('form', { novalidate: true, onsubmit: async (e) => {
      e.preventDefault();
      errP.textContent = '';
      const body = {
        default_currency: curSel.value,
        processing_mode: modeSel.value,
        payment_instructions: instructions.value,
        minimum_deposit: minDep.value.trim(),
        minimum_withdrawal: minWd.value.trim(),
      };
      for (const [k, v] of [['minimum deposit', body.minimum_deposit], ['minimum withdrawal', body.minimum_withdrawal]]) {
        if (!/^\d+(\.\d{1,2})?$/.test(String(v))) {
          errP.textContent = `The ${k} must be a non-negative amount with at most two decimals (e.g. 10.00).`;
          return;
        }
      }
      try {
        const res = await SS.request('PUT', '/payment-settings', { body });
        UI.toast('Payment preferences saved.', 'success');
        // Re-render with the server's authoritative values.
        settingsTab = 'prefs';
        route();
      } catch (err) {
        if (err.details?.length) errP.textContent = err.details.map((d) => `${d.field}: ${d.message}`).join(' · ');
        else errP.textContent = SS.describe(err);
      }
    } },
      el('div', { class: 'fieldgrid' },
        el('div', { class: 'field' }, el('label', {}, 'Default currency'), curSel),
        el('div', { class: 'field' }, el('label', {}, 'Payment processing mode'), modeSel)),
      el('div', { class: 'field field--full' }, el('label', { for: 's-instr' }, 'Payment instructions'), instructions),
      el('div', { class: 'fieldgrid' },
        el('div', { class: 'field' }, el('label', { for: 's-mindep' }, 'Minimum deposit'), minDep,
          el('p', { class: 'field__hint' }, `Currently ${s.minimum_deposit_display}`)),
        el('div', { class: 'field' }, el('label', { for: 's-minwd' }, 'Minimum withdrawal'), minWd,
          el('p', { class: 'field__hint' }, `Currently ${s.minimum_withdrawal_display}`))),
      errP,
      readonly
        ? el('p', { class: 'state__hint state__hint--muted', text: 'Read-only for your role.' })
        : el('button', { class: 'btn btn--primary', type: 'submit' }, 'Save changes')));
    main.appendChild(panel);
  }

  function minorToAmount(minor) {
    const n = Number(minor ?? 0);
    return (n / 100).toFixed(2);
  }

  // ==============================================================================
  // AUDIT LOG (backend capability, not in the mockup nav — owner only)
  // ==============================================================================
  const auditState = { action: '', entity: '', page: 1, per: 25 };

  async function viewAudit() {
    main.appendChild(heading('Audit Log',
      'Every administrative change recorded by the backend. Read-only.'));
    main.appendChild(el('div', { class: 'notice' },
      el('span', { class: 'notice__icon', 'aria-hidden': 'true' }, 'ℹ'),
      el('span', {}, 'This section exists in the backend but not in the original mockup navigation; it is included because the API supports it. Owner role only.')));

    const actionInput = el('input', {
      class: 'input input--sm', type: 'search', placeholder: 'Filter by action…',
      value: auditState.action, 'aria-label': 'Filter by action',
      oninput: (e) => { auditState.action = e.target.value.trim(); auditState.page = 1; route(); },
    });
    const entityInput = el('input', {
      class: 'input input--sm', type: 'search', placeholder: 'Filter by entity type…',
      value: auditState.entity, 'aria-label': 'Filter by entity type',
      oninput: (e) => { auditState.entity = e.target.value.trim(); auditState.page = 1; route(); },
    });
    main.appendChild(el('div', { class: 'toolbar' },
      el('div', { class: 'toolgroup' }, actionInput, entityInput)));

    const { data, meta } = await SS.request('GET', '/audit-log', {
      query: { page: auditState.page, per_page: auditState.per, action: auditState.action, entity_type: auditState.entity },
    });

    const tableHost = el('div', {});
    main.appendChild(tableHost);
    clear(tableHost);
    tableHost.appendChild(UI.buildTable({
      caption: 'Administrative audit trail',
      rows: data,
      empty: 'No audit entries match.',
      columns: [
        { key: 'action', label: 'Action', render: (r) => el('span', { class: 'u-mono', style: 'font-size:11.5px;' }, r.action) },
        { key: 'entity_type', label: 'Entity', render: (r) => el('span', {}, `${r.entity_type}${r.entity_id ? ` · ${r.entity_id}` : ''}`) },
        { key: 'summary', label: 'Summary' },
        { key: 'actor', label: 'Actor', render: (r) => el('span', {}, r.actor?.email ?? '—') },
        { key: 'created_at', label: 'When', render: (r) => fmtDateTime(r.created_at) },
        {
          label: 'Actions',
          render: (r) => el('button', {
            class: 'btn btn--sm', 'aria-label': `View audit entry ${r.id}`,
            onclick: () => {
              const detail = el('div', {},
                el('p', { class: 'state__hint', text: r.summary }),
                r.before ? auditJson('Before', r.before) : null,
                r.after ? auditJson('After', r.after) : null);
              UI.openDialog({ title: r.action, body: detail, confirmLabel: null, cancelLabel: 'Close' });
            },
          }, 'Details'),
        },
      ],
    }));
    if (meta?.pagination) {
      tableHost.appendChild(UI.buildPagination(meta.pagination, {
        onPage: (p) => { auditState.page = p; route(); },
      }));
    }
  }

  function auditJson(label, obj) {
    const details = el('details', { style: 'margin-top:10px;' },
      el('summary', { style: 'cursor:pointer;color:var(--muted);font-size:12px;' }, label),
      el('pre', {
        style: 'background:var(--bg-soft);border:1px solid var(--line);border-radius:8px;padding:10px;overflow:auto;font-size:11px;color:var(--text);',
        text: JSON.stringify(obj, null, 2),
      }));
    return details;
  }

  // ==============================================================================
  // ABOUT
  // ==============================================================================
  async function viewAbout() {
    main.appendChild(heading('About', 'What this deployment is, from the backend’s own health endpoint.'));

    const h = await SS.health();
    const front = window.__SS_CONFIG__?.frontendVersion ?? 'unknown';

    const panel = el('section', { class: 'panel' });
    panel.appendChild(el('div', { class: 'panel__head' }, el('h2', { text: 'Deployment' })));
    panel.appendChild(el('div', { class: 'kv-grid' },
      el('div', { class: 'kv' }, el('div', { class: 'kv__label' }, 'API status'), el('div', { class: 'kv__value' }, pill(h.status))),
      el('div', { class: 'kv' }, el('div', { class: 'kv__label' }, 'API version'), el('div', { class: 'kv__value' }, h.api_version ?? '—')),
      el('div', { class: 'kv' }, el('div', { class: 'kv__label' }, 'Database driver'), el('div', { class: 'kv__value' }, `${h.checks?.driver ?? '—'}${h.checks?.durable ? '' : ' (non-durable)'}`)),
      el('div', { class: 'kv' }, el('div', { class: 'kv__label' }, 'API uptime'), el('div', { class: 'kv__value' }, fmtUptime(h.uptime_seconds))),
      el('div', { class: 'kv' }, el('div', { class: 'kv__label' }, 'Admin UI version'), el('div', { class: 'kv__value' }, front)),
      el('div', { class: 'kv' }, el('div', { class: 'kv__label' }, 'Environment'), el('div', { class: 'kv__value' }, h.demo_environment ? 'Demo — synthetic data only' : 'Production'))));
    main.appendChild(panel);

    main.appendChild(el('div', { class: 'notice notice--warn' },
      el('span', { class: 'notice__icon', 'aria-hidden': 'true' }, '⚠'),
      el('span', {},
        'Records flagged “demo” throughout this console are synthetic fixtures the backend labels itself. No live market feeds, payment providers or financial operations are connected.')));
  }

  // ==============================================================================
  // NOT-AVAILABLE SECTIONS (documented gaps, no invented data)
  // ==============================================================================
  const NA = {
    'investment-plans': {
      because: 'The backend has no investment-plan endpoints: no plan catalogue, terms, subscriptions or returns exist anywhere in its data model.',
      needed: ['investment_plans table', 'GET /investment-plans', 'plan terms & pricing rules (a business decision)'],
    },
    deposits: {
      because: 'The backend models no deposit records — only withdrawals exist as a per-user financial history. No deposit list, and no deposit review semantics, are defined.',
      needed: ['deposits table', 'GET /deposits', 'deposit review/approval rules (a business decision)'],
    },
    'email-services': {
      because: 'The backend deliberately sends no email: there are no template, provider or delivery-log endpoints.',
      needed: ['email provider integration', 'GET/PUT /email-templates', 'delivery-log model'],
    },
    'copy-trading': {
      because: 'No copy-trading model exists: no traders, strategies, followers or subscription records, and no rules for what copying would mean.',
      needed: ['strategy/trader model', 'GET /copy-trading/strategies', 'fee & allocation rules (a business decision)'],
    },
    'bot-trading': {
      because: 'No bot model exists: no bot definitions, runs or allocations, and no execution semantics.',
      needed: ['bot model', 'GET /bots', 'execution engine (explicitly out of backend scope)'],
    },
    'crypto-staking': {
      because: 'No staking model exists: no asset catalogue, durations, reward rules or positions.',
      needed: ['staking assets & durations', 'GET /staking/positions', 'reward rules (a business decision)'],
    },
    'stock-trading': {
      because: 'No trading model of any kind exists, and market-price feeds are explicitly out of scope for this backend.',
      needed: ['order/position model', 'GET /stock-trading/…', 'market data source (explicitly out of scope)'],
    },
    'crypto-trading': {
      because: 'No trading model of any kind exists, and market-price feeds are explicitly out of scope for this backend.',
      needed: ['order/position model', 'GET /crypto-trading/…', 'market data source (explicitly out of scope)'],
    },
    accounts: {
      because: 'No account-type or platform-account model exists beyond the single `users` table.',
      needed: ['account types model', 'GET /accounts'],
    },
    tasks: {
      because: 'No task model exists in the backend.',
      needed: ['tasks table', 'GET/POST /tasks'],
    },
    leads: {
      because: 'No lead model exists in the backend.',
      needed: ['leads table', 'GET/POST /leads'],
    },
  };

  function viewNotAvailable(id) {
    const section = SECTIONS.find((s) => s.id === id);
    const na = NA[id] ?? { because: 'This section has no backing endpoint in the backend.', needed: [] };
    clear(main);
    main.appendChild(heading(section?.label ?? 'Section'));
    main.appendChild(el('section', { class: 'panel' },
      UI.stateNotAvailable(section?.label ?? id, na.because, na.needed)));
  }

  // ==============================================================================
  // ROUTER + SHELL
  // ==============================================================================
  const views = {
    dashboard: viewDashboard,
    users: viewUsers,
    withdrawals: viewWithdrawals,
    kyc: viewKyc,
    administrators: viewAdministrators,
    settings: viewSettings,
    'audit-log': viewAudit,
    about: viewAbout,
  };

  function currentId() {
    const id = (location.hash || '#/dashboard').replace(/^#\//, '') || 'dashboard';
    return SECTIONS.some((s) => s.id === id) ? id : 'dashboard';
  }

  function route() {
    const id = currentId();
    const section = SECTIONS.find((s) => s.id === id);
    document.title = `${section?.label ?? 'Admin'} — ScalpSphere Admin`;
    crumb.textContent = '';
    crumb.appendChild(document.createTextNode('Admin / '));
    crumb.appendChild(el('strong', { text: section?.label ?? '' }));

    // aria-current on the active nav item
    sidebar.querySelectorAll('.navitem').forEach((b) => {
      const active = b.dataset.view === id;
      b.classList.toggle('is-active', active);
      if (active) b.setAttribute('aria-current', 'page');
      else b.removeAttribute('aria-current');
    });

    // Close the drawer automatically only on phone widths. On a narrow laptop
    // window it stays open across navigations, so the ☰ is touched once per
    // session instead of once per section change.
    if (window.innerWidth < 620) closeSidebar();

    if (views[id]) return withState(views[id]);
    return viewNotAvailable(id);
  }

  function closeSidebar() {
    sidebar.classList.remove('is-open');
    // MUST be remove(), not add(): `.backdrop.is-on { display:block }` is an
    // author rule, so it overrides the `hidden` attribute — adding the class
    // here left an invisible-but-click-blocking overlay over the whole page
    // after the first navigation. Found by the user, not by the HTTP sweep.
    backdrop.classList.remove('is-on');
    backdrop.hidden = true;
    document.getElementById('menu').setAttribute('aria-expanded', 'false');
  }

  function buildNav() {
    clear(sidebar);
    // Explicit close control for the mobile drawer. Without it, a drawer that
    // now persists across navigations would trap a phone user.
    sidebar.appendChild(el('button', {
      class: 'sidebar__close', type: 'button', 'aria-label': 'Close navigation',
      onclick: () => closeSidebar(),
    }, '✕'));
    let lastGroup = null;
    for (const s of SECTIONS) {
      if (s.ownerOnly && !isOwner()) continue;
      if (s.group !== lastGroup) {
        sidebar.appendChild(el('div', { class: 'sidebar__caption', text: s.group }));
        lastGroup = s.group;
      }
      sidebar.appendChild(el('button', {
        class: `navitem${s.extra ? ' is-extra' : ''}`,
        type: 'button',
        dataset: { view: s.id },
        onclick: () => { location.hash = `#/${s.id}`; },
      },
        el('span', { class: 'ico', 'aria-hidden': 'true' }, s.icon),
        el('span', { text: s.label }),
        s.extra ? el('span', { class: 'tag', text: 'API' }) : null));
    }
  }

  function buildTopbar() {
    document.getElementById('role').hidden = false;
    document.getElementById('role').textContent = session.role;
    const av = document.getElementById('avatar');
    av.textContent = initials(session.full_name);
    av.title = `${session.full_name} (${session.role})`;

    SS.health()
      .then((h) => {
        const elh = document.getElementById('health');
        elh.hidden = false;
        document.getElementById('health-text').textContent =
          h.status === 'ok' ? 'System online' : 'System degraded';
        if (h.status !== 'ok') elh.classList.add('is-bad');
      })
      .catch(() => {
        const elh = document.getElementById('health');
        elh.hidden = false;
        elh.classList.add('is-bad');
        document.getElementById('health-text').textContent = 'API unreachable';
      });
  }

  // ---- boot -----------------------------------------------------------------------
  async function boot() {
    try {
      session = await SS.me();
    } catch {
      // api.js already redirects to login.html on a dead session.
      return;
    }

    buildNav();
    buildTopbar();

    const menuBtn = document.getElementById('menu');
    menuBtn.addEventListener('click', () => {
      const open = sidebar.classList.toggle('is-open');
      backdrop.hidden = !open;
      backdrop.classList.toggle('is-on', open);
      menuBtn.setAttribute('aria-expanded', String(open));
    });
    backdrop.addEventListener('click', () => closeSidebar());
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && sidebar.classList.contains('is-open')) closeSidebar();
    });

    document.getElementById('logout').addEventListener('click', async () => {
      try { await SS.logout(); } catch { /* session is going away regardless */ }
      location.href = 'login.html';
    });

    window.addEventListener('hashchange', route);
    if (!location.hash) location.hash = '#/dashboard';
    route();
  }

  boot();
})();
