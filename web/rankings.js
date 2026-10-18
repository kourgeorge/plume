// Rankings: tracked searches, their Google position per week, and (optionally) who outranks you.
// Uses $, esc, api, post, when and showView from app.js (loaded first). Builds its own view section.
(() => {
  const section = document.createElement('section');
  section.id = 'view-rankings';
  section.className = 'view';
  section.hidden = true;
  section.innerHTML = `
    <div class="view-head">
      <a href="#today" class="back">← Today</a>
      <h1>Rankings</h1>
      <span class="actions">
        <select id="rk-weeks" title="How far back"><option value="12">12 weeks</option><option value="26">26 weeks</option><option value="52">1 year</option></select>
      </span>
    </div>
    <p class="muted">Where your site shows up in Google for the searches you care about, week by week. Positions come from Search Console (free); lower is better, 1–10 is page one.</p>
    <p id="rk-nodata" class="warn" hidden>No Search Console data yet. Connect Google for this website under <a href="#settings">Settings</a>, pick its Search Console site there, then get the data. History builds up from there.</p>
    <form id="rk-form" class="rk-form">
      <input id="rk-input" placeholder="Add a search to track, e.g. driving theory test online" dir="auto" autocomplete="off">
      <button type="submit">Track</button>
      <span id="rk-msg" class="small"></span>
    </form>
    <div id="rk-suggest-box" hidden>
      <div class="small muted">Worth tracking, from your Search Console data:</div>
      <div id="rk-suggest" class="chat-suggest"></div>
    </div>
    <div class="table-wrap"><table class="rk-table">
      <thead><tr><th>Search</th><th>Position</th><th>Change</th><th>Trend</th><th>Clicks</th><th>Your page</th><th>Ahead of you</th><th></th></tr></thead>
      <tbody id="rk-rows"></tbody>
    </table></div>
    <div id="rk-serp" class="card rk-serp" hidden></div>
    <details class="instructions" id="rk-dfs">
      <summary>Who outranks you — optional <span id="rk-dfs-tag" class="muted small"></span></summary>
      <p class="muted small">Google doesn't share the full results list, so this uses a <a href="https://dataforseo.com" target="_blank" rel="noopener">DataForSEO</a> account you pay for (about $0.002 per search, checked weekly on Mondays — 30 tracked searches cost about $0.25 a month). The login is shared by all your websites and stored only on this computer.</p>
      <div class="form">
        <label>Login (account email) <input id="rk-dfs-login" autocomplete="off"></label>
        <label>API password <input id="rk-dfs-pass" type="password" autocomplete="off"></label>
        <label>Country for this website <input id="rk-dfs-loc" placeholder="Israel"></label>
      </div>
      <div class="editor-bar"><span id="rk-dfs-msg" class="small"></span><span><button id="rk-dfs-off" class="secondary" hidden>Disconnect</button> <button id="rk-dfs-save" class="secondary">Save</button></span></div>
    </details>`;
  $('col-center').appendChild(section);

  let weeks = 12;
  let data = null;

  /** A small line of weekly positions. Higher on the chart = better (closer to position 1). */
  function sparkline(history) {
    const pts = history.map((h) => h.position);
    const vals = pts.filter((p) => p !== null);
    if (vals.length < 2) return '<span class="muted small">—</span>';
    const w = 110, h = 28, worst = Math.max(...vals), best = Math.min(...vals);
    const span = Math.max(worst - best, 1);
    const x = (i) => (i / (pts.length - 1)) * (w - 4) + 2;
    const y = (p) => ((p - best) / span) * (h - 6) + 3;
    let path = '';
    pts.forEach((p, i) => {
      if (p === null) return;
      path += `${path && pts[i - 1] !== null ? 'L' : 'M'}${x(i).toFixed(1)},${y(p).toFixed(1)} `;
    });
    const last = pts.length - 1 - [...pts].reverse().findIndex((p) => p !== null);
    return `<svg class="spark" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" role="img" aria-label="Position over ${pts.length} weeks, from ${vals[0]} to ${vals[vals.length - 1]}">
      <path d="${path}" fill="none" stroke="currentColor" stroke-width="1.6"/><circle cx="${x(last)}" cy="${y(pts[last])}" r="2.4" fill="currentColor"/></svg>`;
  }

  function changeCell(c) {
    if (c === null || c === 0) return '<span class="muted">—</span>';
    return c > 0 ? `<span class="good">▲ ${c}</span>` : `<span class="bad">▼ ${-c}</span>`;
  }

  function band(p) {
    return p === null ? 'muted' : p <= 3 ? 'good' : p <= 10 ? 'mid' : 'muted';
  }

  async function load() {
    showView('rankings');
    $('rk-weeks').value = String(weeks);
    data = await api(`/api/rankings?weeks=${weeks}`);
    $('rk-nodata').hidden = data.hasData;
    $('rk-suggest-box').hidden = !data.suggestions.length;
    $('rk-suggest').innerHTML = data.suggestions
      .map((s) => `<button type="button" class="chip-btn" data-track="${esc(s.keyword)}" title="${esc(s.why)}" dir="auto">+ ${esc(s.keyword)}</button>`)
      .join('') + (data.suggestions.length > 1 ? '<button type="button" class="chip-btn" id="rk-track-all">Track all</button>' : '');
    $('rk-rows').innerHTML = data.rows.length
      ? data.rows
          .map((r) => {
            const c = r.current;
            const page = c?.topPage ? new URL(c.topPage).pathname : '';
            const ahead = r.serp ? (r.serp.ourPosition === null ? `not in top 20 · ${r.serp.above.slice(0, 2).map(esc).join(', ')}` : r.serp.above.length ? r.serp.above.slice(0, 3).map(esc).join(', ') : 'nobody — you are first') : '';
            return `<tr>
              <td dir="auto"><strong>${esc(r.keyword)}</strong>${r.source === 'suggested' ? ' <small class="muted">suggested</small>' : ''}</td>
              <td class="${band(c?.position ?? null)}"><strong>${c ? c.position : '—'}</strong>${c ? `<small class="muted"> wk of ${esc(c.week.slice(5))}</small>` : '<small class="muted"> not shown yet</small>'}</td>
              <td>${changeCell(r.change)}</td>
              <td class="spark-cell">${sparkline(r.history)}</td>
              <td>${r.clicks}</td>
              <td class="small">${page ? `<a href="${esc(c.topPage)}" target="_blank" rel="noopener" dir="ltr">${esc(page)}</a>` : '—'}</td>
              <td class="small">${ahead ? `<a href="#" data-serp="${esc(r.keyword)}">${ahead}</a>` : data.serp.connected ? `<button class="secondary small-btn" data-check="${esc(r.keyword)}">Check</button>` : '<span class="muted">—</span>'}</td>
              <td><button class="secondary small-btn" data-untrack="${esc(r.keyword)}" title="Stop tracking">×</button></td>
            </tr>`;
          })
          .join('')
      : `<tr><td colspan="8" class="muted">No searches tracked yet. Add one above${data.suggestions.length ? ', or pick a suggestion' : ''}.</td></tr>`;
    $('rk-dfs-tag').textContent = data.serp.connected ? `· on (${data.serp.login})` : '· off';
    $('rk-dfs-login').value = data.serp.login ?? '';
    $('rk-dfs-pass').value = '';
    $('rk-dfs-pass').placeholder = data.serp.connected ? 'saved — leave empty to keep it' : '';
    $('rk-dfs-loc').value = data.serp.location;
    $('rk-dfs-off').hidden = !data.serp.connected;
    wire();
  }

  async function track(keywords, source = 'user') {
    $('rk-msg').textContent = '';
    try {
      const r = await post('/api/rankings', { keywords, source });
      $('rk-msg').className = 'small muted';
      $('rk-msg').textContent = r.added ? `Tracking ${r.added} more.` : 'Already tracked.';
      await load();
    } catch (err) {
      $('rk-msg').className = 'small warn';
      $('rk-msg').textContent = err.message;
    }
  }

  async function showSerp(keyword, fresh) {
    const box = $('rk-serp');
    box.hidden = false;
    box.innerHTML = `<p class="muted">${fresh ? 'Checking Google…' : 'Loading…'}</p>`;
    box.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    try {
      const s = fresh ? { ...(await post('/api/rankings/serp', { keyword })), at: new Date().toISOString(), location: data.serp.location } : (await api(`/api/rankings/serp?keyword=${encodeURIComponent(keyword)}`)).serp;
      if (!s) return (box.innerHTML = '<p class="muted">Not checked yet.</p>');
      const mine = new URL(state.site).hostname.replace(/^www\./, '');
      box.innerHTML = `<div class="view-head small-head"><h2 dir="auto">“${esc(keyword)}” on Google</h2>
          <span class="actions"><button class="secondary small-btn" id="rk-serp-refresh">Check again</button><button class="secondary small-btn" id="rk-serp-close">Close</button></span></div>
        <p class="muted small">${esc(s.location)} · checked ${when(s.at)}${fresh && s.cost ? ` · cost $${Number(s.cost).toFixed(4)}` : ''} · ${s.ourPosition ? `you are #${s.ourPosition}` : 'you are not in the top 20'}</p>
        <ol class="serp-list">${s.results
          .map((x) => `<li value="${x.position}" class="${x.domain.replace(/^www\./, '') === mine || x.domain.endsWith(`.${mine}`) ? 'mine' : ''}"><a href="${esc(x.url)}" target="_blank" rel="noopener" dir="auto">${esc(x.title || x.url)}</a><small dir="ltr">${esc(x.domain)}</small></li>`)
          .join('')}</ol>`;
      $('rk-serp-close').onclick = () => (box.hidden = true);
      $('rk-serp-refresh').onclick = () => showSerp(keyword, true).then(load);
    } catch (err) {
      box.innerHTML = `<p class="warn">${esc(err.message)}</p>`;
    }
  }

  function wire() {
    for (const b of section.querySelectorAll('[data-track]')) b.onclick = () => track([b.dataset.track], 'suggested');
    if ($('rk-track-all')) $('rk-track-all').onclick = () => track(data.suggestions.map((s) => s.keyword), 'suggested');
    for (const b of section.querySelectorAll('[data-untrack]'))
      b.onclick = async () => {
        if (!confirm(`Stop tracking "${b.dataset.untrack}"? Its Google lookups go too; Search Console history stays.`)) return;
        await api(`/api/rankings?keyword=${encodeURIComponent(b.dataset.untrack)}`, { method: 'DELETE' });
        load();
      };
    for (const a of section.querySelectorAll('[data-serp]')) a.onclick = (e) => (e.preventDefault(), showSerp(a.dataset.serp, false));
    for (const b of section.querySelectorAll('[data-check]')) b.onclick = () => showSerp(b.dataset.check, true).then(load);
  }

  $('rk-form').onsubmit = (e) => {
    e.preventDefault();
    const k = $('rk-input').value.trim();
    if (k) track([k]).then(() => ($('rk-input').value = ''));
  };
  $('rk-weeks').onchange = () => ((weeks = Number($('rk-weeks').value)), load());
  $('rk-dfs-save').onclick = async () => {
    try {
      const body = { location: $('rk-dfs-loc').value };
      if ($('rk-dfs-login').value.trim()) Object.assign(body, { login: $('rk-dfs-login').value, password: $('rk-dfs-pass').value });
      await api('/api/serp', { method: 'PUT', body: JSON.stringify(body) });
      $('rk-dfs-msg').className = 'small good';
      $('rk-dfs-msg').textContent = 'Saved.';
      load();
    } catch (err) {
      $('rk-dfs-msg').className = 'small warn';
      $('rk-dfs-msg').textContent = err.message;
    }
  };
  $('rk-dfs-off').onclick = async () => {
    if (!confirm('Disconnect DataForSEO? Weekly "who outranks you" checks stop for all websites. Past results stay.')) return;
    await api('/api/serp', { method: 'DELETE' });
    load();
  };

  window.plumeRankings = { load };
})();
