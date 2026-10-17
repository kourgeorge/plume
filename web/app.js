const $ = (id) => document.getElementById(id);
/** This dashboard's website, from its address: /s/<site>/. Every request says which site it is for. */
const SITE = decodeURIComponent((location.pathname.match(/^\/s\/([^/]+)/) || [])[1] || '');
if (!SITE) location.replace('/');
const withSite = (url) => `${url}${url.includes('?') ? '&' : '?'}site=${encodeURIComponent(SITE)}`;
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const api = async (path, opts = {}) => {
  // Only say "this is JSON" when there is a body: the server rejects an empty body sent with that header,
  // which broke every delete button (DELETE requests carry no body).
  const headers = { 'x-plume-site': SITE, ...(opts.body ? { 'content-type': 'application/json' } : {}), ...(opts.headers || {}) };
  const res = await fetch(path, { ...opts, headers });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || data.message || res.statusText);
  return data;
};
const post = (path, body = {}) => api(path, { method: 'POST', body: JSON.stringify(body) });
const n = (x) => (x == null ? '—' : Number(x).toLocaleString());
const pos = (x) => (x == null || !x ? '—' : Number(x).toFixed(1));
const when = (iso) => (iso ? new Date(iso).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' }) : '—');
const band = (score) => (score >= 90 ? 'good' : score >= 50 ? 'mid' : 'bad');

/** Small per-browser preferences. Storage can be unavailable (private mode); everything works without it. */
const pref = {
  get(k, d) { try { const v = localStorage.getItem(`plume:${k}`); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(`plume:${k}`, JSON.stringify(v)); } catch { /* fine */ } },
};

let state = null;
let context = null;
/** A message to show once on the next view load ("Saved."), so it survives the reload a hash change causes. */
let flash = '';

/** Go to a view, or reload it if we're already there (setting the same hash fires no hashchange). */
async function goTo(hash, message = '') {
  flash = message;
  if (location.hash === hash) await route();
  else location.hash = hash;
}
function takeFlash() {
  const m = flash;
  flash = '';
  return m;
}
let publishers = [];
let folderStatus = 'draft';
let currentDraft = null;
let draftBack = '#today';
let speedDevice = pref.get('speedDevice', 'mobile');
let days = pref.get('days', 30);

// ---------------------------------------------------------------- routing

const VIEWS = ['today', 'job', 'doc', 'competitor', 'person', 'accounts', 'notes', 'llms', 'folder', 'draft', 'check', 'speed', 'results', 'logs', 'usage', 'settings', 'rankings'];

function showView(id) {
  // Views added by later scripts (e.g. rankings.js) may not exist yet on the first call.
  for (const v of VIEWS) if ($(`view-${v}`)) $(`view-${v}`).hidden = v !== id;
  for (const a of document.querySelectorAll('.nav-list a')) a.classList.toggle('active', a.getAttribute('href') === location.hash);
  $('col-center').scrollTop = 0;
}

async function route() {
  state = await api('/api/state');
  $('key-warning').hidden = state.hasApiKey;
  document.title = `${state.siteName} — Plume`;
  // Nothing researched yet: offer to start (unless research is already running).
  if (!state.docs.some((d) => d.written) && $('view-job').hidden) {
    $('workspace').hidden = true;
    $('onboard').hidden = false;
    $('onboard-site').textContent = new URL(state.site).hostname;
    return;
  }
  $('onboard').hidden = true;
  $('workspace').hidden = false;
  renderChrome();
  const [page, arg] = (location.hash.slice(1) || 'today').split(/[/?]/);
  switch (page) {
    case 'doc': return loadDoc(arg);
    case 'competitor': return loadCompetitor(arg);
    case 'person': return loadPerson(arg);
    case 'accounts': return loadAccounts();
    case 'notes': return loadNotes();
    case 'llms': return loadLlms();
    case 'folder': return loadFolder(arg);
    case 'draft': return loadDraft(Number(arg));
    case 'check': return loadAudit();
    case 'speed': return loadSpeed();
    case 'results': return loadResults();
    case 'rankings': return window.plumeRankings ? window.plumeRankings.load() : loadToday();
    case 'logs': return loadLogs();
    case 'usage': return loadUsage();
    case 'settings': return loadSettings();
    default: return loadToday();
  }
}

// ---------------------------------------------------------------- frame: top bar + left + right

async function renderChrome() {
  $('site-name').textContent = `${state.siteName} ▾`;
  const lang = state.language;
  $('lang-line').textContent = lang.code === 'en' ? 'Agents write in English.' : `Agents write in ${lang.name}, the language of your site.`;
  for (const b of $('range').querySelectorAll('button')) b.classList.toggle('on', Number(b.dataset.days) === days);

  $('doc-list').innerHTML =
    state.docs.map((d) => `<li><a href="#doc/${d.id}">${esc(d.title)}<span class="tag">${d.written ? '' : 'not written'}</span></a></li>`).join('') +
    '<li><a href="#notes">Your notes</a></li><li><a href="#llms">llms.txt</a></li>';
  api('/api/context').then((c) => {
    context = c;
    $('comp-list').innerHTML = c.competitors.length
      ? c.competitors.map((x) => `<li><a href="#competitor/${x.id}" dir="auto">${esc(x.name)}<span class="tag">${x.watch ? 'watching<span class="dot"></span>' : ''}</span></a></li>`).join('')
      : '<li class="muted small">None yet. Research fills this in, or add your own.</li>';
    $('people-list').innerHTML = c.people.length
      ? c.people.map((p) => `<li><a href="#person/${p.id}" dir="auto">${esc(p.name)}<span class="tag">${esc(p.role)}</span></a></li>`).join('')
      : '<li class="muted small">Add the founder or whoever posts for the business.</li>';
    $('accounts-tag').textContent = [c.profiles.x && 'X', c.profiles.linkedin && 'LinkedIn'].filter(Boolean).join(' · ') || 'not set';
    for (const a of document.querySelectorAll('.nav-list a')) a.classList.toggle('active', a.getAttribute('href') === location.hash);
  }, () => {});
  for (const a of document.querySelectorAll('.nav-list a')) a.classList.toggle('active', a.getAttribute('href') === location.hash);

  // These don't block the page: each fills in when it arrives.
  api('/api/profile/product').then((d) => ($('summary').textContent = summaryOf(d.body) || 'The business summary appears here once research is done.'), () => {});
  api('/api/google').then((g) => {
    $('google-pill').innerHTML = !g.configured ? '' : g.connected ? '<span title="Search Console and Analytics are connected">Google ✓</span>' : `<a href="${withSite('/api/google/connect')}">Connect Google</a>`;
  }, () => {});
  api('/api/speed').then((s) => {
    const r = s[speedDevice] ?? s.mobile ?? s.desktop;
    $('speed-chips').innerHTML = r
      ? [['performance', 'Speed'], ['accessibility', 'Access'], ['bestPractices', 'Practices'], ['seo', 'SEO']]
          .map(([k, label]) => `<span class="chip"><b class="${band(r.scores[k])}">${r.scores[k]}</b>${label}</span>`)
          .join('')
      : '<span class="chip">Check speed</span>';
  }, () => {});
  api('/api/budget').then((b) => {
    $('cost-link').textContent = b.limit ? `AI $${b.spent.toFixed(2)} / $${b.limit}` : `AI $${b.spent.toFixed(2)}`;
  }, () => {});
  renderQuick();
}

/** First real paragraph of the product document: the one-paragraph business summary. */
function summaryOf(markdown) {
  const para = (markdown || '')
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .find((p) => p && !p.startsWith('#') && !p.startsWith('-') && !p.startsWith('|') && p.length > 60);
  if (!para) return '';
  const plain = para.replace(/[*_`]|\[([^\]]+)\]\([^)]+\)/g, '$1');
  return plain.length > 320 ? `${plain.slice(0, 320).replace(/\s\S*$/, '')}…` : plain;
}

function renderQuick() {
  const actions = [
    ['Write SEO drafts now', () => runAgentNow('seo')],
    ['Write an article now', () => runAgentNow('writer')],
    ['Check my site', async () => ((location.hash = '#check'), await runAudit())],
    ['Check page speed', async () => ((location.hash = '#speed'), await runSpeed())],
    ['Get latest Google data', async () => ((location.hash = '#results'), await pullGoogle())],
    ['Research my site again', () => confirm('Research the whole site again? This replaces all five documents, including your edits.') && runResearch({})],
  ];
  $('quick').innerHTML = actions.map(([label], i) => `<button class="secondary" data-q="${i}">${esc(label)}</button>`).join('');
  for (const b of $('quick').querySelectorAll('button')) b.onclick = () => actions[Number(b.dataset.q)][1]().catch?.((e) => alert(e.message));
}

// ---------------------------------------------------------------- jobs

async function waitForJob(jobId, label) {
  showView('job');
  $('job-title').textContent = label;
  for (;;) {
    const job = await api(`/api/jobs/${jobId}`);
    $('job-progress').textContent = job.progress || '';
    if (job.status === 'done') return;
    if (job.status === 'failed') throw new Error(job.error);
    await new Promise((r) => setTimeout(r, 1500));
  }
}

async function runResearch(body) {
  const { jobId } = await post('/api/research', body);
  try {
    await waitForJob(jobId, 'Researching your site…');
  } catch (err) {
    alert(`Research stopped: ${err.message}`);
  }
  location.hash = '#doc/product';
  route();
}

async function runAgentNow(id) {
  try {
    const { jobId } = await post(`/api/agents/${id}/run`);
    await waitForJob(jobId, 'Agent at work…');
  } catch (err) {
    alert(err.message);
  }
  location.hash = '#today';
  route();
}

// ---------------------------------------------------------------- Today

async function loadToday() {
  showView('today');
  const [t, folders] = await Promise.all([api('/api/today'), api('/api/agents')]);
  const total = t.left + t.doneToday;
  $('today-progress').textContent = total ? `${t.doneToday} of ${total} done` : '';
  renderTodayCard(t.items[0], t.items.length);
  renderFolders(folders);
  publishers = await api('/api/publishers');
}

function renderTodayCard(item, left) {
  const box = $('today-card');
  if (!item) {
    box.innerHTML = `<div class="today empty">Nothing waiting. Agents put new drafts and fixes here as they finish.<br><small>Switch agents on under <a href="#logs">Timetable</a>, or use Quick actions.</small></div>`;
    return;
  }
  const more = left > 1 ? `<span class="muted small">${left - 1} more after this</span>` : '';
  if (item.kind === 'draft') {
    const d = item.draft;
    box.innerHTML = `<div class="today">
      <div class="kicker"><span>${esc(agentLabel(d.agent))}</span><span>·</span><span>${esc(kindLabel(d.kind))}</span><span>·</span><span>${d.words} words</span></div>
      <h2 dir="auto">${esc(d.title)}</h2>
      ${d.meta.reason ? `<p class="why">${esc(d.meta.reason)}</p>` : ''}
      <p class="body" dir="auto">${esc(d.preview)}</p>
      <div class="acts">
        <select id="t-target">${publishers.map((p) => `<option value="${p.id}">${esc(p.label)}${p.configured ? '' : ' (dry run)'}</option>`).join('')}</select>
        <button id="t-approve">Approve</button>
        <a href="#draft/${d.id}"><button class="secondary">Read and edit</button></a>
        <span class="right"><button class="secondary" id="t-skip">Skip for today</button><button class="secondary" id="t-no">Not useful</button></span>
      </div>${more}</div>`;
    const firstLive = publishers.find((p) => p.configured && p.id !== 'export');
    if (firstLive) $('t-target').value = firstLive.id;
    $('t-approve').onclick = act(async () => post(`/api/drafts/${d.id}/approve`, { target: $('t-target').value }));
    $('t-no').onclick = act(async () => {
      const reason = prompt('What was wrong with it? (optional — the agent will learn from this)');
      if (reason === null) return 'cancel';
      await post(`/api/drafts/${d.id}/not-useful`, { reason });
    });
  } else if (item.kind === 'fix') {
    const f = item.fix;
    box.innerHTML = `<div class="today">
      <div class="kicker"><span class="sev ${f.severity}">${esc(f.severity)}</span><span>·</span><span>Site fix · ${esc(f.area)}</span></div>
      <h2>${esc(f.title)}</h2>
      <p class="why">${esc(f.url)}</p>
      <p class="body">${esc(f.why)}</p>
      <ol>${f.steps.map((s) => `<li>${esc(s)}</li>`).join('')}</ol>
      ${f.snippet ? `<pre><code>${esc(f.snippet)}</code></pre>` : ''}
      <div class="acts">
        <button id="t-done">Mark as fixed</button>
        ${f.snippet ? '<button class="secondary" id="t-copy">Copy code</button>' : ''}
        <span class="right"><button class="secondary" id="t-skip">Skip for today</button></span>
      </div>${more}</div>`;
    $('t-done').onclick = act(async () => post('/api/audit/done', { id: f.id }));
    if (f.snippet) $('t-copy').onclick = () => navigator.clipboard.writeText(f.snippet).then(() => ($('t-copy').textContent = 'Copied'));
  } else if (item.kind === 'speed') {
    box.innerHTML = `<div class="today">
      <div class="kicker"><span class="sev critical">Speed</span><span>·</span><span>${item.strategy === 'mobile' ? 'Phones' : 'Computers'} · score ${item.performance}</span></div>
      <h2>${esc(item.headline)}</h2>
      <p class="why">Slow pages rank lower, and visitors leave before they see anything.</p>
      <div class="acts">
        <button id="t-send">Send to SEO agent</button>
        <a href="#speed"><button class="secondary">See details</button></a>
        <span class="right"><button class="secondary" id="t-skip">Skip for today</button></span>
      </div>${more}</div>`;
    $('t-send').onclick = act(async () => post('/api/speed/send', { strategy: item.strategy }));
  }
  else if (item.kind === 'watch') {
    const c = item.change;
    box.innerHTML = `<div class="today">
      <div class="kicker"><span>Competitor watch</span><span>·</span><span>${esc(when(c.at))}</span></div>
      <h2 dir="auto">${esc(c.name)} ${c.changes.length === 1 ? esc(c.changes[0].text) : 'changed their site'}</h2>
      ${changeList(c.changes.length === 1 && !c.changes[0].items ? [] : c.changes)}
      <div class="acts">
        <button id="t-seen">Got it</button>
        ${c.url ? `<a href="${esc(c.url)}" target="_blank" rel="noopener"><button class="secondary">Open their site</button></a>` : ''}
        <a href="#competitor/${c.competitorId}"><button class="secondary">Notes on ${esc(c.name)}</button></a>
        <span class="right"><button class="secondary" id="t-skip">Skip for today</button></span>
      </div>${more}</div>`;
    $('t-seen').onclick = act(async () => post(`/api/changes/${c.id}/seen`));
  }
  else if (item.kind === 'rank') {
    const a = item.alert;
    const down = a.to > a.from;
    box.innerHTML = `<div class="today">
      <div class="kicker"><span class="${down ? 'sev critical' : 'good'}">${down ? 'Ranking drop' : 'Ranking rise'}</span><span>·</span><span>week of ${esc(a.week)}</span></div>
      <h2 dir="auto">“${esc(a.keyword)}” ${down ? 'fell' : 'rose'} from position ${a.from} to ${a.to}</h2>
      <p class="why">${down
        ? 'A drop this size usually means a competitor published something better, or your page changed. Check who is ahead now and whether your page still answers the search.'
        : 'Worth knowing what worked, so you can do more of it.'}</p>
      <div class="acts">
        <button id="t-seen">Got it</button>
        <a href="#rankings"><button class="secondary">See rankings</button></a>
        <span class="right"><button class="secondary" id="t-skip">Skip for today</button></span>
      </div>${more}</div>`;
    $('t-seen').onclick = act(async () => post(`/api/rank-alerts/${a.id}/seen`));
  }
  $('t-skip').onclick = act(async () => post('/api/today/skip', { key: item.key }));
}

function changeList(changes) {
  if (!changes.length) return '';
  return `<ul class="change-list">${changes
    .map((ch) => `<li>${esc(ch.text.replace(/^./, (x) => x.toUpperCase()))}${ch.items ? `: ${ch.items.map((i) => `<code>${esc(i)}</code>`).join(', ')}` : ''}</li>`)
    .join('')}</ul>`;
}

/** Wrap a card action: run it, then show the next card. Returning 'cancel' keeps the card. */
function act(fn) {
  return async (e) => {
    e.target.disabled = true;
    try {
      if ((await fn()) !== 'cancel') await loadToday();
    } catch (err) {
      alert(err.message);
    } finally {
      e.target.disabled = false;
    }
  };
}

const AGENT_GLYPH = { seo: '⌕', writer: '✎', 'site-check': '⚙' };
function agentLabel(id) {
  return { seo: 'SEO agent', writer: 'Writer', 'site-check': 'Site fixes' }[id] ?? id;
}
function kindLabel(k) {
  return { blog_post: 'Blog post', landing_page: 'Landing page', article: 'Article' }[k] ?? k;
}

function renderFolders(folders) {
  $('folders').innerHTML = folders
    .map((f) => {
      const href = f.id === 'site-check' ? '#check' : `#folder/${f.id}`;
      const status = f.working
        ? `<span class="state working">${esc(f.working.replace(/^[^:]+:\s*/, ''))}</span>`
        : f.needs
          ? `<span class="state">Needs ${esc(f.needs)}</span>`
          : f.waiting
            ? `<span class="state ready">${f.waiting} ready</span>`
            : `<span class="state">${f.schedule?.enabled ? 'On' : 'Off'} · ${f.total} made</span>`;
      return `<a class="folder" href="${href}"><span class="glyph">${AGENT_GLYPH[f.id] ?? '•'}</span><span class="name">${esc(f.label)}</span>${status}</a>`;
    })
    .join('');
}

// ---------------------------------------------------------------- documents

const TECH_LABEL = { builder: 'Built with', shop: 'Sells through', hosting: 'Hosted on', analytics: 'Visitor measurement', ads: 'Advertising tags', chat: 'Contact', forms: 'Forms and booking', video: 'Video', social: 'Social profiles', fonts: 'Fonts' };

async function loadDoc(id) {
  showView('doc');
  const d = state.docs.find((x) => x.id === id) ?? state.docs[0];
  const doc = await api(`/api/profile/${d.id}`);
  $('doc-title').textContent = d.title;
  $('doc-body').value = doc.body;
  $('doc-body').dataset.id = d.id;
  $('doc-view').innerHTML = doc.body ? doc.html : '<p class="muted">Not written yet. Research writes it, or click Edit to write it yourself.</p>';
  $('doc-meta').textContent = doc.writtenAt ? `Last written ${when(doc.writtenAt)}` : '';
  const file = new Blob([doc.body], { type: 'text/markdown' });
  $('doc-download').href = URL.createObjectURL(file);
  $('doc-download').download = `${new URL(state.site).hostname}-${d.id}.md`;
  setDocEditing(takeFlash() === 'edit');
  $('save-status').textContent = '';
  $('doc-tech').hidden = d.id !== 'product';
  if (d.id === 'product') {
    const t = await api('/api/tech');
    $('doc-tech').hidden = !t.list.length;
    $('doc-tech-list').innerHTML = t.list
      .map((s) => `<li><span class="tech-kind">${esc(TECH_LABEL[s.kind] ?? s.kind)}</span> <strong>${esc(s.name)}</strong>${s.detail ? ` · <a href="${esc(s.detail)}" target="_blank" rel="noopener" dir="ltr">${esc(s.detail.replace(/^https?:\/\/(www\.)?/, ''))}</a>` : ''} <small>seen on <a href="${esc(s.seenOn)}" target="_blank" rel="noopener">${esc(new URL(s.seenOn).pathname)}</a></small></li>`)
      .join('');
  }
}

function setDocEditing(on) {
  $('doc-view').hidden = on;
  $('doc-body').hidden = !on;
  $('doc-read-actions').hidden = on;
  $('doc-edit-actions').hidden = !on;
  if (on) $('doc-body').focus();
}

// ---------------------------------------------------------------- competitors, people, accounts, notes, llms.txt

async function ensureContext() {
  context = context ?? (await api('/api/context'));
  return context;
}

async function loadCompetitor(id) {
  showView('competitor');
  const c = id === 'new' ? null : (await ensureContext()).competitors.find((x) => x.id === Number(id));
  if (id !== 'new' && !c) return (location.hash = '#today');
  $('comp-title').textContent = c ? c.name : 'Add a competitor';
  $('comp-name').value = c?.name ?? '';
  $('comp-url').value = c?.url ?? '';
  $('comp-notes').value = c?.notes ?? '';
  $('comp-watch').checked = !!c?.watch;
  $('comp-delete').hidden = !c;
  $('comp-status').textContent = takeFlash() || (c ? (c.source === 'research' ? 'Found during research.' : 'Added by you.') : '');
  $('comp-watch-box').hidden = !c?.url;
  if (c?.url) {
    $('comp-checked').textContent = c.lastChecked ? `Last checked ${when(c.lastChecked)}.` : 'Not checked yet. The first check records how their site looks; changes show from the second one.';
    const t = await api('/api/today');
    const mine = t.items.filter((i) => i.kind === 'watch' && i.change.competitorId === c.id);
    $('comp-changes').innerHTML = mine.length
      ? mine.map((i) => `<li><small>${esc(when(i.change.at))}</small>${changeList(i.change.changes)}</li>`).join('')
      : '<li class="muted">No changes waiting.</li>';
  }
  $('comp-save').onclick = async () => {
    const body = { name: $('comp-name').value, url: $('comp-url').value, notes: $('comp-notes').value, watch: $('comp-watch').checked };
    try {
      const saved = c ? await api(`/api/competitors/${c.id}`, { method: 'PUT', body: JSON.stringify(body) }) : await post('/api/competitors', body);
      context = null;
      await goTo(`#competitor/${saved.id}`, 'Saved. Every agent will know this from now on.');
    } catch (err) {
      $('comp-status').textContent = err.message;
    }
  };
  $('comp-delete').onclick = async () => {
    if (!confirm(`Remove ${c.name} from your competitors? Their watch history goes too.`)) return;
    await api(`/api/competitors/${c.id}`, { method: 'DELETE' });
    context = null;
    location.hash = '#today';
  };
  $('comp-check').onclick = async () => {
    $('comp-check').disabled = true;
    $('comp-check').textContent = 'Checking…';
    try {
      const r = await post(`/api/competitors/${c.id}/check`);
      context = null;
      await goTo(`#competitor/${c.id}`, r.changes.length ? `Found ${r.changes.length} change(s).` : r.firstLook ? 'Recorded how their site looks now.' : 'Nothing changed since last time.');
    } catch (err) {
      $('comp-status').textContent = err.message;
    } finally {
      $('comp-check').disabled = false;
      $('comp-check').textContent = 'Check now';
    }
  };
}

async function loadPerson(id) {
  showView('person');
  const p = id === 'new' ? null : (await ensureContext()).people.find((x) => x.id === Number(id));
  if (id !== 'new' && !p) return (location.hash = '#today');
  $('person-title').textContent = p ? p.name : 'Add a person';
  $('person-name').value = p?.name ?? '';
  $('person-role').value = p?.role ?? '';
  $('person-x').value = p?.xHandle ? `@${p.xHandle}` : '';
  $('person-li').value = p?.linkedinUrl ?? '';
  $('person-bio').value = p?.bio ?? '';
  $('person-delete').hidden = !p;
  $('person-status').textContent = takeFlash();
  $('person-save').onclick = async () => {
    try {
      const saved = await post('/api/people', { id: p?.id, name: $('person-name').value, role: $('person-role').value, xHandle: $('person-x').value, linkedinUrl: $('person-li').value, bio: $('person-bio').value });
      context = null;
      await goTo(`#person/${saved.id}`, 'Saved. Agents can now write as or about this person.');
    } catch (err) {
      $('person-status').textContent = err.message;
    }
  };
  $('person-delete').onclick = async () => {
    if (!confirm(`Remove ${p.name}?`)) return;
    await api(`/api/people/${p.id}`, { method: 'DELETE' });
    context = null;
    location.hash = '#today';
  };
}

async function loadAccounts() {
  showView('accounts');
  const c = await ensureContext();
  $('acc-x').value = c.profiles.x ? `@${c.profiles.x}` : '';
  $('acc-li').value = c.profiles.linkedin;
  $('accounts-status').textContent = '';
}

async function loadNotes() {
  showView('notes');
  $('notes-body').value = (await ensureContext()).notes;
  $('notes-status').textContent = '';
}

async function loadLlms() {
  showView('llms');
  try {
    $('llms-body').textContent = (await api('/api/llms-txt')).body;
  } catch (err) {
    $('llms-body').textContent = err.message;
  }
}

// ---------------------------------------------------------------- folders and drafts

async function loadFolder(id) {
  showView('folder');
  const folders = await api('/api/agents');
  const f = folders.find((x) => x.id === id);
  if (!f) return (location.hash = '#today');
  $('folder-title').textContent = f.label;
  $('folder-desc').textContent = f.description;
  $('folder-run').onclick = () => runAgentNow(id);
  const instr = await api(`/api/agents/${encodeURIComponent(id)}/instructions`);
  $('folder-instr').value = instr.text;
  $('folder-instr-tag').textContent = instr.text ? '· set' : '· none yet';
  $('folder-instr-box').open = $('folder-instr-box').open && $('folder-instr-box').dataset.agent === id;
  $('folder-instr-box').dataset.agent = id;
  $('folder-instr-status').textContent = '';
  $('folder-instr-save').onclick = async () => {
    try {
      const r = await api(`/api/agents/${encodeURIComponent(id)}/instructions`, { method: 'PUT', body: JSON.stringify({ text: $('folder-instr').value }) });
      $('folder-instr-tag').textContent = r.text ? '· set' : '· none yet';
      $('folder-instr-status').textContent = r.text ? 'Saved. The agent follows these from its next run.' : 'Cleared.';
    } catch (err) {
      $('folder-instr-status').textContent = err.message;
    }
  };
  for (const b of $('folder-tabs').querySelectorAll('button')) {
    b.classList.toggle('on', b.dataset.status === folderStatus);
    b.onclick = () => ((folderStatus = b.dataset.status), loadFolder(id));
  }
  const drafts = await api(`/api/drafts?agent=${encodeURIComponent(id)}&status=${folderStatus}`);
  $('folder-list').innerHTML = drafts.length
    ? drafts
        .map((d) => `<li><a href="#draft/${d.id}" dir="auto">${esc(d.title)}</a><small>${esc(kindLabel(d.kind))} · ${d.words} words · ${when(d.updatedAt)}${d.dryRun ? ' · dry run' : ''}${d.publishedUrl ? ` · <a href="${esc(d.publishedUrl)}" target="_blank" rel="noopener">open</a>` : ''}</small></li>`)
        .join('')
    : '<li class="muted">Nothing here yet.</li>';
  draftBack = `#folder/${id}`;
}

async function loadDraft(id) {
  showView('draft');
  currentDraft = id;
  publishers = publishers.length ? publishers : await api('/api/publishers');
  const d = await api(`/api/drafts/${id}`);
  $('draft-back').href = draftBack;
  $('draft-back').textContent = draftBack === '#today' ? '← Today' : `← ${agentLabel(d.agent)}`;
  $('draft-agent').textContent = `${agentLabel(d.agent)} · ${kindLabel(d.kind)}`;
  $('draft-title').value = d.title;
  $('draft-reason').textContent = d.meta.reason ? `Why: ${d.meta.reason}` : '';
  $('draft-slug').value = d.meta.slug ?? '';
  $('draft-meta').value = d.meta.metaDescription ?? '';
  updateMetaLen();
  $('draft-body').value = d.body;
  $('draft-target').innerHTML = publishers.map((p) => `<option value="${p.id}">${esc(p.label)}${p.configured ? '' : ' — dry run (no keys)'}</option>`).join('');
  if (d.target) $('draft-target').value = d.target;
  const editable = d.status === 'draft' || d.status === 'failed';
  for (const el of ['draft-title', 'draft-slug', 'draft-meta', 'draft-body', 'draft-save', 'draft-approve', 'draft-target', 'draft-when']) $(el).disabled = !editable;
  $('draft-reject').textContent = d.status === 'rejected' ? 'Reopen' : 'Not useful';
  $('draft-reject').disabled = d.status === 'published' || d.status === 'approved';
  $('draft-status').innerHTML = statusLine(d);
  $('draft-events').innerHTML = d.events.map((e) => `<li>${esc(when(e.at))}: ${esc(e.to_status)}${e.note ? ` — ${esc(e.note)}` : ''}</li>`).join('');
  $('draft-sources').innerHTML = (d.meta.sources ?? []).map((s) => `<li><a href="${esc(s)}" target="_blank" rel="noopener">${esc(s)}</a></li>`).join('');
}

function statusLine(d) {
  if (d.status === 'published') {
    const where = d.publishedUrl ? ` <a href="${esc(d.publishedUrl)}" target="_blank" rel="noopener">${esc(d.publishedUrl)}</a>` : '';
    return d.dryRun ? `Dry run: ${esc(d.target)} isn't connected, so the files were saved instead.${where}` : `Published to ${esc(d.target)}.${where}`;
  }
  if (d.status === 'failed') return `Publishing failed: ${esc(d.error)}`;
  if (d.status === 'approved') return `Scheduled for ${esc(when(d.scheduledFor))} on ${esc(d.target)}.`;
  if (d.status === 'rejected') return 'Turned down.';
  return '';
}

function updateMetaLen() {
  const len = $('draft-meta').value.length;
  $('meta-len').textContent = `${len} chars${len > 155 ? ' — too long' : len && len < 120 ? ' — a bit short' : ''}`;
}

async function saveDraft() {
  await api(`/api/drafts/${currentDraft}`, {
    method: 'PUT',
    body: JSON.stringify({ title: $('draft-title').value, body: $('draft-body').value, meta: { slug: $('draft-slug').value, metaDescription: $('draft-meta').value } }),
  });
}

// ---------------------------------------------------------------- site check

async function loadAudit() {
  showView('check');
  renderAudit(await api('/api/audit'));
}

async function runAudit() {
  $('audit-run').disabled = true;
  try {
    renderAudit(await post('/api/audit'));
  } catch (err) {
    alert(err.message);
  } finally {
    $('audit-run').disabled = false;
  }
}

function renderAudit({ audit, today }) {
  $('audit-empty').hidden = !!audit;
  $('audit-body').hidden = !audit;
  if (!audit) return;
  $('audit-score').textContent = audit.score;
  $('audit-counts').textContent = `${audit.counts.critical} critical · ${audit.counts.warnings} warnings · ${audit.counts.passed} passed · ${audit.pagesChecked} pages · checked ${when(audit.at)}`;
  $('audit-today').innerHTML = today.length
    ? today
        .map(
          (i) => `<div class="fix"><span class="sev ${i.severity}">${i.severity} · ${esc(i.area)}</span><h3>${esc(i.title)}</h3>
          <p class="muted">${esc(i.url)}</p><p>${esc(i.why)}</p><ol>${i.steps.map((s) => `<li>${esc(s)}</li>`).join('')}</ol>
          ${i.snippet ? `<pre><code>${esc(i.snippet)}</code></pre><button class="secondary" data-copy="${esc(i.snippet)}">Copy code</button> ` : ''}
          <button data-done="${esc(i.id)}">Mark as fixed</button></div>`,
        )
        .join('')
    : '<p class="muted">Nothing left to fix today.</p>';
  for (const b of $('audit-today').querySelectorAll('[data-copy]')) b.onclick = () => navigator.clipboard.writeText(b.dataset.copy);
  for (const b of $('audit-today').querySelectorAll('[data-done]'))
    b.onclick = async () => (await post('/api/audit/done', { id: b.dataset.done }), (b.textContent = 'Marked fixed'), (b.disabled = true));
  $('audit-rows').innerHTML = audit.issues.map((i) => `<tr><td><span class="sev ${i.severity}">${i.severity}</span></td><td>${esc(i.title)}</td><td>${esc(new URL(i.url).pathname)}</td></tr>`).join('');
}

// ---------------------------------------------------------------- speed

async function loadSpeed() {
  showView('speed');
  renderSpeed(await api('/api/speed'));
}

async function runSpeed() {
  $('speed-run').disabled = true;
  $('speed-run').textContent = 'Checking… (about a minute)';
  try {
    renderSpeed(await post('/api/speed'));
    renderChrome();
  } catch (err) {
    alert(err.message);
  } finally {
    $('speed-run').disabled = false;
    $('speed-run').textContent = 'Check speed now';
  }
}

function renderSpeed(all) {
  for (const b of $('speed-device').querySelectorAll('button')) {
    b.classList.toggle('on', b.dataset.device === speedDevice);
    b.onclick = () => ((speedDevice = b.dataset.device), pref.set('speedDevice', speedDevice), renderSpeed(all), renderChrome());
  }
  const r = all[speedDevice];
  $('speed-empty').hidden = !!r;
  $('speed-body').hidden = !r;
  if (!r) return;
  $('speed-headline').className = `headline${r.headline ? '' : ' ok'}`;
  $('speed-headline').innerHTML = r.headline
    ? `<span>${esc(r.headline)}</span><button id="speed-send">Send to SEO agent</button>`
    : `<span>Every loading measurement passes on ${speedDevice === 'mobile' ? 'phones' : 'computers'}.</span>`;
  if (r.headline)
    $('speed-send').onclick = async () => {
      try {
        await post('/api/speed/send', { strategy: speedDevice });
        $('speed-send').textContent = 'Added to today’s fixes';
        $('speed-send').disabled = true;
      } catch (err) {
        alert(err.message);
      }
    };
  const labels = { performance: 'Performance', accessibility: 'Accessibility', bestPractices: 'Best practices', seo: 'SEO' };
  $('speed-scores').innerHTML = Object.entries(labels)
    .map(([k, label]) => {
      const v = r.scores[k];
      const c = band(v);
      return `<div class="gauge"><div class="ring ${c}" style="background: conic-gradient(currentColor ${v * 3.6}deg, var(--line) 0); "><span style="background: var(--panel); width: 60px; height: 60px; border-radius: 50%; display: grid; place-items: center;">${v}</span></div>${label}</div>`;
    })
    .join('');
  $('speed-vitals').innerHTML = r.vitals
    .map((v) => `<div class="vital"><div class="t">${esc(v.label)}</div><div class="v ${v.rating === 'good' ? 'good' : v.rating === 'poor' ? 'bad' : 'mid'}">${esc(v.display)}</div><div class="t">${esc(v.target)}</div></div>`)
    .join('');
  $('speed-when').textContent = `on ${when(r.at)}`;
  $('speed-opps').innerHTML = r.opportunities.length
    ? r.opportunities.map((o) => `<li><strong>${esc(o.title)}</strong> <small>could save about ${(o.savingsMs / 1000).toFixed(1)}s</small><small>${esc(o.description)}</small></li>`).join('')
    : '<li class="muted">Google has no big suggestions for this page.</li>';
}

// ---------------------------------------------------------------- results

async function loadResults() {
  showView('results');
  $('results-days').textContent = `· last ${days} days`;
  const msg = new URLSearchParams(location.hash.split('?')[1] || '').get('google');
  const g = await api('/api/google');
  $('google-setup').hidden = g.configured;
  $('google-msg').textContent = msg ? `Google: ${msg}` : g.lastPull ? pullLine(g.lastPull) : '';
  $('google-actions').innerHTML = !g.configured
    ? ''
    : g.connected
      ? '<button id="g-pull">Get latest data</button> <button id="g-off" class="secondary">Disconnect</button>'
      : `<a href="${withSite('/api/google/connect')}"><button>Connect Google</button></a>`;
  $('google-pick').hidden = !g.connected;
  $('results-body').hidden = !g.connected;
  if (!g.connected) return;
  $('g-pull').onclick = pullGoogle;
  $('g-off').onclick = async () => confirm('Disconnect Google? Saved data stays.') && (await post('/api/google/disconnect'), loadResults());
  try {
    const opts = await api('/api/google/options');
    $('gsc-site').innerHTML = '<option value="">— none —</option>' + opts.sites.map((s) => `<option ${s === g.site ? 'selected' : ''}>${esc(s)}</option>`).join('');
    $('ga-prop').innerHTML = '<option value="">— none —</option>' + opts.properties.map((p) => `<option value="${esc(p.id)}" ${p.id === g.property ? 'selected' : ''}>${esc(p.name)} (${esc(p.id)})</option>`).join('');
  } catch (err) {
    $('google-msg').textContent = `Couldn't list your Google sites: ${err.message}`;
  }
  $('gsc-site').onchange = () => api('/api/google/selection', { method: 'PUT', body: JSON.stringify({ site: $('gsc-site').value }) });
  $('ga-prop').onchange = () => api('/api/google/selection', { method: 'PUT', body: JSON.stringify({ property: $('ga-prop').value }) });
  renderResults(await api(`/api/results?days=${days}`));
}

async function pullGoogle() {
  const b = $('g-pull');
  if (b) b.disabled = true;
  $('google-msg').textContent = 'Getting data from Google…';
  try {
    $('google-msg').textContent = pullLine(await post('/api/google/pull'));
    renderResults(await api(`/api/results?days=${days}`));
  } finally {
    if (b) b.disabled = false;
  }
}

function pullLine(p) {
  const part = (label, s, what) => (s.error ? `${label} failed: ${s.error}` : (s.site ?? s.property) ? `${label}: ${n(s.rows)} ${what}` : `${label}: not selected`);
  return `Last update ${when(p.at)} · ${part('Search Console', p.searchConsole, 'rows')} · ${part('Analytics', p.analytics, 'rows')}`;
}

function renderResults(r) {
  const empty = (cols) => `<tr><td colspan="${cols}" class="muted">No data yet.</td></tr>`;
  $('r-near').innerHTML = r.nearlyThere.map((o) => `<tr><td dir="auto">${esc(o.keyword)}</td><td>${n(o.impressions)}</td><td>${pos(o.position)}</td></tr>`).join('') || empty(3);
  $('r-mine').innerHTML =
    r.published.map((m) => `<tr><td><a href="${esc(m.url)}" target="_blank" rel="noopener" dir="auto">${esc(m.title)}</a> <small class="muted">${m.publishedDaysAgo}d ago</small></td><td>${n(m.clicks)}</td><td>${n(m.impressions)}</td><td>${pos(m.position)}</td><td>${n(m.views)}</td><td dir="auto">${esc(m.topQuery ?? '—')}</td></tr>`).join('') || empty(6);
  $('r-queries').innerHTML = r.queries.map((q) => `<tr><td dir="auto">${esc(q.query)}</td><td>${n(q.clicks)}</td><td>${n(q.impressions)}</td><td>${(q.ctr * 100).toFixed(1)}%</td><td>${pos(q.position)}</td></tr>`).join('') || empty(5);
  $('r-pages').innerHTML = r.pages.map((p) => `<tr><td>${esc(p.page)}</td><td>${n(p.views)}</td><td>${p.engagement == null ? '—' : (p.engagement * 100).toFixed(0) + '%'}</td><td>${n(p.clicks)}</td></tr>`).join('') || empty(4);
  $('r-notes').textContent = r.notes ?? 'Nothing yet — agents will be told once there is data.';
}

// ---------------------------------------------------------------- timetable and logs

const CRON_WORDS = { '* * * * *': 'every minute', '7 6 * * *': 'daily 06:07', '47 5 * * *': 'daily 05:47', '17 6 * * *': 'daily 06:17', '53 3 * * *': 'daily 03:53', '13 7 * * 1-5': 'weekdays 07:13' };

async function loadLogs() {
  showView('logs');
  const [tasks, logs] = await Promise.all([api('/api/tasks'), api('/api/logs?limit=200')]);
  $('task-rows').innerHTML = tasks
    .map((t) => `<tr>
      <td><input type="checkbox" data-toggle="${esc(t.id)}" ${t.enabled ? 'checked' : ''}></td>
      <td>${esc(t.label)}${t.costsMoney ? ' <small>$</small>' : ''}${t.costsMoney ? ` <small>· <input type="number" min="1" max="10" value="${t.limit ?? 1}" data-limit="${esc(t.id)}" style="width:52px"> per run</small>` : ''}</td>
      <td><input value="${esc(t.cron)}" data-cron="${esc(t.id)}" title="minute hour day month weekday" style="width:120px"> <small>${esc(CRON_WORDS[t.cron] ?? '')}</small></td>
      <td>${t.running ? 'running now' : when(t.next)}</td>
      <td>${t.last ? `<small>${when(t.last.started_at)} · ${esc(t.last.status)}</small> ${esc(t.last.message ?? '')}` : '<small>never run</small>'}</td>
      <td><button class="secondary" data-run="${esc(t.id)}" ${t.running ? 'disabled' : ''}>Run now</button></td></tr>`)
    .join('');
  $('log-rows').innerHTML = logs.map((l) => `<tr class="level-${esc(l.level)}"><td><small>${when(l.at)}</small></td><td>${esc(l.source)}</td><td>${esc(l.message)}</td></tr>`).join('') || '<tr><td colspan="3" class="muted">Nothing logged yet.</td></tr>';
  const put = (id, body) => api(`/api/tasks/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify(body) }).then(loadLogs, (e) => (alert(e.message), loadLogs()));
  for (const el of document.querySelectorAll('[data-toggle]')) el.onchange = () => put(el.dataset.toggle, { enabled: el.checked });
  for (const el of document.querySelectorAll('[data-cron]')) el.onchange = () => put(el.dataset.cron, { cron: el.value.trim() });
  for (const el of document.querySelectorAll('[data-limit]')) el.onchange = () => put(el.dataset.limit, { limit: Number(el.value) });
  for (const el of document.querySelectorAll('[data-run]'))
    el.onclick = async () => {
      el.disabled = true;
      el.textContent = 'Running…';
      const r = await post(`/api/tasks/${encodeURIComponent(el.dataset.run)}/run`);
      if (r.status === 'failed') alert(r.message);
      loadLogs();
    };
}

// ---------------------------------------------------------------- AI cost

async function loadUsage() {
  showView('usage');
  const u = await api('/api/usage');
  const b = u.budget;
  const pct = b.limit ? Math.min(100, (100 * b.spent) / b.limit) : 0;
  $('budget-line').textContent = b.limit ? `$${b.spent.toFixed(2)} of $${b.limit.toFixed(2)} used this month` : `$${b.spent.toFixed(2)} used this month (no limit)`;
  $('budget-bar').style.width = `${pct}%`;
  $('budget-bar').className = pct >= 80 ? 'high' : '';
  $('budget-reset').textContent = `${b.remaining != null ? `$${b.remaining.toFixed(2)} left · ` : ''}starts again ${new Date(b.resets).toLocaleDateString()}`;
  $('budget-limit').value = b.limit;
  $('usage-total').textContent = `${u.total.calls} AI calls so far, $${u.total.cost.toFixed(2)} in total.`;
  const l = state.llm;
  const search = { server: "Claude's built-in search", local: 'Plume runs searches itself (Tavily)', off: 'off — add TAVILY_API_KEY to .env to turn it on' }[l.webSearch];
  $('usage-llm').innerHTML = l.error
    ? `AI is not connected. <a href="/#llm">Set up the AI connection</a>.`
    : `Calls go to ${esc(l.endpoint)} (key ${esc(l.keyHint)}, ${l.source === 'saved' ? 'saved on the AI connection screen' : 'from .env'}). Models: research ${esc(l.models.research)}, writing ${esc(l.models.draft)}, scoring ${esc(l.models.score)}. Web search: ${esc(search)}. <a href="/#llm">Change</a>`;
  $('usage-rows').innerHTML = u.byPurpose
    .map((r) => `<tr><td>${esc(r.purpose)}</td><td>${esc(r.model)}</td><td>${r.calls}</td><td>${n(r.input)} / ${n(r.output)}</td><td>$${r.cost.toFixed(3)}</td></tr>`)
    .join('');
}

// ---------------------------------------------------------------- tour

const TOUR = [
  { el: 'col-left', title: 'What your agents know', text: 'Every agent reads these documents before it writes anything. Correct something here once and every agent gets it right from then on.' },
  { el: 'today-card', title: 'Today', text: 'Your agents’ work arrives here one card at a time: drafts, site fixes and speed problems, most important first. Approve, edit, skip it for today, or mark it not useful so the agent learns.' },
  { el: 'folders', title: 'Agents', text: 'One folder per agent. “Ready” means work is waiting for you, a pulsing dot means it is working right now. Open a folder to see everything it has made.' },
  { el: 'speed-chips', title: 'Health at a glance', text: 'Your site’s speed, accessibility, best-practice and SEO scores from Google, checked every morning. Click them for details and fixes.' },
  { el: 'col-right', title: 'Ask Plume', text: 'Ask anything in plain words, or have it write something. It knows your documents, results and competitors. Changes it suggests wait for you to apply them, and anything it writes goes to Today first. Type @ to point at an agent or document.' },
  { el: 'cost-link', title: 'Cost and safety', text: 'See exactly what the AI has cost this month and set a monthly limit. Nothing is ever published until you approve it.' },
];
let tourStep = 0;

function showTour(step) {
  tourStep = step;
  for (const el of document.querySelectorAll('.tour-target')) el.classList.remove('tour-target');
  const s = TOUR[step];
  const target = $(s.el);
  if (!target || target.offsetParent === null) return step + 1 < TOUR.length ? showTour(step + 1) : endTour();
  $('tour').hidden = false;
  target.classList.add('tour-target');
  target.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  $('tour-title').textContent = s.title;
  $('tour-text').textContent = s.text;
  $('tour-step').textContent = `${step + 1} of ${TOUR.length}`;
  $('tour-back').disabled = step === 0;
  $('tour-next').textContent = step === TOUR.length - 1 ? 'Done' : 'Next';
  const r = target.getBoundingClientRect();
  const box = $('tour').querySelector('.tour-box');
  const w = Math.min(340, window.innerWidth - 32);
  const left = Math.min(Math.max(16, r.left), window.innerWidth - w - 16);
  const below = r.bottom + 12 + 200 < window.innerHeight;
  box.style.left = `${left}px`;
  box.style.top = below ? `${Math.min(r.bottom + 12, window.innerHeight - 220)}px` : `${Math.max(70, r.top - 210)}px`;
}

function endTour() {
  $('tour').hidden = true;
  for (const el of document.querySelectorAll('.tour-target')) el.classList.remove('tour-target');
  pref.set('tourDone', true);
}

// ---------------------------------------------------------------- wiring

$('onboard-form').onsubmit = (e) => {
  e.preventDefault();
  $('onboard').hidden = true;
  $('workspace').hidden = false;
  runResearch({}).catch((err) => alert(err.message));
};
$('llms-download').href = withSite('/api/llms-txt/download');
$('regen').onclick = () => confirm('Rewrite this document from scratch? Your edits to it will be replaced.') && runResearch({ only: $('doc-body').dataset.id });
$('save').onclick = async () => {
  await api(`/api/profile/${$('doc-body').dataset.id}`, { method: 'PUT', body: JSON.stringify({ body: $('doc-body').value }) });
  await loadDoc($('doc-body').dataset.id);
  $('save-status').textContent = 'Saved. Every agent will use this from now on.';
};
$('doc-edit').onclick = () => setDocEditing(true);
$('doc-cancel').onclick = () => loadDoc($('doc-body').dataset.id);
$('doc-copy').onclick = () => navigator.clipboard.writeText($('doc-body').value).then(() => ($('doc-copy').textContent = 'Copied'), () => ($('doc-copy').textContent = 'Copy failed'));
$('accounts-save').onclick = async () => {
  try {
    const r = await api('/api/profiles', { method: 'PUT', body: JSON.stringify({ x: $('acc-x').value, linkedin: $('acc-li').value }) });
    context = null;
    $('acc-x').value = r.x ? `@${r.x}` : '';
    $('acc-li').value = r.linkedin;
    $('accounts-status').textContent = 'Saved.';
    renderChrome();
  } catch (err) {
    $('accounts-status').textContent = err.message;
  }
};
$('notes-save').onclick = async () => {
  await api('/api/notes', { method: 'PUT', body: JSON.stringify({ notes: $('notes-body').value }) });
  context = null;
  $('notes-status').textContent = 'Saved. Every agent reads these notes before writing.';
};
$('llms-copy').onclick = () => navigator.clipboard.writeText($('llms-body').textContent).then(() => ($('llms-copy').textContent = 'Copied'));
$('draft-meta').oninput = updateMetaLen;
$('draft-save').onclick = async () => (await saveDraft(), ($('draft-status').textContent = 'Saved.'));
$('draft-approve').onclick = async () => {
  try {
    await saveDraft();
    const at = $('draft-when').value ? new Date($('draft-when').value).toISOString() : null;
    await post(`/api/drafts/${currentDraft}/approve`, { target: $('draft-target').value, when: at });
    await loadDraft(currentDraft);
  } catch (err) {
    alert(err.message);
  }
};
$('draft-reject').onclick = async () => {
  try {
    if ($('draft-reject').textContent === 'Reopen') await post(`/api/drafts/${currentDraft}/reopen`);
    else {
      const reason = prompt('What was wrong with it? (optional — the agent will learn from this)');
      if (reason === null) return;
      await post(`/api/drafts/${currentDraft}/not-useful`, { reason });
    }
    await loadDraft(currentDraft);
  } catch (err) {
    alert(err.message);
  }
};
$('audit-run').onclick = runAudit;
$('speed-run').onclick = runSpeed;
for (const b of $('range').querySelectorAll('button'))
  b.onclick = () => {
    days = Number(b.dataset.days);
    pref.set('days', days);
    for (const x of $('range').querySelectorAll('button')) x.classList.toggle('on', x === b);
    if (location.hash.startsWith('#results')) loadResults();
  };
$('budget-save').onclick = async () => {
  try {
    await api('/api/budget', { method: 'PUT', body: JSON.stringify({ limit: Number($('budget-limit').value) }) });
    loadUsage();
    renderChrome();
  } catch (err) {
    alert(err.message);
  }
};
$('tour-btn').onclick = () => showTour(0);
$('tour-next').onclick = () => (tourStep + 1 < TOUR.length ? showTour(tourStep + 1) : endTour());
$('tour-back').onclick = () => showTour(Math.max(0, tourStep - 1));
$('tour-close').onclick = endTour;
document.addEventListener('keydown', (e) => e.key === 'Escape' && !$('tour').hidden && endTour());

window.onhashchange = () => {
  if (location.hash === '#today') draftBack = '#today';
  route().catch((err) => alert(err.message));
};
route()
  .then(() => {
    if (state?.site && !pref.get('tourDone', false)) setTimeout(() => showTour(0), 600);
  })
  .catch((err) => alert(err.message));

// ---------------------------------------------------------------- settings (this website)

async function loadSettings() {
  showView('settings');
  $('settings-site').textContent = state.siteName;
  $('set-name').value = state.siteName;
  $('set-url').value = state.site || '';
  $('set-general-status').textContent = '';
  const [ints, g] = await Promise.all([api('/api/integrations'), api('/api/google')]);
  $('set-publish').innerHTML = ints.filter((i) => i.group === 'publishing').map(integrationCard).join('');
  const gInt = ints.find((i) => i.id === 'google');
  $('set-analytics').innerHTML = integrationCard(gInt) + `<div class="int-card" id="g-signin"><div class="int-head"><strong>Sign in</strong>
    <span class="${g.connected ? 'good' : 'muted'} small">${g.connected ? 'Signed in' : g.configured ? 'Not signed in' : 'Save the client ID and secret first'}</span></div>
    <p class="muted small">Search Console: ${g.site ? esc(g.site) : 'no site picked'} · Analytics: ${g.property ? esc(g.property) : 'no property picked'}</p>
    <p class="actions-row">${g.configured ? (g.connected
      ? '<button id="g-check" class="secondary">Check both services</button> <a href="#results"><button class="secondary">Choose site and property</button></a> <button id="g-out" class="secondary">Sign out</button>'
      : `<a href="${withSite('/api/google/connect')}"><button>Sign in with Google</button></a>`) : ''}
      <span id="g-msg" class="small"></span></p>
    <ul id="g-checks" class="item-list"></ul>
    <details class="small"><summary>How to get a client ID and secret</summary><ol>
      <li>In <a href="https://console.cloud.google.com/apis/credentials" target="_blank" rel="noopener">Google Cloud Console</a>, create an <b>OAuth client ID</b> of type <b>Desktop app</b>.</li>
      <li>Under <b>APIs &amp; Services → Library</b>, turn on <b>Google Search Console API</b>, <b>Google Analytics Data API</b> and <b>Google Analytics Admin API</b>.</li>
      <li>If the app is in "Testing", add your Google account as a test user.</li>
      <li>Paste the client ID and secret above, save, then sign in.</li></ol></details></div>`;
  for (const card of document.querySelectorAll('.int-card[data-int]')) wireIntegration(card);
  if ($('g-check')) $('g-check').onclick = async () => {
    $('g-msg').textContent = 'Checking…';
    try {
      const rows = await post('/api/google/test');
      $('g-msg').textContent = '';
      $('g-checks').innerHTML = rows.map((r) => `<li><strong>${esc(r.label)}</strong> — <span class="${r.ok ? 'good' : 'warn'}">${esc(r.message)}</span></li>`).join('');
    } catch (err) {
      $('g-msg').textContent = err.message;
    }
  };
  if ($('g-out')) $('g-out').onclick = async () => confirm('Sign out of Google for this website? Saved data stays.') && (await post('/api/google/disconnect'), goTo('#settings'));
}

function integrationCard(i) {
  const fields = i.fields
    .map((f) => `<label>${esc(f.label)}${f.optional ? ' <span class="muted">(optional)</span>' : ''}
      <input data-key="${f.key}" type="${f.secret ? 'password' : 'text'}" autocomplete="off" spellcheck="false" value="${esc(f.value)}"
        placeholder="${esc(f.secret && f.hint ? `saved (ends ${f.hint}) — leave empty to keep` : f.placeholder)}">
      ${f.help ? `<span class="muted small">${esc(f.help)}</span>` : ''}</label>`)
    .join('');
  return `<details class="int-card" data-int="${i.id}">
    <summary class="int-head"><strong>${esc(i.label)}</strong><span class="small ${i.connected ? 'good' : 'muted'}">${i.connected ? 'Connected' : 'Not connected'}</span></summary>
    <p class="muted small">${esc(i.blurb)}</p>
    <div class="form">${fields}</div>
    <p class="actions-row"><button data-act="save">Save</button> <button data-act="test" class="secondary" ${i.connected ? '' : 'disabled'}>Test</button>
      ${i.connected ? '<button data-act="remove" class="secondary">Disconnect</button>' : ''} <span class="int-msg small"></span></p>
  </details>`;
}

function wireIntegration(card) {
  const id = card.dataset.int;
  const msg = (text, cls = 'muted') => ((card.querySelector('.int-msg').textContent = text), (card.querySelector('.int-msg').className = `int-msg small ${cls}`));
  const values = () => Object.fromEntries([...card.querySelectorAll('input[data-key]')].map((el) => [el.dataset.key, el.value]));
  card.querySelector('[data-act="save"]').onclick = async () => {
    try {
      await api(`/api/integrations/${id}`, { method: 'PUT', body: JSON.stringify({ values: values() }) });
      publishers = [];
      await goTo('#settings', '');
      document.querySelector(`.int-card[data-int="${id}"]`).open = true;
      const m = document.querySelector(`.int-card[data-int="${id}"] .int-msg`);
      m.textContent = 'Saved. Press Test to check it works.';
    } catch (err) {
      msg(err.message, 'warn');
    }
  };
  const test = card.querySelector('[data-act="test"]');
  test.onclick = async () => {
    msg('Checking…');
    try {
      const r = await post(`/api/integrations/${id}/test`);
      msg(r.message, r.ok ? 'good' : 'warn');
    } catch (err) {
      msg(err.message, 'warn');
    }
  };
  const rm = card.querySelector('[data-act="remove"]');
  if (rm) rm.onclick = async () => {
    if (!confirm('Disconnect? The saved details are deleted from this computer.')) return;
    await api(`/api/integrations/${id}`, { method: 'DELETE' });
    publishers = [];
    await goTo('#settings');
  };
}

$('set-name-save').onclick = async () => {
  try {
    await api(`/api/sites/${encodeURIComponent(SITE)}`, { method: 'PUT', body: JSON.stringify({ name: $('set-name').value }) });
    await goTo('#settings');
    $('set-general-status').textContent = 'Saved.';
  } catch (err) {
    $('set-general-status').textContent = err.message;
  }
};
$('set-remove').onclick = async () => {
  const typed = prompt(`This deletes ${SITE}'s folder: documents, drafts, results and saved connections. AI cost records stay.\n\nType this to confirm:\n\n${SITE}`);
  if (typed === null) return;
  if (typed.trim() !== SITE) return alert('That did not match, so nothing was removed.');
  await api(`/api/sites/${encodeURIComponent(SITE)}`, { method: 'DELETE' });
  location.href = '/';
};
