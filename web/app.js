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

// ---- what we did and what happened (shared by Results and Site fixes)
const ACTION_WORDS = { 'fix-done': 'Fixed', published: 'Published', 'doc-edited': 'Edited document', 'code-pr': 'Code fix opened' };
const actionPage = (a) => (a.url ? (() => { try { return new URL(a.url).pathname; } catch { return a.url; } })() : a.kind === 'doc-edited' ? '—' : 'whole site');
const PROBLEM_WORDS = { gone: '✓ gone', 'still there': '✗ still there', 'not checked yet': 'not checked yet' };
/** "40 → 61", "61 so far" for new pages, or "too early" while there are under two weeks of data. */
function beforeAfter(a, key, fmt) {
  if (a.kind === 'doc-edited') return '—';
  if (a.tooEarly) return `<small class="muted">too early (${a.daysAfter}d)</small>`;
  if (!a.after) return '—';
  return a.before ? `${fmt(a.before[key])} → ${fmt(a.after[key])}` : `${fmt(a.after[key])} <small class="muted">since</small>`;
}
const when = (iso) => (iso ? new Date(iso).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' }) : '—');
const areaLabel = (a) => ({ 'ai-search': 'AI search', 'on-page': 'on the page' })[a] ?? a;
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

const VIEWS = ['today', 'job', 'doc', 'competitor', 'person', 'accounts', 'notes', 'llms', 'folder', 'draft', 'check', 'speed', 'results', 'analytics', 'logs', 'usage', 'settings', 'rankings', 'ai', 'outreach', 'tools'];

function showView(id) {
  // Views added by later scripts (e.g. rankings.js) may not exist yet on the first call.
  for (const v of VIEWS) if ($(`view-${v}`)) $(`view-${v}`).hidden = v !== id;
  for (const a of document.querySelectorAll('.nav-list a')) a.classList.toggle('active', a.getAttribute('href') === location.hash);
  // Top bar: mark the page you're on. Today and everything opened from it count as the Dashboard.
  const page = { today: '#today', analytics: '#analytics', results: '#results', outreach: '#outreach', tools: '#tools', logs: '#logs', usage: '#usage', settings: '#settings' }[id] ?? '#today';
  for (const a of document.querySelectorAll('.bar-links a')) a.classList.toggle('on', a.getAttribute('href') === page);
  $('col-center').scrollTop = 0;
}

async function route() {
  state = await api('/api/state');
  $('key-warning').hidden = state.hasApiKey;
  document.title = `${state.siteName} — Plume`;
  // Nothing researched yet: if research is already running (say, after a reload), show it; otherwise offer to start.
  if (!state.docs.some((d) => d.written) && $('view-job').hidden) {
    const research = (await api('/api/jobs/running').catch(() => [])).find((j) => j.kind === 'research');
    if (research) {
      $('onboard').hidden = true;
      $('workspace').hidden = false;
      waitForJob(research.id, 'Researching your site…').catch((err) => alert(`Research stopped: ${err.message}`)).then(() => ((location.hash = '#doc/product'), route()));
      return;
    }
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
    case 'analytics': return loadAnalytics(arg);
    case 'results': return loadResults();
    case 'rankings': return window.plumeRankings ? window.plumeRankings.load() : loadToday();
    case 'ai': return window.plumeGeo ? window.plumeGeo.load() : loadToday();
    case 'outreach': return window.plumeOutreach ? window.plumeOutreach.load(arg) : loadToday();
    case 'tools': return window.plumeTools ? window.plumeTools.load(arg) : loadToday();
    case 'logs': return loadLogs();
    case 'usage': return loadUsage();
    case 'settings': return loadSettings();
    default: return loadToday();
  }
}

// ---------------------------------------------------------------- frame: top bar + left + right

const svgIco = (d) => `<svg class="nav-svg" viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path d="${d}" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const NAV_ICON = {
  doc: svgIco('M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8zM14 3v5h5M9 13h6M9 17h4'),
  note: svgIco('M12 20h9M16.5 3.5a2.1 2.1 0 1 1 3 3L7 19l-4 1 1-4z'),
  file: svgIco('M4 6h16M4 12h16M4 18h10'),
};

async function renderChrome() {
  $('site-name').textContent = state.siteName;
  if (state.site) $('site-icon').src = `https://www.google.com/s2/favicons?sz=32&domain=${encodeURIComponent(new URL(state.site).hostname)}`;
  loadBarNumbers();
  pollLive();
  const lang = state.language;
  $('lang-line').textContent = lang.code === 'en' ? 'Agents write in English.' : `Agents write in ${lang.name}, the language of your site.`;

  $('doc-list').innerHTML =
    state.docs.map((d) => `<li><a href="#doc/${d.id}"><span class="nav-label">${NAV_ICON.doc}${esc(d.title)}</span><span class="tag">${d.written ? '' : 'not written'}</span></a></li>`).join('') +
    `<li><a href="#notes"><span class="nav-label">${NAV_ICON.note}Your notes</span></a></li><li><a href="#llms"><span class="nav-label">${NAV_ICON.file}llms.txt</span></a></li>`;
  api('/api/context').then((c) => {
    context = c;
    $('comp-count').textContent = c.competitors.length || '';
    $('comp-list').innerHTML = c.competitors.length
      ? c.competitors
          .map((x) => {
            const ico = x.url ? `<img class="nav-fav" alt="" loading="lazy" src="https://www.google.com/s2/favicons?sz=32&domain=${encodeURIComponent(new URL(x.url).hostname)}">` : `<span class="nav-ico">${esc(x.name[0] ?? '?')}</span>`;
            const tag = x.unseen ? `<span class="tag new" title="${x.unseen} finding(s) waiting in Today">${x.unseen} new</span>` : x.watch ? '<span class="tag" title="Scanned every week"><span class="dot"></span>watching</span>' : '<span class="tag"></span>';
            return `<li><a href="#competitor/${x.id}" dir="auto"><span class="nav-label">${ico}${esc(x.name)}</span>${tag}</a></li>`;
          })
          .join('')
      : '<li class="nav-empty">None yet. Research fills this in, or add your own.</li>';
    $('comp-suggest').innerHTML = c.suggestions.length
      ? `<div class="suggest-head">Spotted in your space</div>` +
        c.suggestions
          .slice(0, 4)
          .map((sg) => `<div class="suggest" title="${esc(sg.reason)}"><span class="suggest-name" dir="auto">${esc(sg.name)}${sg.sourceUrl ? ` <a href="${esc(sg.sourceUrl)}" target="_blank" rel="noopener" class="muted" title="Where it was seen">↗</a>` : ''}</span><button class="small-btn" data-sg-add="${sg.id}">Add</button><button class="small-btn secondary" data-sg-dismiss="${sg.id}" title="Not a competitor">×</button></div>`)
          .join('')
      : '';
    for (const b of $('comp-suggest').querySelectorAll('button')) {
      b.onclick = async () => {
        b.disabled = true;
        const add = b.dataset.sgAdd;
        await post(`/api/competitor-suggestions/${add ?? b.dataset.sgDismiss}/${add ? 'add' : 'dismiss'}`).catch((err) => alert(err.message));
        context = null;
        renderChrome();
      };
    }
    $('people-list').innerHTML = c.people.length
      ? c.people.map((p) => `<li><a href="#person/${p.id}" dir="auto"><span class="nav-label"><span class="nav-ico round">${esc((p.name[0] ?? '?').toUpperCase())}</span>${esc(p.name)}</span><span class="tag">${esc(p.role)}</span></a></li>`).join('')
      : '<li class="nav-empty">Add the founder or whoever posts for the business.</li>';
    $('accounts-tag').textContent = [c.profiles.x && 'X', c.profiles.linkedin && 'LinkedIn', c.profiles.facebook && 'Facebook'].filter(Boolean).join(' · ') || 'not set';
    for (const a of document.querySelectorAll('.nav-list a')) a.classList.toggle('active', a.getAttribute('href') === location.hash);
  }, () => {});
  for (const a of document.querySelectorAll('.nav-list a')) a.classList.toggle('active', a.getAttribute('href') === location.hash);

  // These don't block the page: each fills in when it arrives.
  api('/api/profile/product').then((d) => ($('summary').textContent = summaryOf(d.body) || 'The business summary appears here once research is done.'), () => {});
  api('/api/google').then((g) => {
    $('google-pill').innerHTML = !g.configured ? '' : g.connected ? '<span title="Search Console and Analytics are connected">Google ✓</span>' : `<a href="${withSite('/api/google/connect')}">Connect Google</a>`;
  }, () => {});
  api('/api/budget').then((b) => {
    $('cost-link').textContent = b.limit ? `AI $${b.spent.toFixed(2)} / $${b.limit}` : `AI $${b.spent.toFixed(2)}`;
  }, () => {});
  renderQuick();
  pollActivity();
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
    ['Research my site again', () => confirm('Research the whole site again? This replaces all the documents, including your edits.') && runResearch({})],
  ];
  $('quick').innerHTML = actions.map(([label], i) => `<button class="secondary" data-q="${i}">${esc(label)}</button>`).join('');
  for (const b of $('quick').querySelectorAll('button')) b.onclick = () => actions[Number(b.dataset.q)][1]().catch?.((e) => alert(e.message));
}

// ---------------------------------------------------------------- jobs

async function waitForJob(jobId, label) {
  pollActivity();
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

/** Start an agent in the background. The page stays usable, so you can start others while it works. */
async function runAgentNow(id) {
  try {
    await post(`/api/agents/${id}/run`);
    flash = `${agentLabel(id)} started. It works in the background — start others too, or keep working.`;
    pollActivity();
    await route();
  } catch (err) {
    alert(err.message);
  }
}

async function runAllAgents() {
  if (!confirm('Start every agent at the same time? Each one looks for work and writes drafts, which uses AI.')) return;
  try {
    const { started } = await post('/api/agents/run', {});
    flash = `${started.length} agents started. They work side by side; drafts arrive in Today as each one finishes.`;
    pollActivity();
    await goTo('#today');
  } catch (err) {
    alert(err.message);
  }
}

// ---------------------------------------------------------------- what's running right now

/** Plain-words name for a job kind. */
function jobLabel(kind) {
  if (kind === 'research') return 'Research';
  if (kind.startsWith('agent:')) return agentLabel(kind.slice(6));
  const named = {
    'site-check': 'Site check', speed: 'Speed check', google: 'Google data', 'ai-visibility': 'AI visibility check', 'competitor-watch': 'Competitor check',
    'competitor-news': 'Competitor news scan', 'competitor-scan': 'Competitor scan', serp: 'Google lookup', 'rank-moves': 'Ranking check', refresh: 'Re-reading the site',
    codefix: 'Preparing a pull request', cleanup: 'Tidying logs', 'outreach:creator': 'Finding creators', 'outreach:link': 'Finding link pages',
  };
  const k = kind.startsWith('task:') ? kind.slice(5) : kind;
  if (k.startsWith('video:')) return 'Video preview';
  return named[k] ?? k.replace(/[-:]/g, ' ').replace(/^./, (c) => c.toUpperCase());
}

let runningIds = '';
const closeActivity = () => (($('activity-list').hidden = true), $('activity').setAttribute('aria-expanded', 'false'));
let activityTimer = null;
/**
 * Asks the server what's running and shows it in the top bar. The server keeps the jobs, so this
 * survives reloads. Checks every few seconds while something runs, and now and then otherwise.
 */
async function pollActivity() {
  clearTimeout(activityTimer);
  const jobs = await api('/api/jobs/running').catch(() => null);
  if (jobs) {
    const el = $('activity');
    el.hidden = !jobs.length;
    if (jobs.length) {
      const j = jobs[0];
      const step = (j.progress || '').replace(/^[^:]+:\s*/, '');
      el.innerHTML = jobs.length > 1
        ? `<span class="spin" aria-hidden="true"></span><b>${jobs.length} running</b><span class="step">${esc(jobs.map((x) => jobLabel(x.kind)).join(', '))}</span>`
        : `<span class="spin" aria-hidden="true"></span><b>${esc(jobLabel(j.kind))}</b><span class="step">${esc(step)}</span>`;
      el.title = 'See everything that is running';
      $('activity-list').innerHTML = `<div class="al-head">Running now <span class="muted small">${jobs.length}</span></div>${jobs
        .map((x) => `<div class="al-row"><span class="spin" aria-hidden="true"></span><div><b>${esc(jobLabel(x.kind))}</b><div class="muted small">${esc((x.progress || 'working').replace(/^[^:]+:\s*/, ''))} · since ${esc(new Date(x.started_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }))}</div></div></div>`)
        .join('')}<a href="#logs" class="al-foot">Timetable and logs →</a>`;
    }
    if (!jobs.length) closeActivity();
    const research = jobs.find((j) => j.kind === 'research');
    // Mark the document being written in the side list.
    for (const d of state?.docs ?? []) {
      const a = document.querySelector(`#doc-list a[href="#doc/${d.id}"]`);
      if (!a) continue;
      const busy = !!research && (research.progress || '').toLowerCase().includes(`writing ${d.title.toLowerCase()}`);
      a.classList.toggle('writing', busy);
      if (busy) a.querySelector('.tag').textContent = 'writing…';
      else if (a.querySelector('.tag').textContent === 'writing…') a.querySelector('.tag').textContent = d.written ? '' : 'not written';
    }
    $('doc-working').hidden = !research;
    if (research) $('doc-working').innerHTML = `<span class="spin" aria-hidden="true"></span><span><b>Research is running.</b> ${esc(research.progress || '')}. This page updates when it finishes.</span>`;
    const ids = jobs.map((j) => j.id).join(',');
    // Something just finished: refresh the page so its results show up.
    if (runningIds && ids !== runningIds && $('view-job').hidden) {
      const before = runningIds.split(',');
      // Only on pages that just show results, so nobody loses half-typed edits.
      const safe = /^#?(today|folder\/|check|speed)?$/.test(location.hash.split('?')[0]) || location.hash.startsWith('#folder/') || (location.hash.startsWith('#doc/') && $('doc-edit-actions').hidden);
      if (safe && before.some((id) => !ids.split(',').includes(id))) route();
    }
    runningIds = ids;
    activityTimer = setTimeout(pollActivity, jobs.length ? 2500 : 15000);
  } else {
    activityTimer = setTimeout(pollActivity, 15000);
  }
}

// ---------------------------------------------------------------- Today

/** Show a one-off message (like "SEO agent started") in a note box, or hide the box when there's none. */
function showFlash(id) {
  const m = takeFlash();
  $(id).hidden = !m;
  $(id).textContent = m;
}

async function loadToday() {
  showView('today');
  showFlash('today-flash');
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
      ${d.meta.to ? `<p class="small">To ${esc(d.meta.to)} · <b dir="auto">${esc(d.meta.subject ?? '')}</b></p>` : d.meta.howToSend ? `<p class="small muted">${esc(d.meta.howToSend)}</p>` : ''}
      <p class="body" dir="auto">${esc(d.preview)}</p>
      <div class="acts">
        <select id="t-target">${fitting(d).map((p) => `<option value="${p.id}">${esc(p.label)}${p.configured ? '' : ' (dry run)'}</option>`).join('')}</select>
        <button id="t-approve">Approve</button>
        <a href="#draft/${d.id}"><button class="secondary">Read and edit</button></a>
        <span class="right"><button class="secondary" id="t-skip">Skip for today</button><button class="secondary" id="t-no">Not useful</button></span>
      </div>${more}</div>`;
    const firstLive = fitting(d).find((p) => p.configured && p.id !== 'export');
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
      <div class="kicker"><span class="sev ${f.severity}">${esc(f.severity)}</span><span>·</span><span>Site fix · ${esc(areaLabel(f.area))}</span></div>
      <h2>${esc(f.title)}</h2>
      <p class="why">${esc(f.url)}</p>
      <p class="body">${esc(f.why)}</p>
      <ol>${f.steps.map((s) => `<li>${esc(s)}</li>`).join('')}</ol>
      ${f.snippet ? `<pre><code>${esc(f.snippet)}</code></pre>` : ''}
      <div class="acts">
        <button id="t-done">Mark as fixed</button>
        ${f.snippet ? '<button class="secondary" id="t-copy">Copy code</button>' : ''}
        <span data-pr-issue="${esc(f.id)}"></span>
        <span class="right"><button class="secondary" id="t-skip">Skip for today</button></span>
      </div>${more}</div>`;
    if (window.plumeGeo) window.plumeGeo.wirePr(box);
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
      <h2 dir="auto">${esc(c.name)}${c.changes.some((x) => FINDING_AREA[x.kind]) ? ': news and posts' : c.changes.length === 1 ? ` ${esc(c.changes[0].text)}` : ' changed their site'}</h2>
      ${changeList(c.changes.length === 1 && !c.changes[0].items && !c.changes[0].url && !FINDING_AREA[c.changes[0].kind] ? [] : c.changes)}
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
  else if (item.kind === 'ai-gap') {
    const g = item.gap;
    box.innerHTML = `<div class="today">
      <div class="kicker"><span>AI visibility</span><span>·</span><span>${g.engines} assistant(s) asked</span></div>
      <h2 dir="auto">Asked “${esc(g.question)}”, AI assistants recommend ${esc(g.namedInstead.slice(0, 3).join(', '))} — not you</h2>
      <p class="why">Assistants repeat what they've read most often. A clear page that answers this question, and being mentioned on the sites they cite, is how you get named.</p>
      <div class="acts">
        <button id="t-seen">Got it</button>
        <a href="#ai"><button class="secondary">See all answers</button></a>
        <span class="right"><button class="secondary" id="t-skip">Skip for today</button></span>
      </div>${more}</div>`;
    $('t-seen').onclick = act(async () => post('/api/ai-visibility/gaps/done', { runId: g.runId, questionId: g.questionId }));
  }
  $('t-skip').onclick = act(async () => post('/api/today/skip', { key: item.key }));
}

const FINDING_AREA = { linkedin: 'LinkedIn', x: 'X', news: 'News' };
const sourceName = (url) => {
  try {
    const u = new URL(url);
    return u.hostname.replace(/^www\./, '') + (u.pathname.length > 1 ? u.pathname.replace(/\/$/, '') : '');
  } catch {
    return url;
  }
};

function changeList(changes) {
  if (!changes.length) return '';
  return `<ul class="change-list">${changes
    .map(
      (ch) =>
        `<li dir="auto">${FINDING_AREA[ch.kind] ? `<span class="area-tag">${FINDING_AREA[ch.kind]}</span> ` : ''}${esc(ch.text.replace(/^./, (x) => x.toUpperCase()))}${ch.items ? `: ${ch.items.map((i) => `<code>${esc(i)}</code>`).join(', ')}` : ''}${
          ch.url ? ` <a class="source" href="${esc(ch.url)}" target="_blank" rel="noopener" title="${esc(ch.url)}">${esc(sourceName(ch.url).slice(0, 60))} ↗</a>` : ''
        }</li>`,
    )
    .join('')}</ul>`;
}

const OUTCOME = { baseline: ['First look', 'Recorded as the starting point. Changes show from the next scan.'], changed: ['Changed', ''], unchanged: ['No change', 'Nothing new since the scan before.'], failed: ['Failed', ''] };

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

const AGENT_GLYPH = { seo: '⌕', writer: '✎', 'site-check': '⚙', social: '✦', reddit: '◉', influencer: '☺', links: '⛓', video: '▶' };
function agentLabel(id) {
  return { seo: 'SEO agent', writer: 'Writer', 'site-check': 'Site fixes', social: 'Social', reddit: 'Reddit', influencer: 'Influencers', links: 'Links', video: 'Video', chat: 'Chat' }[id] ?? id;
}
function kindLabel(k) {
  return (
    {
      blog_post: 'Blog post', landing_page: 'Landing page', article: 'Article', social_post: 'Social post',
      x_post: 'X post', x_thread: 'X thread', linkedin_post: 'LinkedIn post', facebook_post: 'Facebook post', reddit_reply: 'Reddit reply', reddit_post: 'Reddit post',
      outreach_email: 'Email', outreach_message: 'Message to send yourself', video_script: 'Video script',
    }[k] ?? k
  );
}
/** Only the destinations that can take this draft (no articles on X, no tweets on WordPress). */
function fitting(d) {
  return d.targets ? publishers.filter((p) => d.targets.includes(p.id)) : publishers;
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
      const cls = `folder${f.waiting && !f.working ? ' has-ready' : ''}${f.working ? ' is-working' : ''}`;
      return `<a class="${cls}" href="${href}"><span class="glyph" aria-hidden="true"><span class="sheet"></span><span class="front">${AGENT_GLYPH[f.id] ?? '•'}</span></span><span class="name">${esc(f.label)}</span>${status}</a>`;
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
  $('comp-watch-box').hidden = !c;
  if (c) {
    $('comp-check').hidden = !c.url;
    $('comp-checked').textContent = c.lastChecked ? `Website last checked ${when(c.lastChecked)}.` : c.url ? 'Not scanned yet. The first scan records how they look now; changes show from the second one.' : 'Add their website for the free website check. News and social work with just a name.';
    const so = c.socials ?? {};
    $('comp-socials').innerHTML = so.linkedin || so.x
      ? `Found on their site: ${[so.linkedin && `<a href="${esc(so.linkedin)}" target="_blank" rel="noopener">LinkedIn ↗</a>`, so.x && `<a href="${esc(so.x)}" target="_blank" rel="noopener">X ↗</a>`].filter(Boolean).join(' · ')}`
      : '';
    const scans = await api(`/api/competitors/${c.id}/scans`);
    $('comp-scans').innerHTML = scans.length
      ? scans
          .map((sc) => {
            const [label, note] = OUTCOME[sc.outcome] ?? [sc.outcome, ''];
            return `<li><div class="scan-head"><span class="outcome ${sc.outcome}">${label}</span><span>${sc.scope === 'site' ? 'Website' : 'News &amp; social'}</span><small>${esc(when(sc.at))}</small></div>${
              sc.findings.length ? changeList(sc.findings) : note ? `<p class="muted small">${note}</p>` : ''
            }</li>`;
          })
          .join('')
      : '<li class="muted small">No scans yet.</li>';
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
  $('comp-news').onclick = async () => {
    $('comp-news').disabled = true;
    $('comp-news').textContent = 'Searching…';
    try {
      const r = await post(`/api/competitors/${c.id}/scan-news`);
      context = null;
      const extra = r.suggested ? ` Spotted ${r.suggested} other competitor(s) — see the left column.` : '';
      await goTo(`#competitor/${c.id}`, (r.findings.length ? `Found ${r.findings.length} new item(s).` : r.outcome === 'baseline' ? 'First scan done — nothing recent found.' : 'Nothing new since last time.') + extra);
    } catch (err) {
      $('comp-status').textContent = err.message;
    } finally {
      $('comp-news').disabled = false;
      $('comp-news').textContent = 'Scan news & social';
    }
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
      $('comp-check').textContent = 'Check website';
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
  $('acc-fb').value = c.profiles.facebook ?? '';
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
  showFlash('folder-flash');
  // Already working: say so instead of offering a second run of the same agent.
  $('folder-run').disabled = !!f.working;
  $('folder-run').textContent = f.working ? 'Working…' : 'Find work and draft now';
  $('folder-run').title = f.working ? `Working now: ${f.working.replace(/^[^:]+:\s*/, '')}` : '';
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
  // The back link already names the agent, so the header only says what this is.
  $('draft-agent').textContent = draftBack === '#today' ? `${agentLabel(d.agent)} · ${kindLabel(d.kind)}` : kindLabel(d.kind);
  $('draft-title').value = d.title;
  $('draft-reason').hidden = !d.meta.reason;
  $('draft-reason-text').textContent = d.meta.reason ?? '';
  // Posts, messages and scripts are not web pages: no address or search snippet, and plain (not code) text.
  const short = SHORT_KINDS.includes(d.kind);
  $('view-draft').classList.toggle('short-draft', short);
  $('draft-seo').hidden = short;
  $('draft-slug').value = d.meta.slug ?? '';
  $('draft-meta').value = d.meta.metaDescription ?? '';
  updateMetaLen();
  $('draft-body').value = d.body;
  currentKind = d.kind;
  updateCount();
  loadPhotos(d);
  $('draft-target').innerHTML = fitting(d).map((p) => `<option value="${p.id}">${esc(p.label)}${p.configured ? '' : ' — dry run (no keys)'}</option>`).join('');
  if (d.target && fitting(d).some((p) => p.id === d.target)) $('draft-target').value = d.target;
  else {
    const firstLive = fitting(d).find((p) => p.configured && p.id !== 'export');
    if (firstLive) $('draft-target').value = firstLive.id;
  }
  const editable = d.status === 'draft' || d.status === 'failed';
  for (const el of ['draft-title', 'draft-slug', 'draft-meta', 'draft-body', 'draft-save', 'draft-approve', 'draft-target', 'draft-when']) $(el).disabled = !editable;
  $('draft-reject').textContent = d.status === 'rejected' ? 'Reopen' : 'Not useful';
  $('draft-reject').disabled = d.status === 'published' || d.status === 'approved';
  $('draft-status').innerHTML = statusLine(d);
  $('draft-events').innerHTML = d.events.map((e) => `<li>${esc(when(e.at))}: ${esc(e.to_status)}${e.note ? ` — ${esc(e.note)}` : ''}</li>`).join('');
  $('draft-sources').innerHTML = (d.meta.sources ?? []).map((s) => `<li><a href="${esc(s)}" target="_blank" rel="noopener">${esc(s)}</a></li>`).join('');
  if (window.plumeOutreach) window.plumeOutreach.wireDraft(d);
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

const SHORT_KINDS = ['social_post', 'x_post', 'x_thread', 'linkedin_post', 'facebook_post', 'reddit_reply', 'reddit_post', 'outreach_email', 'outreach_message', 'video_script'];
/** Hard limits, the same as the server checks (X counts links as 23 there, so this is a close guide). Facebook has none worth showing. */
const POST_LIMIT = { x_post: 280, linkedin_post: 3000, reddit_reply: 10000, reddit_post: 10000 };
let currentKind = null;

/** Grow the box with the text, so a short post isn't lost in a page of empty space. */
function fitBody() {
  const el = $('draft-body');
  if (!$('view-draft').classList.contains('short-draft')) return (el.style.height = '');
  el.style.height = 'auto';
  el.style.height = `${el.scrollHeight + 4}px`;
}

function updateCount() {
  fitBody();
  const show = ['social_post', 'x_post', 'linkedin_post', 'facebook_post', 'reddit_reply', 'reddit_post'].includes(currentKind);
  $('draft-count').hidden = !show;
  if (!show) return;
  const len = [...$('draft-body').value.trim()].length;
  const max = POST_LIMIT[currentKind];
  $('draft-count').className = `small draft-count ${max && len > max ? 'bad' : 'muted'}`;
  $('draft-count').textContent = max ? `${len.toLocaleString()} / ${max.toLocaleString()} characters${len > max ? ' — too long to post' : ''}` : `${len.toLocaleString()} characters${currentKind === 'facebook_post' && len > 500 ? ' — shorter posts usually get read more' : ''}`;
}

const PHOTO_KINDS = ['social_post', 'x_post', 'x_thread', 'linkedin_post', 'facebook_post'];
const MAX_PHOTOS = 4;

/** Photos on a post: shown in the order they will appear; added and removed while the post is still a draft. */
async function loadPhotos(d) {
  const box = $('draft-photos');
  box.hidden = !PHOTO_KINDS.includes(d.kind);
  if (box.hidden) return;
  const editable = d.status === 'draft' || d.status === 'failed';
  const msg = (text) => (($('photos-msg').hidden = !text), ($('photos-msg').className = 'small bad'), ($('photos-msg').textContent = text || ''));
  const render = (images) => {
    if (currentDraft !== d.id) return;
    $('photos-pick').hidden = !editable || images.length >= MAX_PHOTOS;
    $('photos-note').textContent = images.length
      ? `${images.length} of ${MAX_PHOTOS}${d.kind === 'x_thread' ? ' · shown on the first post of the thread' : ''}`
      : 'up to 4 · JPG, PNG or GIF, 5 MB each';
    $('photos-list').innerHTML = images.length
      ? images
          .map((im, i) => `<figure class="photo"><img src="${withSite(`/api/drafts/${d.id}/images/${im.name}`)}&t=${encodeURIComponent(im.at)}" alt="Photo ${i + 1}">${editable ? `<button class="photo-remove" data-photo="${esc(im.name)}" title="Remove this photo" aria-label="Remove photo ${i + 1}">×</button>` : ''}</figure>`)
          .join('')
      : `<p class="small muted">${editable ? 'No photos. Posts with a photo usually get noticed more.' : 'No photos.'}</p>`;
    for (const b of $('photos-list').querySelectorAll('[data-photo]'))
      b.onclick = async () => {
        try {
          render((await api(`/api/drafts/${d.id}/images/${encodeURIComponent(b.dataset.photo)}`, { method: 'DELETE' })).images);
          msg('');
        } catch (err) {
          msg(err.message);
        }
      };
  };
  $('photos-file').onchange = async () => {
    const files = [...$('photos-file').files];
    $('photos-file').value = '';
    msg('');
    let images = null;
    for (const file of files) {
      try {
        const res = await fetch(`/api/drafts/${d.id}/images`, { method: 'POST', headers: { 'x-plume-site': SITE, 'content-type': file.type || 'application/octet-stream' }, body: file });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || res.statusText);
        images = data.images;
      } catch (err) {
        msg(`${file.name}: ${err.message}`);
        break;
      }
    }
    render(images ?? (await api(`/api/drafts/${d.id}/images`)).images);
  };
  $('photos-list').innerHTML = '';
  try {
    render((await api(`/api/drafts/${d.id}/images`)).images);
  } catch (err) {
    msg(err.message);
  }
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

function renderAudit({ audit, today, history = [], fixed = [] }) {
  $('audit-empty').hidden = !!audit;
  $('audit-body').hidden = !audit;
  if (!audit) return;
  $('audit-score').textContent = audit.score;
  const trend = history.length > 1 ? ` · score over ${history.length} checks: ${history.slice(-6).map((h) => h.score).join(' → ')}` : '';
  $('audit-counts').textContent = `${audit.counts.critical} critical · ${audit.counts.warnings} warnings · ${audit.counts.passed} passed · ${audit.pagesChecked} pages · checked ${when(audit.at)}${trend}`;
  $('audit-fixed').innerHTML =
    fixed.map((a) => `<tr><td><small>${when(a.at)}</small></td><td>${esc(a.title)}</td><td>${esc(actionPage(a))}</td><td>${esc(PROBLEM_WORDS[a.problem] ?? '—')}</td><td>${beforeAfter(a, 'clicks', n)}</td><td>${beforeAfter(a, 'position', pos)}</td></tr>`).join('') ||
    '<tr><td colspan="6" class="muted">Nothing marked fixed yet.</td></tr>';
  $('audit-today').innerHTML = today.length
    ? today
        .map(
          (i) => `<div class="fix"><span class="sev ${i.severity}">${i.severity} · ${esc(areaLabel(i.area))}</span><h3>${esc(i.title)}</h3>
          <p class="muted">${esc(i.url)}</p><p>${esc(i.why)}</p><ol>${i.steps.map((s) => `<li>${esc(s)}</li>`).join('')}</ol>
          ${i.snippet ? `<pre><code>${esc(i.snippet)}</code></pre><button class="secondary" data-copy="${esc(i.snippet)}">Copy code</button> ` : ''}
          <button data-done="${esc(i.id)}">Mark as fixed</button> <span data-pr-issue="${esc(i.id)}"></span></div>`,
        )
        .join('')
    : '<p class="muted">Nothing left to fix today.</p>';
  if (window.plumeGeo) window.plumeGeo.wirePr($('audit-today'));
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
      ? '<button id="g-pull">Get latest data</button>'
      : `<a href="${withSite('/api/google/connect')}"><button>Connect Google</button></a>`;
  $('google-pick').hidden = !g.connected;
  $('google-pick').innerHTML = `Search Console: ${g.site ? esc(g.site) : 'none picked'} · Analytics: ${g.property ? esc(g.property) : 'none picked'} · <a href="#settings">Change in Settings</a>`;
  $('results-body').hidden = !g.connected;
  if (!g.connected) return;
  $('g-pull').onclick = pullGoogle;
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
  $('r-mine').innerHTML =
    r.published.map((m) => `<tr><td><a href="${esc(m.url)}" target="_blank" rel="noopener" dir="auto">${esc(m.title)}</a> <small class="muted">${m.publishedDaysAgo}d ago</small></td><td>${n(m.clicks)}</td><td>${n(m.impressions)}</td><td>${pos(m.position)}</td><td>${n(m.views)}</td><td dir="auto">${esc(m.topQuery ?? '—')}</td></tr>`).join('') || empty(6);
  $('r-queries').innerHTML = r.queries.map((q) => `<tr><td dir="auto">${esc(q.query)}</td><td>${n(q.clicks)}</td><td>${n(q.impressions)}</td><td>${(q.ctr * 100).toFixed(1)}%</td><td>${pos(q.position)}</td></tr>`).join('') || empty(5);
  $('r-pages').innerHTML = r.pages.map((p) => `<tr><td>${esc(p.page)}</td><td>${n(p.views)}</td><td>${p.engagement == null ? '—' : (p.engagement * 100).toFixed(0) + '%'}</td><td>${n(p.clicks)}</td></tr>`).join('') || empty(4);
  $('r-actions').innerHTML =
    (r.actions ?? []).map((a) => `<tr><td><small>${when(a.at)}</small></td><td>${esc(ACTION_WORDS[a.kind] ?? a.kind)}: ${esc(a.title)}${a.data?.prUrl ? ` <a href="${esc(a.data.prUrl)}" target="_blank" rel="noopener">PR</a>` : ''}</td><td>${esc(actionPage(a))}</td><td>${esc(PROBLEM_WORDS[a.problem] ?? '—')}</td><td>${beforeAfter(a, 'clicks', n)}</td><td>${beforeAfter(a, 'position', pos)}</td><td>${beforeAfter(a, 'views', n)}</td></tr>`).join('') ||
    empty(7);
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
  $('log-rows').innerHTML = logs.map((l) => `<tr class="level-${esc(l.level)}"><td><small>${when(l.at)}</small></td><td>${esc(l.source)}</td><td dir="auto">${esc(l.message)}</td></tr>`).join('') || '<tr><td colspan="3" class="muted">Nothing has happened on this website yet.</td></tr>';
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

// ---------------------------------------------------------------- top-bar numbers and the Analytics column

let summary = null;
let detailsTab = pref.get('analyticsTab', 'traffic');

/** Percent change, or null when there's nothing to compare against. */
const change = (now, before) => (now == null || !before ? null : ((now - before) / before) * 100);
function delta(pct, lowerIsBetter = false) {
  if (pct == null || !isFinite(pct)) return '';
  const up = pct >= 0;
  const good = lowerIsBetter ? !up : up;
  return `<i class="delta ${Math.abs(pct) < 0.5 ? '' : good ? 'up' : 'down'}">${up ? '↑' : '↓'} ${Math.abs(pct).toFixed(1)}%</i>`;
}
/** Google position moves in places, not percent: a smaller number is better, so the arrow shows the rank moving up. */
function placeDelta(now, before) {
  if (!now || !before) return '';
  const d = before - now;
  if (Math.abs(d) < 0.1) return '<i class="delta">no change</i>';
  return `<i class="delta ${d > 0 ? 'up' : 'down'}" title="was ${before.toFixed(1)}">${d > 0 ? '↑' : '↓'} ${Math.abs(d).toFixed(1)} ${Math.abs(d) >= 1.05 ? 'places' : 'place'}</i>`;
}
const money = (x) => (x == null ? '—' : `$${Number(x).toLocaleString(undefined, { maximumFractionDigits: x < 10 && x % 1 ? 2 : 0 })}`);

/** The period's numbers: Visitors and Revenue in the top bar, and the Analytics page. */
async function loadBarNumbers() {
  try {
    summary = await api(`/api/results/summary?days=${days === 7 ? 7 : 30}`);
  } catch {
    summary = null;
  }
  renderBarNumbers();
  if (location.hash.startsWith('#analytics')) renderDetails();
}

function renderBarNumbers() {
  const s = summary;
  if (!s?.from) return ($('bar-numbers').innerHTML = '');
  // Visitors when Analytics has them, else page views, else Google clicks.
  const [label, key] = s.now.users != null ? ['Visitors', 'users'] : s.now.views != null ? ['Views', 'views'] : ['Clicks', 'clicks'];
  $('bar-numbers').innerHTML = `
    <a href="#analytics/traffic" class="bar-stat" title="${label}, last ${s.days} days"><span class="lbl">${label}</span><b>${n(s.now[key])}</b>${delta(change(s.now[key], s.before[key]))}</a>
    ${s.now.revenue != null ? `<a href="#analytics/traffic" class="bar-stat" title="GA4 conversion value, last ${s.days} days"><span class="lbl">Revenue</span><b>${money(s.now.revenue)}</b></a>` : ''}`;
}

// ---- people on the site right now (GA4 realtime): the chip in the top bar and its panel
let live = null;
let liveBy = pref.get('liveBy', 'page');
let liveTimer = null;
const LIVE_BY = [['page', 'Page'], ['country', 'Country'], ['device', 'Device']];

async function pollLive() {
  clearTimeout(liveTimer);
  try {
    live = await api(`/api/analytics/live?by=${liveBy}`);
  } catch {
    live = null;
  }
  renderLive();
  // Once a minute is enough: the server keeps answers for 45 seconds to spare Google's realtime quota.
  if (live && !live.missing) liveTimer = setTimeout(pollLive, document.hidden ? 300_000 : 60_000);
}

const liveBars = (vals, cls) => {
  const max = Math.max(1, ...vals);
  return `<span class="${cls}" aria-hidden="true">${vals.map((v) => `<i class="${v ? '' : 'zero'}" style="height:${v ? Math.max(12, (100 * v) / max) : 6}%"></i>`).join('')}</span>`;
};

function renderLive() {
  const btn = $('live-btn');
  // No property picked or Google not connected: the Google pill already says so, keep the bar quiet.
  btn.hidden = !live || live.missing === 'google' || live.missing === 'property';
  if (btn.hidden) return closeLive();
  const failed = live.missing === 'error';
  btn.classList.toggle('off', failed || !live.now);
  btn.title = failed ? `Live visitors are unavailable: ${live.error}` : 'People on the site in the last 5 minutes';
  btn.innerHTML = `<span class="live-dot"></span><b>${failed ? '—' : n(live.now)}</b><span class="lbl">active now</span>${failed ? '' : liveBars(live.perMinute.slice(-15), 'spark-bars')}`;
  if (!$('live-panel').hidden) renderLivePanel();
}

function renderLivePanel() {
  const l = live;
  const host = state.site ? new URL(state.site).hostname : '';
  if (l.missing === 'error') {
    const apiOff = /analyticsdata\.googleapis\.com|Analytics Data API/i.test(l.error);
    $('live-panel').innerHTML = `<p class="lp-head">Live visitors</p><p class="muted small">${apiOff
      ? 'Google blocked the data: the <b>Google Analytics Data API</b> is switched off in your Google Cloud project. Turn it on, wait a few minutes, and this fills in by itself.'
      : `Google didn't answer: ${esc(l.error)}`}</p>`;
    return;
  }
  const max = Math.max(1, ...l.rows.map((r) => r.users));
  $('live-panel').innerHTML = `
    <p class="lp-head">Active users in last 5 minutes${host ? ` · ${esc(host)}` : ''}</p>
    <p class="lp-big">${n(l.now)}</p>
    <p class="lp-head">Active users, last 30 minutes <span class="faint">${n(l.total)}</span></p>
    ${liveBars(l.perMinute, 'lp-bars')}
    <div class="lp-axis"><span>-30 min</span><span>now</span></div>
    <div class="lp-table-head"><select id="live-by" aria-label="Break down by">${LIVE_BY.map(([v, t]) => `<option value="${v}"${v === liveBy ? ' selected' : ''}>${t}</option>`).join('')}</select><span>Visitors</span></div>
    ${l.rows.length
      ? l.rows.map((r) => `<div class="lp-row"><span class="lp-label" title="${esc(r.label)}">${esc(r.label)}</span><b>${n(r.users)}</b><i style="width:${(100 * r.users) / max}%"></i></div>`).join('')
      : '<p class="muted small lp-empty">Nobody in the last 30 minutes.</p>'}`;
  $('live-by').onchange = (e) => ((liveBy = e.target.value), pref.set('liveBy', liveBy), pollLive());
}

function closeLive() {
  $('live-panel').hidden = true;
  $('live-btn').setAttribute('aria-expanded', 'false');
}
$('live-btn').onclick = () => {
  const open = $('live-panel').hidden;
  if (!open) return closeLive();
  $('live-panel').hidden = false;
  $('live-btn').setAttribute('aria-expanded', 'true');
  renderLivePanel();
};
document.addEventListener('click', (e) => !e.target.closest('.live-wrap') && closeLive());
document.addEventListener('keydown', (e) => e.key === 'Escape' && closeLive());
document.addEventListener('visibilitychange', () => !document.hidden && live && !live.missing && pollLive());

/** The Analytics page. `#analytics/seo` opens a tab directly. */
async function loadAnalytics(tab) {
  if (['traffic', 'seo', 'links', 'geo'].includes(tab)) detailsTab = tab;
  showView('analytics');
  if (!summary) await loadBarNumbers();
  renderDetails();
}

function statCard(label, value, deltaHtml, foot) {
  return `<div class="stat-card"><span class="lbl">${label}</span><span class="val"><b>${value}</b>${deltaHtml}</span><span class="foot">${foot}</span></div>`;
}
/** A titled block in the column, with an optional link to the full page on the right. */
const block = (title, link, inner) => `<section class="an-block"><div class="an-block-head"><h3>${title}</h3>${link ? `<a href="${link[0]}">${link[1]} →</a>` : ''}</div>${inner}</section>`;
/** Small segmented switch inside a card. `items` is [[value, label], ...]. */
function seg(id, items, current) {
  return `<div class="tabs seg" id="${id}">${items.map(([v, label]) => `<button data-v="${v}" class="${v === current ? 'on' : ''}">${label}</button>`).join('')}</div>`;
}
function onSeg(id, fn) {
  for (const b of $(id).querySelectorAll('button')) b.onclick = () => fn(b.dataset.v);
}
const fmtDay = (d) => new Date(`${d}T00:00:00Z`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });
const shortDay = (iso) => new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
const emptyNote = (html) => `<p class="muted small details-empty">${html}</p>`;
/** Why Analytics numbers are missing, in words: not picked yet, or Google refused the last fetch. */
function gaMissing(s, what) {
  const a = s?.analytics;
  if (a?.property && a.error) {
    const api = /analyticsdata\.googleapis\.com|Analytics Data API/i.test(a.error);
    const link = a.error.match(/https:\/\/console\.developers\.google\.com\S+/)?.[0];
    return api
      ? `Analytics is connected, but Google blocked the data: the <b>Google Analytics Data API</b> is switched off in your Google Cloud project. ${link ? `<a href="${esc(link)}" target="_blank" rel="noopener">Turn it on</a>` : 'Turn it on'}, wait a few minutes, then press <b>Get latest data</b> on <a href="#results">Results</a>.`
      : `Analytics is connected, but the last fetch failed: ${esc(a.error)}. Try <b>Get latest data</b> on <a href="#results">Results</a>.`;
  }
  if (a?.property) return `Analytics is connected. Press <b>Get latest data</b> on <a href="#results">Results</a> to see ${what}.`;
  return `This needs Google Analytics. <a href="#settings">Pick your Analytics property</a> to see ${what}.`;
}
const NO_GOOGLE = 'No Google data yet. Connect Google under <a href="#settings">Settings</a>, then get the data on <a href="#results">Results</a>.';

async function renderDetails() {
  for (const b of $('details-tabs').querySelectorAll('button')) b.classList.toggle('on', b.dataset.tab === detailsTab);
  for (const b of $('an-range').querySelectorAll('button')) b.classList.toggle('on', Number(b.dataset.days) === days);
  const s = summary;
  // Links and GEO aren't tied to the 7/30-day period, so the switch hides there.
  const dated = detailsTab === 'traffic' || detailsTab === 'seo';
  $('an-range').hidden = !dated;
  history.replaceState(null, '', `#analytics/${detailsTab}`);
  $('details-range').textContent = s?.from && dated ? `${fmtDay(s.from)} – ${fmtDay(s.to)}` : '';
  const tab = detailsTab;
  const body = $('details-body');
  if (tab === 'traffic') return renderTraffic(body, s);
  if (tab === 'seo') return renderSeo(body, s);
  if (tab === 'links') return renderLinks(body);
  return renderGeo(body);
}

/** Traffic: who came, day by day, from where, and to which pages. Google search numbers live under SEO → Search. */
function renderTraffic(body, s) {
  if (!s?.from) return (body.innerHTML = emptyNote(NO_GOOGLE));
  const key = s.now.users != null ? 'users' : s.now.views != null ? 'views' : 'clicks';
  const perDay = { users: 'Visitors per day', views: 'Views per day', clicks: 'Clicks from Google per day' }[key];
  const cards = [
    s.now.users != null && statCard('Visitors', n(s.now.users), delta(change(s.now.users, s.before.users)), `was ${n(s.before.users ?? 0)}`),
    s.now.sessions != null && statCard('Sessions', n(s.now.sessions), delta(change(s.now.sessions, s.before.sessions)), s.now.users ? `${(s.now.sessions / s.now.users).toFixed(1)} per visitor` : ''),
    s.now.views != null && statCard('Page views', n(s.now.views), delta(change(s.now.views, s.before.views)), s.now.sessions ? `${(s.now.views / s.now.sessions).toFixed(1)} per session` : ''),
    s.now.revenue && statCard('Revenue', money(s.now.revenue), delta(change(s.now.revenue, s.before.revenue)), 'GA4 conversion value'),
  ].filter(Boolean);
  const total = s.sources.reduce((a, r) => a + r.users, 0);
  const sources = s.sources.length
    ? `<table class="bars-table"><thead><tr><th>Source</th><th></th><th>Visitors</th></tr></thead><tbody>${s.sources
        .map((r) => `<tr><td>${esc(r.channel)}</td><td class="bar-cell"><span style="width:${total ? (100 * r.users) / total : 0}%"></span></td><td>${n(r.users)}</td></tr>`)
        .join('')}</tbody></table>`
    : emptyNote(gaMissing(s, 'where visitors come from'));
  const max = Math.max(1, ...s.pages.map((p) => p.views));
  const pages = s.pages.length
    ? `<table class="bars-table"><thead><tr><th>Page</th><th></th><th>Views</th></tr></thead><tbody>${s.pages
        .map((p) => `<tr><td dir="auto" class="cut" title="${esc(p.page)}">${esc(p.page)}</td><td class="bar-cell"><span style="width:${(100 * p.views) / max}%"></span></td><td>${n(p.views)}</td></tr>`)
        .join('')}</tbody></table>`
    : emptyNote(gaMissing(s, 'page views'));
  body.innerHTML = `${cards.length ? `<div class="stat-cards an-gap">${cards.join('')}</div>` : ''}
    ${block(perDay, null, '<div class="chart-card"><div id="traffic-chart"></div></div>')}
    <div class="an-row">${block('Where they came from', null, `<div class="chart-card">${sources}</div>`)}${block('Top pages', null, `<div class="chart-card">${pages}</div>`)}</div>`;
  drawChart($('traffic-chart'), perDay, (key === 'clicks' ? s.daily : s.visits).map((d) => ({ x: d.date, y: d[key] ?? 0 })), s.before[key] ? s.before[key] / s.days : null);
}

/** SEO has three parts, one at a time: how Google search is going, how fast pages load, and what the on-page check found. */
let seoView = pref.get('seoView', 'search');
let searchKind = pref.get('searchKind', 'all');

async function renderSeo(body, s) {
  const [speed, check, res] = await Promise.all([
    api('/api/speed').catch(() => ({})),
    api('/api/audit').catch(() => ({})),
    s?.from ? api(`/api/results?days=${s.days === 7 ? 7 : 30}`).catch(() => null) : null,
  ]);
  if (detailsTab !== 'seo') return;
  const audit = check.audit;
  const slow = ['mobile', 'desktop'].some((d) => speed[d]?.headline);
  const views = [
    ['search', 'Search'],
    ['speed', `Speed${slow ? ' <span class="dot-bad"></span>' : ''}`],
    ['onpage', `On-page${audit ? ` · ${audit.score}` : ''}`],
  ];
  body.innerHTML = `<div class="sub-tabs">${seg('seo-view', views, seoView)}</div><div id="seo-main"></div>`;
  onSeg('seo-view', (v) => ((seoView = v), pref.set('seoView', v), renderSeo(body, s)));
  const main = $('seo-main');
  if (seoView === 'speed') return seoSpeed(main, speed, () => renderSeo(body, s));
  if (seoView === 'onpage') return seoOnPage(main, audit);
  seoSearch(main, s, res, () => renderSeo(body, s));
}

function seoSearch(main, s, res, again) {
  if (!s?.from) return (main.innerHTML = emptyNote(NO_GOOGLE));
  const ctr = (t) => (t.impressions ? (100 * t.clicks) / t.impressions : null);
  const c = ctr(s.now);
  // Brand searches are people who already know you: the site's own name, split into its parts.
  const host = state.site ? new URL(state.site).hostname.replace(/^www\./, '') : '';
  // "test4u" also yields "test" and "4u", so "teoria 4 u" counts as a brand search.
  const words = [host.split('.')[0], state.siteName]
    .filter(Boolean)
    .flatMap((x) => [x, ...x.split(/[\s.\-]+/), ...x.split(/(?<=\p{L})(?=\d)/u)])
    .map((x) => x.toLowerCase().replace(/\s+/g, ''))
    .filter((x) => x.length >= 3 || (x.length === 2 && /\d/.test(x)));
  const brand = (q) => words.some((w) => q.toLowerCase().replace(/\s+/g, '').includes(w));
  const all = res?.queries ?? [];
  const q = all.filter((x) => searchKind === 'all' || (searchKind === 'brand') === brand(x.query)).sort((a, b) => b.clicks - a.clicks).slice(0, 10);
  const near = res?.nearlyThere ?? [];
  main.innerHTML = `<div class="stat-cards an-gap">${[
    statCard('Seen in Google', n(s.now.impressions), delta(change(s.now.impressions, s.before.impressions)), 'times you showed up in results'),
    statCard('Clicks', n(s.now.clicks), delta(change(s.now.clicks, s.before.clicks)), c == null ? '' : `${c.toFixed(1)}% click rate`),
    statCard('Average position', s.now.position ? `#${s.now.position.toFixed(1)}` : '—', placeDelta(s.now.position, s.before.position), 'lower is better'),
  ].join('')}</div>
  <div class="an-row">
    ${block('Top searches', ['#rankings', 'Rankings'], `<div class="chart-card"><div class="chart-head">${seg('search-kind', [['all', 'All'], ['other', 'Not your name'], ['brand', 'Your name']], searchKind)}</div>${q.length
      ? `<table class="bars-table"><thead><tr><th>Search</th><th></th><th>Position</th><th>Clicks</th></tr></thead><tbody>${q
          .map((x) => `<tr><td dir="auto" class="cut">${esc(x.query)}</td><td></td><td>#${x.position.toFixed(0)}</td><td>${n(x.clicks)}</td></tr>`)
          .join('')}</tbody></table>`
      : emptyNote('No searches here yet.')}</div>`)}
    ${block('Nearly on page one', null, `<div class="chart-card"><p class="muted small card-note">Google shows you for these on page 2–3. The SEO agent writes for these first.</p>${near.length
      ? `<table class="bars-table"><thead><tr><th>Search</th><th></th><th>Position</th><th>Shown</th></tr></thead><tbody>${near
          .slice(0, 10)
          .map((o) => `<tr><td dir="auto" class="cut">${esc(o.keyword)}</td><td></td><td>#${pos(o.position)}</td><td>${n(o.impressions)}</td></tr>`)
          .join('')}</tbody></table>`
      : emptyNote('None right now.')}</div>`)}
  </div>`;
  onSeg('search-kind', (v) => ((searchKind = v), pref.set('searchKind', v), again()));
}

function seoSpeed(main, speed, again) {
  const r = speed[speedDevice] ?? speed.mobile ?? speed.desktop;
  if (!r) return (main.innerHTML = emptyNote('No speed check yet. <a href="#speed">Check speed</a>.'));
  const device = speed[speedDevice] ? speedDevice : r.strategy;
  const labels = { performance: 'Speed', accessibility: 'Access', bestPractices: 'Practices', seo: 'SEO' };
  main.innerHTML = `${r.headline
      ? `<div class="headline an-alert"><div><small class="muted">Fix first</small><div>${esc(r.headline)}</div></div><button class="secondary" id="seo-send">Send to SEO agent</button></div>`
      : `<div class="headline ok an-alert"><div>Every loading measurement passes on ${device === 'desktop' ? 'computers' : 'phones'}.</div></div>`}
    <div class="chart-card"><div class="chart-head"><span class="muted small">Google Lighthouse · ${shortDay(r.at)}</span>${seg('seo-device', [['mobile', 'Phone'], ['desktop', 'Computer']], device)}</div>
      <div class="gauges-row">${Object.entries(labels).map(([k, l]) => gauge(r.scores[k], l)).join('')}</div>
      <div class="vital-rows">${(r.vitals ?? []).map((v) => `<div class="vital-row"><span class="dot-${v.rating === 'good' ? 'good' : v.rating === 'poor' ? 'bad' : 'mid'}"></span><span>${esc(v.label)}</span><b class="${v.rating === 'good' ? 'good' : v.rating === 'poor' ? 'bad' : 'mid'}">${esc(v.display)}</b><span class="muted small">${esc(v.target)}</span></div>`).join('')}</div>
      <p class="small card-foot"><a href="#speed">What would help most →</a></p></div>`;
  if (r.headline)
    $('seo-send').onclick = async () => {
      try {
        await post('/api/speed/send', { strategy: device });
        $('seo-send').textContent = 'Added to today’s fixes';
        $('seo-send').disabled = true;
      } catch (err) {
        alert(err.message);
      }
    };
  onSeg('seo-device', (v) => {
    if (!speed[v]) return alert(`No ${v === 'desktop' ? 'computer' : 'phone'} speed check yet.`);
    speedDevice = v;
    pref.set('speedDevice', v);
    again();
  });
}

/** Problems grouped by kind, so 21 pages missing a description is one line, not 21. */
function seoOnPage(main, audit) {
  if (!audit) return (main.innerHTML = emptyNote('No site check yet. <a href="#check">Run a site check</a>.'));
  const LABEL = { critical: 'Critical', high: 'Important', medium: 'Warning', low: 'Minor' };
  const RANK = { critical: 0, high: 1, medium: 2, low: 3 };
  const groups = new Map();
  for (const i of audit.issues) {
    const g = groups.get(i.check) ?? { title: i.title, severity: i.severity, pages: new Set() };
    if (RANK[i.severity] < RANK[g.severity]) g.severity = i.severity;
    g.pages.add(i.url);
    groups.set(i.check, g);
  }
  // A grouped title can't name one page's count ("8 images without alt text"), so use the check's general name.
  const NAME = { 'images-missing-alt': 'Images without alt text', 'title-length': 'Title too short or too long', 'stale-page': 'Pages not updated in a long time', 'broken-page': 'Pages that return an error', 'duplicate-title': 'Same title on several pages', 'thin-content': 'Very little text on the page', 'meta-description-length': 'Description too short or too long' };
  const rows = [...groups.entries()].sort((a, b) => RANK[a[1].severity] - RANK[b[1].severity] || b[1].pages.size - a[1].pages.size);
  const count = (label, v, cls) => `<div class="op-row"><span>${label}</span><span class="chip ${cls}">${v}</span></div>`;
  main.innerHTML = `<div class="chart-card op-card">
    <div class="op-score"><b class="${band(audit.score)}">${audit.score}</b><span class="muted">On-page health · checked ${shortDay(audit.at)} · ${audit.pagesChecked} pages</span></div>
    <p class="muted small">Checks titles, descriptions, headings, images and links on your pages. Speed is under Speed.</p>
    ${count('Critical', audit.counts.critical, 'bad')}${count('Warnings', audit.counts.warnings, 'mid')}${count('Passed', audit.counts.passed, 'good')}
    <h4 class="op-sub">Top issues</h4>
    ${rows.map(([check, g]) => `<div class="op-row"><span>${esc(NAME[check] ?? g.title)} <span class="muted small">· ${g.pages.size} ${g.pages.size === 1 ? 'page' : 'pages'}</span></span><span class="chip ${g.severity === 'critical' ? 'bad' : g.severity === 'low' ? 'muted' : 'mid'}">${LABEL[g.severity]}</span></div>`).join('') || '<p class="muted small">No problems found.</p>'}
    <p class="small card-foot"><a href="#check">See every page and how to fix it →</a></p></div>`;
}

/** A score ring out of 100, coloured by Lighthouse's bands. */
function gauge(v, label) {
  const R = 26, C = 2 * Math.PI * R;
  return `<div class="gauge2"><svg viewBox="0 0 64 64" width="64" height="64" aria-hidden="true"><circle cx="32" cy="32" r="${R}" class="track"/><circle cx="32" cy="32" r="${R}" class="arc ${band(v)}" stroke-dasharray="${((C * v) / 100).toFixed(1)} ${C.toFixed(1)}" transform="rotate(-90 32 32)"/><text x="32" y="37" text-anchor="middle">${v}</text></svg><span>${esc(label)}</span></div>`;
}

async function renderLinks(body) {
  const o = await api('/api/outreach?kind=link').catch(() => null);
  if (detailsTab !== 'links') return;
  if (!o) return (body.innerHTML = emptyNote('Could not load link data.'));
  const c = o.counts;
  const open = o.contacts.filter((x) => x.status !== 'declined' && x.status !== 'linked');
  const unlinked = o.contacts.filter((x) => x.opportunity === 'unlinked-mention').length;
  const toRivals = o.contacts.filter((x) => x.opportunity === 'lists-competitors').length;
  body.innerHTML = `<div class="stat-cards an-gap">${[
    statCard('New links won', c.linked ?? 0, '', 'pages that now link to you'),
    statCard('Pages to ask', open.length, '', 'could link to you but don’t yet'),
    statCard('Mention you, no link', unlinked, '', 'the easiest ones to win'),
    statCard('Link to competitors', toRivals, '', 'but not to you'),
  ].join('')}</div>
    <div class="an-block"><div class="an-block-head"><h3>Where each page stands</h3><a href="#outreach">Link pages →</a></div><div class="chart-card">
      <div class="or-counts">${o.steps.map((st) => `<span class="pill">${esc({ found: 'Found', drafted: 'Message drafted', contacted: 'Contacted', replied: 'Replied', linked: 'Linked to you', declined: 'Said no' }[st] ?? st)} · ${c[st] ?? 0}</span>`).join('')}</div>
      <div class="vital-rows">${
        open
          .slice(0, 8)
          .map((x) => `<div class="vital-row"><span class="dot-${x.opportunity === 'unlinked-mention' ? 'good' : 'mid'}"></span><a href="${esc(x.url)}" target="_blank" rel="noopener" dir="auto">${esc(x.name)}</a><span></span><span class="muted small path">${esc(x.opportunity === 'unlinked-mention' ? 'mentions you' : 'links to competitors')}</span></div>`)
          .join('') || `<p class="muted small">No pages found yet. Plume looks for them on <a href="#outreach">Outreach → Link pages</a>.</p>`
      }</div></div></div>
    ${emptyNote('Plume only counts pages it has read itself. It doesn’t track every site on the web that links to you yet.')}`;
}

async function renderGeo(body) {
  const [v, gaps] = await Promise.all([api('/api/ai-visibility').catch(() => null), api('/api/ai-visibility/gaps').catch(() => [])]);
  if (detailsTab !== 'geo') return;
  const s = v?.summary;
  if (!s) return (body.innerHTML = emptyNote('Find out whether ChatGPT, Claude and Gemini name you when customers ask. Start on <a href="#ai">AI visibility</a>.'));
  const pct = (a, b) => (b ? Math.round((100 * a) / b) : 0);
  const trend = s.trend.length > 1 ? s.trend[s.trend.length - 1].score - s.trend[s.trend.length - 2].score : null;
  const voice = s.shareOfVoice.slice(0, 6);
  const maxVoice = Math.max(1, ...voice.map((x) => x.answers));
  body.innerHTML = `<div class="stat-cards an-gap">${[
    statCard('Named in AI answers', `${s.overall.score}%`, trend == null ? '' : `<i class="delta ${trend > 0 ? 'up' : trend < 0 ? 'down' : ''}">${trend >= 0 ? '↑' : '↓'} ${Math.abs(trend)} pts</i>`, `${s.overall.mentioned} of ${s.overall.answered} answers`),
    statCard('Gaps to fix', Array.isArray(gaps) ? gaps.length : 0, '', 'questions where rivals are named and you aren’t'),
  ].join('')}</div>
    <div class="an-row an-top"><div class="an-block"><div class="an-block-head"><h3>By assistant</h3><span class="muted small">checked ${esc(when(s.at))}</span></div><div class="chart-card">
      <div class="vital-rows">${s.perEngine.map((e) => { const p = pct(e.mentioned, e.answered); return `<div class="vital-row"><span class="dot-${p >= 50 ? 'good' : p >= 20 ? 'mid' : 'bad'}"></span><span>${esc(e.label)}</span><b>${p}%</b><span class="muted small">${e.mentioned}/${e.answered}${e.avgPosition ? ` · avg #${e.avgPosition}` : ''}</span></div>`; }).join('')}</div></div></div>
    <div class="an-block"><div class="an-block-head"><h3>Who gets recommended</h3><a href="#ai">Every answer →</a></div><div class="chart-card">
      <table class="bars-table"><tbody>${voice.map((x) => `<tr class="${x.you ? 'you' : ''}"><td dir="auto">${x.you ? '<b>' : ''}${esc(x.name)}${x.you ? '</b>' : ''}</td><td class="bar-cell"><span style="width:${(100 * x.answers) / maxVoice}%"></span></td><td>${x.answers}</td></tr>`).join('')}</tbody></table></div></div></div>`;
}

/** A plain SVG line chart: this period as a line, last period's daily average as a dashed line. */
function drawChart(box, title, points, avg) {
  const W = Math.max(320, box.clientWidth || 1000), H = 220, L = 36, B = 22, T = 18;
  const max = Math.max(1, avg ?? 0, ...points.map((p) => p.y));
  // Round the top up to a tidy number so the line fills the chart instead of hugging the floor.
  const mag = 10 ** Math.floor(Math.log10(max));
  const top = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((t) => t >= max) ?? 10 * mag;
  const x = (i) => L + (i * (W - L - 8)) / Math.max(1, points.length - 1);
  const y = (v) => T + (1 - v / top) * (H - T - B);
  const path = points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.y).toFixed(1)}`).join('');
  const area = `${path}L${x(points.length - 1)},${y(0)}L${x(0)},${y(0)}Z`;
  const step = Math.ceil(points.length / 8);
  const last = points[points.length - 1];
  box.innerHTML = `<svg viewBox="0 0 ${W} ${H}" class="line-chart" role="img" aria-label="${esc(title)}">
    ${(top < 2 ? [0, 1] : [0, 0.5, 1]).map((f) => `<line x1="${L}" x2="${W}" y1="${y(top * f)}" y2="${y(top * f)}" class="grid"/><text x="${L - 6}" y="${y(top * f) + 4}" class="axis" text-anchor="end">${Math.round(top * f).toLocaleString()}</text>`).join('')}
    ${avg != null ? `<line x1="${L}" x2="${W - 8}" y1="${y(avg)}" y2="${y(avg)}" class="avg"/>` : ''}
    <path d="${area}" class="area"/><path d="${path}" class="line"/>
    <circle cx="${x(points.length - 1)}" cy="${y(last.y)}" r="4" class="dot"/>
    <text x="${x(points.length - 1)}" y="${y(last.y) - 9}" class="axis strong" text-anchor="end">${fmtDay(last.x)} · ${n(last.y)}</text>
    ${points.map((p, i) => ((i % step === 0 && points.length - 1 - i >= step / 2) || i === points.length - 1 ? `<text x="${x(i)}" y="${H - 4}" class="axis" text-anchor="${i === 0 ? 'start' : i === points.length - 1 ? 'end' : 'middle'}">${p.x.slice(5).replace('-', '/').replace(/^0/, '').replace('/0', '/')}</text>` : '')).join('')}
  </svg>
  <div class="chart-legend muted small"><span><span class="lg-line"></span>This period</span>${avg != null ? `<span><span class="lg-dash"></span>Previous ${summary.days}-day average</span>` : ''}</div>`;
}

for (const b of $('details-tabs').querySelectorAll('button')) b.onclick = () => ((detailsTab = b.dataset.tab), pref.set('analyticsTab', detailsTab), renderDetails());
for (const b of $('an-range').querySelectorAll('button'))
  b.onclick = () => {
    days = Number(b.dataset.days);
    pref.set('days', days);
    loadBarNumbers();
  };
// The window is resized: redraw so the charts keep their width.
let resizeTimer;
window.addEventListener('resize', () => (clearTimeout(resizeTimer), (resizeTimer = setTimeout(() => location.hash.startsWith('#analytics') && detailsTab === 'traffic' && renderDetails(), 150))));

// ---------------------------------------------------------------- tour

const TOUR = [
  { el: 'col-left', title: 'What your agents know', text: 'Every agent reads these documents before it writes anything. Correct something here once and every agent gets it right from then on.' },
  { el: 'today-card', title: 'Today', text: 'Your agents’ work arrives here one card at a time: drafts, site fixes and speed problems, most important first. Approve, edit, skip it for today, or mark it not useful so the agent learns.' },
  { el: 'folders', title: 'Agents', text: 'One folder per agent. “Ready” means work is waiting for you, a pulsing dot means it is working right now. Open a folder to see everything it has made.' },
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
    const r = await api('/api/profiles', { method: 'PUT', body: JSON.stringify({ x: $('acc-x').value, linkedin: $('acc-li').value, facebook: $('acc-fb').value }) });
    context = null;
    $('acc-x').value = r.x ? `@${r.x}` : '';
    $('acc-li').value = r.linkedin;
    $('acc-fb').value = r.facebook;
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
$('draft-body').addEventListener('input', updateCount);
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
$('run-all').onclick = runAllAgents;
$('activity').onclick = () => {
  const open = $('activity-list').hidden;
  $('activity-list').hidden = !open;
  $('activity').setAttribute('aria-expanded', String(open));
};
document.addEventListener('click', (e) => !e.target.closest('.activity-wrap') && closeActivity());
document.addEventListener('keydown', (e) => e.key === 'Escape' && closeActivity());
$('tour-next').onclick = () => (tourStep + 1 < TOUR.length ? showTour(tourStep + 1) : endTour());
$('tour-back').onclick = () => showTour(Math.max(0, tourStep - 1));
$('tour-close').onclick = endTour;
document.addEventListener('keydown', (e) => e.key === 'Escape' && !$('tour').hidden && endTour());

window.onhashchange = () => {
  if (location.hash === '#today') draftBack = '#today';
  route().catch((err) => alert(err.message));
};
pollActivity();
route()
  .then(() => {
    if (state?.site && !pref.get('tourDone', false)) setTimeout(() => showTour(0), 600);
  })
  .catch((err) => alert(err.message));

// ---------------------------------------------------------------- company settings window

let companySaved = '';
function companyCount() {
  const t = $('company-instr').value;
  $('company-count').textContent = `${t.length.toLocaleString()} / 4,000`;
  $('company-save').disabled = t.trim() === companySaved;
}
$('company-btn').onclick = async () => {
  $('company-msg').textContent = '';
  $('company-instr').value = companySaved = (await api('/api/instructions')).text;
  companyCount();
  $('company').showModal();
};
$('company-close').onclick = () => $('company').close();
$('company').onclick = (e) => e.target === $('company') && $('company').close();
$('company-instr').oninput = companyCount;
$('company-save').onclick = async () => {
  try {
    const r = await api('/api/instructions', { method: 'PUT', body: JSON.stringify({ text: $('company-instr').value }) });
    $('company-instr').value = companySaved = r.text;
    companyCount();
    $('company-msg').textContent = r.text ? 'Saved. Every agent follows these from its next run.' : 'Cleared.';
  } catch (err) {
    $('company-msg').textContent = err.message;
  }
};
$('company-sync').onclick = () => {
  if (!confirm(`Re-scan ${state.site} and rewrite all product documents? Edits you made to them will be replaced.`)) return;
  $('company').close();
  runResearch({});
};
$('company-url').onclick = async () => ($('company').close(), await goTo('#settings'), $('set-url').focus());

// ---------------------------------------------------------------- settings (this website)

async function loadSettings() {
  showView('settings');
  $('settings-site').textContent = state.siteName;
  $('set-name').value = state.siteName;
  $('set-url').value = state.site || '';
  $('set-general-status').textContent = '';
  const [ints, g] = await Promise.all([api('/api/integrations'), api('/api/google')]);
  $('set-publish').innerHTML = ints.filter((i) => i.group === 'publishing').map(integrationCard).join('');
  $('set-social').innerHTML = ints.filter((i) => i.group === 'social').map(integrationCard).join('');
  $('set-outreach').innerHTML = ints.filter((i) => i.group === 'outreach').map(integrationCard).join('');
  const gInt = ints.find((i) => i.id === 'google');
  // One Google app for all of Plume (set up once in .env), so people only press Connect. A website's own app is for testing only.
  $('set-analytics').innerHTML = `<div class="int-card" id="g-signin"><div class="int-head"><strong>Google Analytics and Search Console</strong>
    <span class="${g.connected ? 'good' : 'muted'} small">${g.connected ? 'Connected' : 'Not connected'}</span></div>
    <p class="muted small">${g.connected
      ? 'Pick which Search Console site and Analytics property belong to this website.'
      : 'See which searches bring people to your site and what they do there. Plume only reads your data, it never changes anything.'}</p>
    <p class="actions-row">${!g.configured
      ? '<span class="warn small">Google sign-in isn\'t set up in this copy of Plume yet. Whoever runs it adds GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET to the .env file once.</span>'
      : g.connected
        ? '<button id="g-check" class="secondary">Test connection</button> <button id="g-out" class="secondary">Disconnect</button>'
        : `<a href="${withSite('/api/google/connect')}"><button>Connect with Google</button></a>`}
      <span id="g-msg" class="small"></span></p>
    ${g.connected ? `<div class="seo-fields">
      <label>Search Console site <select id="gsc-site"><option value="">${g.site ? esc(g.site) : '— none —'}</option></select></label>
      <label>Analytics property <select id="ga-prop"><option value="">${g.property ? esc(g.property) : '— none —'}</option></select></label>
    </div>` : ''}
    <ul id="g-checks" class="item-list"></ul></div>
    <details class="small g-advanced"><summary>Advanced: use a different Google app for this website</summary>
      <p class="muted small">Only for testing. Leave empty to use Plume's own.</p>${integrationCard(gInt)}</details>`;
  for (const card of document.querySelectorAll('.int-card[data-int]')) wireIntegration(card);
  if (window.plumePhone) window.plumePhone.settings(ints);
  if (g.connected) pickGoogle(g);
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

// Which Search Console site and Analytics property this website reads from.
async function pickGoogle(g) {
  try {
    const opts = await api('/api/google/options');
    $('gsc-site').innerHTML = '<option value="">— none —</option>' + opts.sites.map((s) => `<option ${s === g.site ? 'selected' : ''}>${esc(s)}</option>`).join('');
    $('ga-prop').innerHTML = '<option value="">— none —</option>' + opts.properties.map((p) => `<option value="${esc(p.id)}" ${p.id === g.property ? 'selected' : ''}>${esc(p.name)} (${esc(p.id)})</option>`).join('');
  } catch (err) {
    $('g-msg').textContent = `Couldn't list your Google sites: ${err.message}`;
    return;
  }
  const save = async (body) => {
    await api('/api/google/selection', { method: 'PUT', body: JSON.stringify(body) });
    $('g-msg').textContent = 'Saved. Press Get latest data on Results to fetch it.';
  };
  $('gsc-site').onchange = () => save({ site: $('gsc-site').value });
  $('ga-prop').onchange = () => save({ property: $('ga-prop').value });
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
    ${i.link ? `<p><a href="${esc(i.link.url)}" target="_blank" rel="noopener"><button type="button" class="secondary">${esc(i.link.label)}</button></a></p>` : ''}
    <div class="form">${fields}</div>
    <p class="actions-row"><button data-act="save">Save</button> <button data-act="test" class="secondary" ${i.testable ?? i.connected ? '' : 'disabled'}>Test</button>
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
    await api(`/api/sites/${encodeURIComponent(SITE)}`, { method: 'PUT', body: JSON.stringify({ name: $('set-name').value, url: $('set-url').value }) });
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
