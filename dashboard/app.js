// Token Radar dashboard. It reads the board from window.RADAR_DATA (written
// by main.ts beside this page) and renders it: sortable, filterable, with a
// detail view per protocol. It makes no network request.
// Deep links: ?protocol=<slug> opens a detail view, ?category=<name> and
// ?chain=<name> filter, ?q=<text> searches, ?sort=<key> sorts.

(function () {
  'use strict';

  const data = window.RADAR_DATA;
  if (!data || !Array.isArray(data.rows)) {
    document.getElementById('rows').innerHTML =
      '<tr><td colspan="8">Board data did not load: data.js must sit beside the dashboard folder.</td></tr>';
    return;
  }
  const rows = data.rows;
  const meta = data.meta;

  const $ = (id) => document.getElementById(id);
  const els = {
    stats: $('stats'), q: $('q'), category: $('category'), chain: $('chain'),
    watchlistOnly: $('watchlistOnly'), sort: $('sort'), count: $('count'),
    tbody: $('rows'), empty: $('empty'), detail: $('detail'), compRows: $('compRows'),
    board: $('board'),
  };

  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  function money(n) {
    if (n >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (n >= 1e6) return '$' + (n / 1e6).toFixed(2) + 'M';
    if (n >= 1e3) return '$' + (n / 1e3).toFixed(1) + 'K';
    return '$' + Math.round(n);
  }

  function growthText(g) {
    if (g === null || g === undefined) return '<span>—</span>';
    const cls = g >= 0 ? 'up' : 'down';
    const sign = g >= 0 ? '+' : '';
    return '<span class="' + cls + '">' + sign + g.toFixed(1) + '%</span>';
  }

  function ageText(days) {
    if (days === null || days === undefined) return '—';
    if (days >= 365) {
      const y = Math.floor(days / 365);
      const m = Math.floor((days % 365) / 30);
      return m > 0 ? y + 'y ' + m + 'm' : y + 'y';
    }
    if (days >= 30) return Math.floor(days / 30) + 'm';
    return days + 'd';
  }

  function chainList(chains) {
    if (!chains || chains.length === 0) return '—';
    return chains.length <= 3 ? chains.join(', ') : chains.slice(0, 3).join(', ') + ' +' + (chains.length - 3);
  }

  // ---- state, from the URL so a link opens the same view ----
  const params = new URLSearchParams(window.location.search);
  const state = {
    q: params.get('q') || '',
    category: params.get('category') || '',
    chain: params.get('chain') || '',
    watchlistOnly: params.get('watchlist') === '1',
    sort: params.get('sort') || 'implied',
    dir: params.get('sort') === 'name' || params.get('sort') === 'category' ? 1 : -1,
    selected: params.get('protocol') || null,
  };

  function syncUrl() {
    try {
      const p = new URLSearchParams();
      if (state.q) p.set('q', state.q);
      if (state.category) p.set('category', state.category);
      if (state.chain) p.set('chain', state.chain);
      if (state.watchlistOnly) p.set('watchlist', '1');
      if (state.sort !== 'implied') p.set('sort', state.sort);
      if (state.selected) p.set('protocol', state.selected);
      const qs = p.toString();
      window.history.replaceState(null, '', qs ? '?' + qs : window.location.pathname);
    } catch (e) { /* file:// or a browser that refuses: the page still works */ }
  }

  // ---- one-time renders: stats, filter options, category multiples ----
  function renderStats() {
    els.stats.innerHTML =
      'Snapshot <b>' + esc(meta.as_of) + '</b>' +
      '<span><b>' + meta.protocol_count + '</b> protocols scanned</span>' +
      '<span><b>' + meta.board_rows + '</b> with no token, ranked</span>' +
      '<span class="up"><b>' + meta.watchlist_count + '/' + meta.watchlist_count + '</b> watchlist covered</span>' +
      '<span>Total implied <b>' + money(meta.total_implied_usd) + '</b></span>' +
      '<span>Global multiple <b>' + meta.global_multiple.toFixed(3) + '&times;</b></span>';
  }

  function fillOptions() {
    const cats = [...new Set(rows.map((r) => r.category).filter(Boolean))].sort();
    const chains = [...new Set(rows.flatMap((r) => r.chains))].sort();
    for (const c of cats) {
      const o = document.createElement('option');
      o.value = c; o.textContent = c;
      els.category.appendChild(o);
    }
    for (const c of chains) {
      const o = document.createElement('option');
      o.value = c; o.textContent = c;
      els.chain.appendChild(o);
    }
    els.q.value = state.q;
    els.category.value = state.category;
    els.chain.value = state.chain;
    els.watchlistOnly.checked = state.watchlistOnly;
    els.sort.value = state.sort;
  }

  function renderComps() {
    els.compRows.innerHTML = data.categories.map((c) =>
      '<tr><td>' + esc(c.name) + '</td><td class="num">' + c.rows + '</td><td class="num">' +
      c.multiple.toFixed(3) + '&times;</td></tr>',
    ).join('');
  }

  // ---- filtering and sorting ----
  const SORTS = {
    rank: (r) => r.rank,
    name: (r) => r.name.toLowerCase(),
    category: (r) => (r.category || '').toLowerCase(),
    chains: (r) => r.chains.length,
    tvl: (r) => r.tvl_usd,
    growth: (r) => (r.change_7d === null ? -Infinity : r.change_7d),
    age: (r) => (r.age_days === null ? -Infinity : r.age_days),
    implied: (r) => r.implied_value_usd,
  };

  function filtered() {
    const q = state.q.trim().toLowerCase();
    const list = rows.filter((r) => {
      if (q && !r.name.toLowerCase().includes(q) && !r.slug.toLowerCase().includes(q)) return false;
      if (state.category && r.category !== state.category) return false;
      if (state.chain && !r.chains.includes(state.chain)) return false;
      if (state.watchlistOnly && !r.on_watchlist) return false;
      return true;
    });
    const key = SORTS[state.sort] || SORTS.implied;
    const dir = state.dir;
    list.sort((a, b) => {
      const x = key(a), y = key(b);
      if (x < y) return -dir;
      if (x > y) return dir;
      return a.rank - b.rank;
    });
    return list;
  }

  function renderTable() {
    const list = filtered();
    els.count.textContent = list.length + ' of ' + rows.length + ' protocols';
    els.empty.classList.toggle('hidden', list.length > 0);
    els.tbody.innerHTML = list.map((r) => {
      const badge = r.on_watchlist ? '<span class="watch">WATCHLIST</span>' : '';
      return '<tr data-slug="' + esc(r.slug) + '"' + (r.slug === state.selected ? ' class="selected"' : '') + '>' +
        '<td class="rank">' + r.rank + '</td>' +
        '<td class="name"><b>' + esc(r.name) + '</b>' + badge + '<span class="slug">' + esc(r.slug) + '</span></td>' +
        '<td class="cat">' + esc(r.category || '—') + '</td>' +
        '<td class="chains">' + esc(chainList(r.chains)) + '</td>' +
        '<td class="num">' + money(r.tvl_usd) + '</td>' +
        '<td class="num">' + growthText(r.change_7d) + '</td>' +
        '<td class="num">' + ageText(r.age_days) + '</td>' +
        '<td class="num"><b>' + money(r.implied_value_usd) + '</b></td>' +
        '</tr>';
    }).join('');
    document.querySelectorAll('#board thead th').forEach((th) => {
      // The rank column follows the implied-value order, so it shares the
      // highlight only when the sort is by rank itself.
      th.classList.toggle('sorted', th.dataset.sort === state.sort);
    });
  }

  // ---- detail view ----
  function renderDetail() {
    const r = rows.find((x) => x.slug === state.selected);
    if (!r) {
      els.detail.classList.add('hidden');
      els.detail.innerHTML = '';
      return;
    }
    const badge = r.on_watchlist ? '<span class="watch">WATCHLIST</span>' : '';
    const steps = r.farm_steps.map((s) => '<li>' + esc(s) + '</li>').join('');
    els.detail.innerHTML =
      '<div class="head"><h2>#' + r.rank + ' ' + esc(r.name) + '</h2>' + badge +
      '<span class="slug">' + esc(r.slug) + '</span>' +
      '<button class="close" id="closeDetail" type="button">Close</button></div>' +
      '<div class="big">' + money(r.implied_value_usd) + '</div>' +
      '<p class="big-label">implied launch value — TVL &times; multiple &times; growth &times; age &times; chains</p>' +
      '<div class="factors">' +
      '<div class="factor"><div class="k">TVL</div><div class="v">' + money(r.tvl_usd) + '</div></div>' +
      '<div class="factor"><div class="k">Multiple (' + esc(r.category || 'global') + ')</div><div class="v">' + r.multiple.toFixed(3) + '&times;</div></div>' +
      '<div class="factor"><div class="k">Growth factor</div><div class="v">' + r.growth_factor.toFixed(3) + '&times;</div></div>' +
      '<div class="factor"><div class="k">Age factor</div><div class="v">' + r.age_factor.toFixed(3) + '&times;</div></div>' +
      '<div class="factor"><div class="k">Chain factor</div><div class="v">' + r.chain_factor.toFixed(3) + '&times;</div></div>' +
      '</div>' +
      '<div class="meta"><span>Category <b>' + esc(r.category || '—') + '</b></span>' +
      '<span>7-day TVL <b>' + (r.change_7d === null ? '—' : (r.change_7d >= 0 ? '+' : '') + r.change_7d.toFixed(1) + '%') + '</b></span>' +
      '<span>No token for <b>' + ageText(r.age_days) + '</b></span>' +
      '<span>Chains <b>' + r.chains.length + '</b></span></div>' +
      '<h3>Farm plan</h3><ol class="farm">' + steps + '</ol>' +
      '<p class="chain-list">Chains: ' + esc(r.chains.join(', ') || '—') + '</p>';
    els.detail.classList.remove('hidden');
    $('closeDetail').addEventListener('click', () => {
      state.selected = null;
      syncUrl();
      renderDetail();
      renderTable();
    });
  }

  // ---- events ----
  els.q.addEventListener('input', () => { state.q = els.q.value; syncUrl(); renderTable(); });
  els.category.addEventListener('change', () => { state.category = els.category.value; syncUrl(); renderTable(); });
  els.chain.addEventListener('change', () => { state.chain = els.chain.value; syncUrl(); renderTable(); });
  els.watchlistOnly.addEventListener('change', () => { state.watchlistOnly = els.watchlistOnly.checked; syncUrl(); renderTable(); });
  els.sort.addEventListener('change', () => {
    state.sort = els.sort.value;
    state.dir = state.sort === 'name' || state.sort === 'category' ? 1 : -1;
    syncUrl(); renderTable();
  });
  els.board.querySelectorAll('thead th').forEach((th) => {
    th.addEventListener('click', () => {
      const key = th.dataset.sort;
      if (!key) return;
      if (state.sort === key || (key === 'rank' && state.sort === 'implied')) {
        state.dir = -state.dir;
      } else {
        state.sort = key === 'rank' ? 'implied' : key;
        state.dir = state.sort === 'name' || state.sort === 'category' ? 1 : -1;
      }
      els.sort.value = state.sort;
      syncUrl(); renderTable();
    });
  });
  els.tbody.addEventListener('click', (e) => {
    const tr = e.target.closest('tr[data-slug]');
    if (!tr) return;
    state.selected = tr.dataset.slug;
    syncUrl();
    renderDetail();
    renderTable();
    els.detail.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });

  renderStats();
  fillOptions();
  renderComps();
  renderTable();
  renderDetail();
})();
