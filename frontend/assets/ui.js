/**
 * UI toolkit: safe DOM builder, shared states, tables, pagination, dialogs,
 * toasts. No data is ever interpolated as HTML — everything goes through
 * createElement/textContent, so untrusted strings cannot inject markup.
 */
(() => {
  const SVG_NS = 'http://www.w3.org/2000/svg';

  /** el('button', {class:'btn', onclick: fn}, 'Save') — safe by construction. */
  function el(tag, attrs = {}, ...children) {
    const node = tag === 'svg' || tag === 'path' || tag === 'polyline' || tag === 'g'
      || tag === 'text' || tag === 'rect' || tag === 'line'
      ? document.createElementNS(SVG_NS, tag)
      : document.createElement(tag);

    for (const [k, v] of Object.entries(attrs)) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') node.setAttribute('class', v);
      else if (k === 'text') node.textContent = v;
      else if (k === 'dataset') Object.assign(node.dataset, v);
      else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
      else if (k === 'value') node.value = v;
      else if (k === 'checked' || k === 'disabled' || k === 'selected' || k === 'hidden') {
        if (v === true) node.setAttribute(k, '');
        node[k] = Boolean(v);
      } else if (v === true) node.setAttribute(k, '');
      else node.setAttribute(k, String(v));
    }
    for (const child of children.flat()) {
      if (child === null || child === undefined || child === false) continue;
      node.appendChild(typeof child === 'string' || typeof child === 'number'
        ? document.createTextNode(String(child))
        : child);
    }
    return node;
  }

  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
    return node;
  }

  // ---- formatting -----------------------------------------------------------
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function fmtDate(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '—';
    const p = (n) => String(n).padStart(2, '0');
    return `${MONTHS[d.getMonth()]} ${p(d.getDate())}, ${d.getFullYear()}`;
  }
  function fmtDateTime(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '—';
    const p = (n) => String(n).padStart(2, '0');
    return `${MONTHS[d.getMonth()]} ${p(d.getDate())}, ${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }
  function fmtUptime(seconds) {
    if (typeof seconds !== 'number') return '—';
    const d = Math.floor(seconds / 86400);
    const h = Math.floor((seconds % 86400) / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    if (d > 0) return `${d}d ${h}h`;
    if (h > 0) return `${h}h ${m}m`;
    return `${m}m`;
  }

  /** Status pill with a colour class derived from the value, never from markup. */
  function pill(status) {
    const value = String(status ?? '');
    const good = ['active', 'verified', 'processed', 'enabled', 'ok', 'succeeded', 'completed'];
    const warn = ['pending', 'review', 'locked'];
    const bad = ['inactive', 'rejected', 'failed', 'disabled', 'cancelled', 'unavailable', 'error'];
    const cls = good.includes(value.toLowerCase()) ? 'is-good'
      : warn.includes(value.toLowerCase()) ? 'is-warn'
      : bad.includes(value.toLowerCase()) ? 'is-bad'
      : 'is-neutral';
    return el('span', { class: `pill ${cls}`, text: value || '—' });
  }

  function initials(name) {
    return String(name ?? '?')
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((w) => w[0].toUpperCase())
      .join('') || '?';
  }

  // ---- toasts ---------------------------------------------------------------
  let toastRegion;
  function toast(message, kind = 'success') {
    if (!toastRegion) {
      toastRegion = el('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' });
      document.body.appendChild(toastRegion);
    }
    const item = el('div', { class: `toast toast--${kind}` },
      el('span', { class: 'toast__dot' }),
      el('span', { class: 'toast__msg', text: message }));
    toastRegion.appendChild(item);
    setTimeout(() => {
      item.classList.add('toast--out');
      setTimeout(() => item.remove(), 300);
    }, 4200);
  }

  // ---- dialogs (confirm + custom) -------------------------------------------
  const dialogStack = [];
  function openDialog({ title, body, confirmLabel, cancelLabel = 'Cancel', danger, onConfirm }) {
    const previouslyFocused = document.activeElement;
    const backdrop = el('div', { class: 'dlg-backdrop' });
    let confirmBtn;

    function close() {
      backdrop.remove();
      document.removeEventListener('keydown', onKey);
      const i = dialogStack.indexOf(close);
      if (i >= 0) dialogStack.splice(i, 1);
      if (previouslyFocused && previouslyFocused.focus) previouslyFocused.focus();
    }
    function onKey(e) {
      if (e.key === 'Escape') { e.preventDefault(); close(); }
      if (e.key === 'Tab') {
        // Minimal focus containment inside the dialog.
        const focusables = dlg.querySelectorAll('button, input, select, textarea, [tabindex]:not([tabindex="-1"])');
        if (focusables.length === 0) return;
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    }

    const dlg = el('div', {
      class: 'dlg', role: 'dialog', 'aria-modal': 'true', 'aria-label': title,
    },
      el('h2', { class: 'dlg__title', text: title }),
      body,
      el('div', { class: 'dlg__actions' },
        cancelLabel ? el('button', {
          class: 'btn', type: 'button',
          onclick: close,
        }, cancelLabel) : null,
        confirmLabel ? (confirmBtn = el('button', {
          class: `btn ${danger ? 'btn--danger' : 'btn--primary'}`, type: 'button',
          onclick: async () => {
            if (!onConfirm) return close();
            confirmBtn.disabled = true;
            confirmBtn.textContent = 'Working…';
            try {
              await onConfirm();
              close();
            } catch (err) {
              confirmBtn.disabled = false;
              confirmBtn.textContent = confirmLabel;
              toast(SS.describe(err), 'error');
            }
          },
        }, confirmLabel)) : null,
      ),
    );

    backdrop.appendChild(dlg);
    backdrop.addEventListener('mousedown', (e) => { if (e.target === backdrop) close(); });
    document.addEventListener('keydown', onKey);
    document.body.appendChild(backdrop);
    dialogStack.push(close);

    const firstInput = dlg.querySelector('input, select, textarea');
    (firstInput ?? confirmBtn ?? dlg).focus();
    return { close };
  }

  function confirmAction({ title, message, confirmLabel = 'Confirm', danger = true }) {
    return new Promise((resolve) => {
      openDialog({
        title,
        body: el('p', { class: 'dlg__msg', text: message }),
        confirmLabel,
        danger,
        onConfirm: async () => resolve(true),
      });
      // Resolve false when the dialog is dismissed any other way.
    }).then((v) => v, () => false);
  }

  // ---- shared page states ----------------------------------------------------
  function stateLoading(label = 'Loading…') {
    return el('div', { class: 'state state--loading', role: 'status' },
      el('span', { class: 'spinner', 'aria-hidden': 'true' }),
      el('span', { text: label }));
  }

  function stateEmpty(title, hint) {
    return el('div', { class: 'state state--empty' },
      el('div', { class: 'state__icon', 'aria-hidden': 'true' }, '◌'),
      el('h3', { text: title }),
      hint ? el('p', { class: 'state__hint', text: hint }) : null);
  }

  function stateError(error, onRetry) {
    return el('div', { class: 'state state--error', role: 'alert' },
      el('div', { class: 'state__icon state__icon--error', 'aria-hidden': 'true' }, '!'),
      el('h3', { text: 'Something went wrong' }),
      el('p', { class: 'state__hint', text: SS.describe(error) }),
      onRetry ? el('button', { class: 'btn', onclick: onRetry }, 'Try again') : null);
  }

  function stateDenied(error) {
    return el('div', { class: 'state state--denied' },
      el('div', { class: 'state__icon state__icon--denied', 'aria-hidden': 'true' }, '⊘'),
      el('h3', { text: 'Permission denied' }),
      el('p', { class: 'state__hint', text: SS.describe(error) }),
      el('p', { class: 'state__hint state__hint--muted', text: 'Your role does not permit this view or action. The backend refused the request; nothing was changed.' }));
  }

  /** The honest "this section has no backend" state. */
  function stateNotAvailable(section, because, needed) {
    return el('div', { class: 'state state--na' },
      el('div', { class: 'state__icon state__icon--na', 'aria-hidden': 'true' }, '◌'),
      el('h3', { text: 'Not available in this backend' }),
      el('p', { class: 'state__hint', text: because }),
      needed && needed.length
        ? el('div', { class: 'na-gaps' },
          el('p', { class: 'na-gaps__label', text: 'Would require backend endpoints for:' }),
          el('ul', { class: 'na-gaps__list' },
            needed.map((n) => el('li', { text: n }))))
        : null,
      el('p', { class: 'state__hint state__hint--muted', text: 'No sample data is shown for this section, because none exists.' }));
  }

  // ---- table + pagination ------------------------------------------------------
  /**
   * buildTable({columns:[{key,label,sortable,align,render}], rows, onSort,
   * sort, direction, caption, empty})
   */
  function buildTable(opts) {
    const thead = el('thead');
    const headRow = el('tr');
    for (const col of opts.columns) {
      const th = el('th', { scope: 'col' });
      if (col.align === 'right') th.classList.add('u-right');
      if (col.sortable) {
        const active = opts.sort === col.key;
        th.setAttribute('aria-sort', active
          ? (opts.direction === 'asc' ? 'ascending' : 'descending')
          : 'none');
        const btn = el('button', {
          class: 'th-sort',
          type: 'button',
          onclick: () => opts.onSort(col.key),
          'aria-label': `Sort by ${col.label}`,
        },
          el('span', { text: col.label }),
          el('span', { class: 'th-sort__arrow', 'aria-hidden': 'true' },
            active ? (opts.direction === 'asc' ? '▲' : '▼') : '↕'));
        th.appendChild(btn);
      } else {
        th.appendChild(el('span', { text: col.label }));
      }
      headRow.appendChild(th);
    }
    thead.appendChild(headRow);

    const tbody = el('tbody');
    if (opts.rows.length === 0) {
      const td = el('td', { colspan: String(opts.columns.length) });
      td.appendChild(stateEmpty(opts.empty ?? 'No records found.', opts.emptyHint));
      tbody.appendChild(el('tr', { class: 'u-nohover' }, td));
    } else {
      for (const row of opts.rows) {
        const tr = el('tr');
        for (const col of opts.columns) {
          const td = el('td');
          if (col.align === 'right') td.classList.add('u-right');
          const rendered = col.render ? col.render(row) : row[col.key];
          td.appendChild(typeof rendered === 'object' && rendered !== null ? rendered
            : document.createTextNode(rendered ?? '—'));
          tr.appendChild(td);
        }
        tbody.appendChild(tr);
      }
    }

    const table = el('table', { class: 'table' }, opts.caption
      ? el('caption', { class: 'u-vh', text: opts.caption })
      : null, thead, tbody);
    return el('div', { class: 'table-wrap' }, table);
  }

  /** Renders the pagination footer from the backend's meta.pagination object. */
  function buildPagination(pageInfo, { onPage, perPage, onPerPage } = {}) {
    const { page, per_page, total, total_pages, has_next, has_prev } = pageInfo;
    const from = total === 0 ? 0 : (page - 1) * per_page + 1;
    const to = Math.min(page * per_page, total);

    const pageButtons = [];
    const windowStart = Math.max(1, Math.min(page - 2, total_pages - 4));
    const windowEnd = Math.min(total_pages, windowStart + 4);
    for (let p = windowStart; p <= windowEnd; p += 1) {
      pageButtons.push(el('button', {
        class: `pager__num${p === page ? ' is-active' : ''}`,
        type: 'button',
        'aria-current': p === page ? 'page' : null,
        'aria-label': `Page ${p}`,
        onclick: () => onPage(p),
      }, String(p)));
    }

    return el('div', { class: 'pager' },
      el('div', { class: 'pager__info', role: 'status' },
        `Showing ${from} to ${to} of ${total} entries`),
      el('div', { class: 'pager__controls' },
        onPerPage ? (() => {
          const sel = el('select', {
            class: 'pager__size', 'aria-label': 'Rows per page',
            onchange: (e) => onPerPage(Number(e.target.value)),
          },
            [10, 20, 50, 100].map((n) => el('option', {
              value: String(n), selected: n === per_page, text: `${n} / page`,
            })));
          return sel;
        })() : null,
        el('button', {
          class: 'btn btn--sm', type: 'button', disabled: !has_prev,
          'aria-label': 'Previous page',
          onclick: () => onPage(page - 1),
        }, '‹ Prev'),
        ...pageButtons,
        el('button', {
          class: 'btn btn--sm', type: 'button', disabled: !has_next,
          'aria-label': 'Next page',
          onclick: () => onPage(page + 1),
        }, 'Next ›')));
  }

  /** A text filter box that debounces and notifies. */
  function searchBox({ value = '', placeholder = 'Search…', onSearch }) {
    let timer;
    const input = el('input', {
      class: 'input input--search', type: 'search',
      placeholder, 'aria-label': placeholder, value,
      oninput: () => {
        clearTimeout(timer);
        timer = setTimeout(() => onSearch(input.value.trim()), 350);
      },
    });
    return input;
  }

  function select({ label, value, options, onChange, className = 'input' }) {
    const sel = el('select', { class: className, 'aria-label': label, onchange: (e) => onChange(e.target.value) },
      options.map((o) => el('option', {
        value: String(o.value), selected: o.value === value, text: o.label,
      })));
    return sel;
  }

  window.UI = {
    el, clear, fmtDate, fmtDateTime, fmtUptime, pill, initials,
    toast, openDialog, confirmAction,
    stateLoading, stateEmpty, stateError, stateDenied, stateNotAvailable,
    buildTable, buildPagination, searchBox, select,
  };
})();
