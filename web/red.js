// Plume-Red: the security side. Shows what the site's connection unlocks, runs a scan, lists findings,
// and opens dependency-bump pull requests. Uses $, esc, api, post, showView from app.js (loaded first).
(() => {
  const section = document.createElement('section');
  section.id = 'view-red';
  section.className = 'view';
  section.hidden = true;
  section.innerHTML = `
    <div class="view-head">
      <a href="#dashboard" class="back">← Dashboard</a>
      <h1>Plume-Red <span class="muted small">security</span></h1>
      <span class="actions"><button id="red-run" disabled>Scan now</button></span>
    </div>
    <p class="muted">Plume-Red checks the website you have connected for security problems — missing protections, out-of-date software, leaked files, and weak spots an attacker could use. It only ever checks a site you have connected through Google, and the deeper checks need Search Console, which Google grants after it has confirmed you own the domain.</p>
    <p id="red-gate" class="small"></p>
    <label id="red-active-wrap" class="small" hidden style="display:flex;gap:.4rem;align-items:center;margin:.4rem 0">
      <input type="checkbox" id="red-active"> Also run active tests (sends harmless test input to find injection, XSS and redirect holes — never anything that changes or breaks the site). Needs Search Console.
    </label>
    <p id="red-status" class="small"></p>
    <div id="red-body"></div>`;
  $('col-center').appendChild(section);

  let scan = null;
  let perms = null;

  const SEV_ORDER = { critical: 0, high: 1, medium: 2, low: 3 };
  const sevTag = (s) => `<span class="tag sev-${s}">${s}</span>`;

  async function load() {
    showView('red');
    $('red-status').textContent = 'Loading…';
    try {
      const r = await api('/api/red');
      scan = r.scan;
      perms = r.permissions;
    } catch (e) {
      $('red-status').textContent = e.message;
      return;
    }
    renderGate();
    render();
    $('red-status').textContent = '';
  }

  function renderGate() {
    $('red-gate').textContent = perms ? perms.reason : '';
    $('red-run').disabled = !(perms && perms.enabled);
    const activeWrap = $('red-active-wrap');
    activeWrap.hidden = !(perms && perms.activeTesting);
    if (!perms || !perms.activeTesting) $('red-active').checked = false;
  }

  function render() {
    const body = $('red-body');
    if (!scan) {
      body.innerHTML = perms && perms.enabled ? '<p class="muted">No scan yet. Press “Scan now”.</p>' : '';
      return;
    }
    const issues = [...scan.issues].sort((a, b) => SEV_ORDER[a.severity] - SEV_ORDER[b.severity]);
    const scoreClass = scan.score >= 80 ? 'good' : scan.score >= 50 ? 'ok' : 'bad';
    const skipped = (scan.skipped || []).map((s) => `<li>${esc(s)}</li>`).join('');
    body.innerHTML = `
      <div class="red-summary">
        <span class="red-score ${scoreClass}">${scan.score}<span class="muted small">/100</span></span>
        <span class="small">${scan.counts.critical} critical · ${scan.counts.warnings} other · checked ${scan.pagesChecked} page(s)</span>
        <span class="muted small">${scan.at ? new Date(scan.at).toLocaleString() : ''}</span>
      </div>
      ${issues.length ? '' : '<p class="good">No security issues found in what was checked.</p>'}
      <ul class="red-list">
        ${issues.map(renderIssue).join('')}
      </ul>
      ${skipped ? `<details class="instructions"><summary>What wasn’t checked, and why</summary><ul class="muted small">${skipped}</ul></details>` : ''}`;
    for (const b of body.querySelectorAll('[data-fix]')) b.addEventListener('click', () => openFix(b.dataset.fix, b));
  }

  function renderIssue(i) {
    const canFix = i.check.startsWith('vulnerable-dependency-');
    return `
      <li class="red-issue">
        <div class="red-issue-head">${sevTag(i.severity)} <strong>${esc(i.title)}</strong></div>
        <p class="muted small">${esc(i.url)}</p>
        <p class="small">${esc(i.why)}</p>
        <ul class="small">${(i.steps || []).map((s) => `<li>${esc(s)}</li>`).join('')}</ul>
        ${i.snippet ? `<pre class="snippet">${esc(i.snippet)}</pre>` : ''}
        ${canFix ? `<div class="red-fix-bar"><button class="secondary small-btn" data-fix="${esc(i.id)}">Fix with a pull request</button> <span class="small fix-msg"></span></div>` : ''}
      </li>`;
  }

  async function openFix(id, btn) {
    const msg = btn.parentElement.querySelector('.fix-msg');
    btn.disabled = true;
    msg.textContent = 'Opening a pull request…';
    try {
      const r = await post('/api/red/fix', { id });
      msg.innerHTML = r.prUrl ? `Opened: <a href="${esc(r.prUrl)}" target="_blank" rel="noopener">pull request</a>` : esc(r.message || 'Done.');
    } catch (e) {
      msg.textContent = e.message;
      btn.disabled = false;
    }
  }

  $('red-run').addEventListener('click', async () => {
    $('red-run').disabled = true;
    $('red-status').textContent = 'Scanning…';
    try {
      const r = await post('/api/red', { active: $('red-active').checked });
      scan = r.scan;
      perms = r.permissions;
      renderGate();
      render();
      $('red-status').textContent = '';
    } catch (e) {
      $('red-status').textContent = e.message;
    } finally {
      $('red-run').disabled = !(perms && perms.enabled);
    }
  });

  window.plumeRed = { load };
})();
