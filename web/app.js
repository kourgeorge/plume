const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const api = async (path, opts = {}) => {
  const res = await fetch(path, { headers: { 'content-type': 'application/json' }, ...opts });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
};
const post = (path, body = {}) => api(path, { method: 'POST', body: JSON.stringify(body) });

let state = null;
let currentDoc = null;
let currentDraft = null;
let publishers = [];

function show(id) {
  for (const s of document.querySelectorAll('main > section')) s.hidden = s.id !== id;
  for (const a of document.querySelectorAll('nav a')) a.classList.toggle('active', a.hash === `#${id}`);
}

async function refresh() {
  state = await api('/api/state');
  $('key-warning').hidden = state.hasApiKey;
  if (!state.site) return show('onboard');
  updateInboxCount();
  const page = location.hash.slice(1) || 'inbox';
  if (page === 'usage') return loadUsage();
  if (page === 'logs') return loadLogs();
  if (page === 'agents') return loadAgents();
  if (page === 'check') return loadAudit();
  if (page === 'profile') return loadProfile();
  if (page.startsWith('results')) return loadResults();
  return loadInbox();
}

async function waitForJob(jobId, label) {
  show('job');
  $('job').querySelector('h2').textContent = label;
  for (;;) {
    const job = await api(`/api/jobs/${jobId}`);
    $('job-progress').textContent = job.progress || '';
    if (job.status === 'done') return;
    if (job.status === 'failed') throw new Error(job.error);
    await new Promise((r) => setTimeout(r, 1500));
  }
}

// ---- profile ----
async function loadProfile() {
  $('site-label').textContent = state.site;
  renderDocList();
  show('profile');
  await openDoc(currentDoc ?? state.docs.find((d) => d.written)?.id ?? state.docs[0].id);
}

function renderDocList() {
  $('doc-list').innerHTML = '';
  for (const d of state.docs) {
    const li = document.createElement('li');
    li.textContent = d.written ? d.title : `${d.title} (not written)`;
    li.className = (d.id === currentDoc ? 'active ' : '') + (d.written ? '' : 'missing');
    li.onclick = () => openDoc(d.id);
    $('doc-list').append(li);
  }
}

async function openDoc(id) {
  currentDoc = id;
  renderDocList();
  const doc = await api(`/api/profile/${id}`);
  $('doc-title').textContent = state.docs.find((d) => d.id === id).title;
  $('doc-body').value = doc.body;
  $('save-status').textContent = '';
}

async function runResearch(body) {
  const { jobId } = await post('/api/research', body);
  try {
    await waitForJob(jobId, 'Researching…');
  } catch (err) {
    alert(`Research stopped: ${err.message}`);
  }
  location.hash = '#profile';
  await refresh();
}

// ---- inbox ----
async function updateInboxCount() {
  const waiting = await api('/api/drafts?status=draft');
  $('inbox-count').hidden = !waiting.length;
  $('inbox-count').textContent = waiting.length;
}

async function loadInbox() {
  show('inbox');
  publishers = await api('/api/publishers');
  const drafts = await api(`/api/drafts?status=${$('inbox-filter').value}`);
  $('draft-list').innerHTML = drafts.length
    ? drafts.map((d) => `<li data-id="${d.id}" class="${d.id === currentDraft ? 'active' : ''}">${esc(d.title)}<small>${esc(d.agent)} · ${d.words} words${d.dryRun ? ' · dry run' : ''}</small></li>`).join('')
    : '<li class="muted">Nothing here.</li>';
  for (const li of $('draft-list').querySelectorAll('li[data-id]')) li.onclick = () => openDraft(Number(li.dataset.id));
  if (currentDraft && drafts.some((d) => d.id === currentDraft)) openDraft(currentDraft);
  else if (drafts[0]) openDraft(drafts[0].id);
  else $('draft-view').hidden = true;
}

async function openDraft(id) {
  currentDraft = id;
  for (const li of $('draft-list').querySelectorAll('li[data-id]')) li.classList.toggle('active', Number(li.dataset.id) === id);
  const d = await api(`/api/drafts/${id}`);
  $('draft-view').hidden = false;
  $('draft-title').value = d.title;
  $('draft-reason').textContent = d.meta.reason ? `Why: ${d.meta.reason}` : '';
  $('draft-slug').value = d.meta.slug ?? '';
  $('draft-meta').value = d.meta.metaDescription ?? '';
  updateMetaLen();
  $('draft-body').value = d.body;
  $('draft-target').innerHTML = publishers
    .map((p) => `<option value="${p.id}">${esc(p.label)}${p.configured ? '' : ' — dry run (no keys)'}</option>`)
    .join('');
  if (d.target) $('draft-target').value = d.target;
  const editable = d.status === 'draft' || d.status === 'failed';
  for (const el of ['draft-title', 'draft-slug', 'draft-meta', 'draft-body', 'draft-save', 'draft-approve', 'draft-target', 'draft-when']) $(el).disabled = !editable;
  $('draft-reject').textContent = d.status === 'rejected' ? 'Reopen' : 'Reject';
  $('draft-reject').disabled = d.status === 'published' || d.status === 'approved';
  $('draft-status').innerHTML = statusLine(d);
  $('draft-events').innerHTML = d.events.map((e) => `<li>${esc(new Date(e.at).toLocaleString())}: ${esc(e.to_status)}${e.note ? ` — ${esc(e.note)}` : ''}</li>`).join('');
  $('draft-sources').innerHTML = (d.meta.sources ?? []).map((s) => `<li><a href="${esc(s)}" target="_blank" rel="noopener">${esc(s)}</a></li>`).join('');
}

function statusLine(d) {
  if (d.status === 'published') {
    const where = d.publishedUrl ? ` <a href="${esc(d.publishedUrl)}" target="_blank" rel="noopener">${esc(d.publishedUrl)}</a>` : '';
    return d.dryRun ? `Dry run: ${esc(d.target)} isn't connected, so the files were saved instead.${where}` : `Published to ${esc(d.target)}.${where}`;
  }
  if (d.status === 'failed') return `Publishing failed: ${esc(d.error)}`;
  if (d.status === 'approved') return `Scheduled for ${esc(new Date(d.scheduledFor).toLocaleString())} on ${esc(d.target)}.`;
  return '';
}

function updateMetaLen() {
  const n = $('draft-meta').value.length;
  $('meta-len').textContent = `${n} chars${n > 155 ? ' — too long' : n && n < 120 ? ' — a bit short' : ''}`;
}

async function saveDraft() {
  await api(`/api/drafts/${currentDraft}`, {
    method: 'PUT',
    body: JSON.stringify({ title: $('draft-title').value, body: $('draft-body').value, meta: { slug: $('draft-slug').value, metaDescription: $('draft-meta').value } }),
  });
}

// ---- agents ----
async function loadAgents() {
  show('agents');
  const agents = await api('/api/agents');
  $('agent-cards').innerHTML = agents
    .map((a) => `<div class="card"><h2>${esc(a.label)}</h2><p class="muted">${esc(a.description)}</p><button data-agent="${a.id}">Find work and draft</button></div>`)
    .join('');
  for (const b of $('agent-cards').querySelectorAll('button')) {
    b.onclick = async () => {
      try {
        const { jobId } = await post(`/api/agents/${b.dataset.agent}/run`);
        await waitForJob(jobId, 'Agent at work…');
        location.hash = '#inbox';
        $('inbox-filter').value = 'draft';
      } catch (err) {
        alert(err.message);
      }
      refresh();
    };
  }
}

// ---- site check ----
function renderAudit({ audit, today }) {
  $('audit-empty').hidden = !!audit;
  $('audit-body').hidden = !audit;
  if (!audit) return;
  $('audit-score').textContent = audit.score;
  $('audit-counts').textContent = `${audit.counts.critical} critical · ${audit.counts.warnings} warnings · ${audit.counts.passed} passed · ${audit.pagesChecked} pages · checked ${new Date(audit.at).toLocaleString()}`;
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
  for (const b of $('audit-today').querySelectorAll('[data-done]')) b.onclick = async () => (await post('/api/audit/done', { id: b.dataset.done }), (b.textContent = 'Marked fixed'), (b.disabled = true));
  $('audit-rows').innerHTML = audit.issues.map((i) => `<tr><td><span class="sev ${i.severity}">${i.severity}</span></td><td>${esc(i.title)}</td><td>${esc(new URL(i.url).pathname)}</td></tr>`).join('');
}

async function loadAudit() {
  show('check');
  renderAudit(await api('/api/audit'));
}

// ---- results ----
const n = (x) => (x == null ? '—' : Number(x).toLocaleString());
const pos = (x) => (x == null || !x ? '—' : Number(x).toFixed(1));

async function loadResults() {
  show('results');
  const msg = new URLSearchParams(location.hash.split('?')[1] || '').get('google');
  const g = await api('/api/google');
  $('google-setup').hidden = g.configured;
  $('google-msg').textContent = msg ? `Google: ${msg}` : g.lastPull ? pullLine(g.lastPull) : '';
  $('google-actions').innerHTML = !g.configured ? '' : g.connected
    ? '<button id="g-pull">Get latest data</button> <button id="g-off" class="secondary">Disconnect</button>'
    : '<a href="/api/google/connect"><button>Connect Google</button></a>';
  $('google-pick').hidden = !g.connected;
  $('results-body').hidden = !g.connected;
  if (!g.connected) return;
  $('g-pull').onclick = async () => {
    $('g-pull').disabled = true;
    $('google-msg').textContent = 'Getting data from Google…';
    $('google-msg').textContent = pullLine(await post('/api/google/pull'));
    renderResults(await api('/api/results'));
    $('g-pull').disabled = false;
  };
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
  renderResults(await api('/api/results'));
}

function pullLine(p) {
  const part = (label, s, what) => (s.error ? `${label} failed: ${s.error}` : (s.site ?? s.property) ? `${label}: ${n(s.rows)} ${what}` : `${label}: not selected`);
  return `Last update ${new Date(p.at).toLocaleString()} · ${part('Search Console', p.searchConsole, 'rows')} · ${part('Analytics', p.analytics, 'pages')}`;
}

function renderResults(r) {
  const empty = (cols) => `<tr><td colspan="${cols}" class="muted">No data yet.</td></tr>`;
  $('r-near').innerHTML = r.nearlyThere.map((o) => `<tr><td>${esc(o.keyword)}</td><td>${n(o.impressions)}</td><td>${pos(o.position)}</td></tr>`).join('') || empty(3);
  $('r-mine').innerHTML = r.published.map((m) => `<tr><td><a href="${esc(m.url)}" target="_blank" rel="noopener">${esc(m.title)}</a> <small class="muted">${m.publishedDaysAgo}d ago</small></td><td>${n(m.clicks)}</td><td>${n(m.impressions)}</td><td>${pos(m.position)}</td><td>${n(m.views)}</td><td>${esc(m.topQuery ?? '—')}</td></tr>`).join('') || empty(6);
  $('r-queries').innerHTML = r.queries.map((q) => `<tr><td>${esc(q.query)}</td><td>${n(q.clicks)}</td><td>${n(q.impressions)}</td><td>${(q.ctr * 100).toFixed(1)}%</td><td>${pos(q.position)}</td></tr>`).join('') || empty(5);
  $('r-pages').innerHTML = r.pages.map((p) => `<tr><td>${esc(p.page)}</td><td>${n(p.views)}</td><td>${p.engagement == null ? '—' : (p.engagement * 100).toFixed(0) + '%'}</td><td>${n(p.clicks)}</td></tr>`).join('') || empty(4);
  $('r-notes').textContent = r.notes ?? 'Nothing yet — agents will be told once there is data.';
}

// ---- timetable and logs ----
const when = (iso) => (iso ? new Date(iso).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' }) : '—');
const CRON_WORDS = { '* * * * *': 'every minute', '7 6 * * *': 'daily 06:07', '47 5 * * *': 'daily 05:47', '17 6 * * *': 'daily 06:17', '53 3 * * *': 'daily 03:53', '13 7 * * 1-5': 'weekdays 07:13' };

async function loadLogs() {
  show('logs');
  const [tasks, logs] = await Promise.all([api('/api/tasks'), api('/api/logs?limit=200')]);
  $('task-rows').innerHTML = tasks
    .map((t) => `<tr>
      <td><input type="checkbox" data-toggle="${esc(t.id)}" ${t.enabled ? 'checked' : ''}></td>
      <td>${esc(t.label)}${t.costsMoney ? ' <small>$</small>' : ''}${t.costsMoney ? ` <small>· <input type="number" min="1" max="10" value="${t.limit ?? 1}" data-limit="${esc(t.id)}" style="width:52px"> per run</small>` : ''}</td>
      <td><input value="${esc(t.cron)}" data-cron="${esc(t.id)}" title="${esc(CRON_WORDS[t.cron] ?? 'minute hour day month weekday')}" style="width:120px"> <small>${esc(CRON_WORDS[t.cron] ?? '')}</small></td>
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

// ---- usage ----
async function loadUsage() {
  show('usage');
  const u = await api('/api/usage');
  $('usage-total').textContent = `${u.total.calls} AI calls so far, $${u.total.cost.toFixed(2)} in total.`;
  const b = u.budget;
  const pct = b.limit ? Math.min(100, (100 * b.spent) / b.limit) : 0;
  $('budget-line').textContent = b.limit ? `$${b.spent.toFixed(2)} of $${b.limit.toFixed(2)} used this month` : `$${b.spent.toFixed(2)} used this month (no limit)`;
  $('budget-bar').style.width = `${pct}%`;
  $('budget-bar').className = pct >= 80 ? 'high' : '';
  $('budget-reset').textContent = `${b.remaining != null ? `$${b.remaining.toFixed(2)} left · ` : ''}starts again ${new Date(b.resets).toLocaleDateString()}`;
  $('budget-limit').value = b.limit;
  const l = state.llm;
  const search = { server: "Claude's built-in search", local: 'Plume runs searches itself (Tavily)', off: 'off — add TAVILY_API_KEY to .env to turn it on' }[l.webSearch];
  $('usage-llm').textContent = `Calls go to ${l.endpoint} (${l.auth}, from ${l.source}). Models: research ${l.models.research}, writing ${l.models.draft}, scoring ${l.models.score}. Web search: ${search}.`;
  $('usage-rows').innerHTML = u.byPurpose
    .map((r) => `<tr><td>${esc(r.purpose)}</td><td>${esc(r.model)}</td><td>${r.calls}</td><td>${r.input.toLocaleString()} / ${r.output.toLocaleString()}</td><td>$${r.cost.toFixed(3)}</td></tr>`)
    .join('');
}

// ---- wiring ----
$('onboard-form').onsubmit = (e) => {
  e.preventDefault();
  runResearch({ url: $('site-url').value.trim() }).catch((err) => alert(err.message));
};
$('rerun').onclick = () => confirm('Research the whole site again? This replaces all five documents, including your edits.') && runResearch({});
$('regen').onclick = () => confirm('Rewrite this document from scratch? Your edits to it will be replaced.') && runResearch({ only: currentDoc });
$('save').onclick = async () => {
  await api(`/api/profile/${currentDoc}`, { method: 'PUT', body: JSON.stringify({ body: $('doc-body').value }) });
  $('save-status').textContent = 'Saved.';
  state.docs.find((d) => d.id === currentDoc).written = true;
  renderDocList();
};
$('inbox-filter').onchange = () => ((currentDraft = null), loadInbox());
$('draft-meta').oninput = updateMetaLen;
$('draft-save').onclick = async () => (await saveDraft(), ($('draft-status').textContent = 'Saved.'));
$('draft-approve').onclick = async () => {
  try {
    await saveDraft();
    const when = $('draft-when').value ? new Date($('draft-when').value).toISOString() : null;
    const d = await post(`/api/drafts/${currentDraft}/approve`, { target: $('draft-target').value, when });
    $('inbox-filter').value = d.status;
    await loadInbox();
    updateInboxCount();
  } catch (err) {
    alert(err.message);
  }
};
$('draft-reject').onclick = async () => {
  const reopen = $('draft-reject').textContent === 'Reopen';
  await post(`/api/drafts/${currentDraft}/${reopen ? 'reopen' : 'reject'}`);
  currentDraft = null;
  await loadInbox();
  updateInboxCount();
};
$('audit-run').onclick = async () => {
  $('audit-run').disabled = true;
  try {
    renderAudit(await post('/api/audit'));
  } catch (err) {
    alert(err.message);
  } finally {
    $('audit-run').disabled = false;
  }
};
$('budget-save').onclick = async () => {
  try {
    await api('/api/budget', { method: 'PUT', body: JSON.stringify({ limit: Number($('budget-limit').value) }) });
    loadUsage();
  } catch (err) {
    alert(err.message);
  }
};
window.onhashchange = () => refresh().catch((err) => alert(err.message));
refresh().catch((err) => alert(err.message));
