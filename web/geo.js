// AI visibility (what Claude, GPT and Gemini say when customers ask) and "Fix with a pull request".
// Uses $, esc, api, post, when and showView from app.js (loaded first). Builds its own view section.
(() => {
  const section = document.createElement('section');
  section.id = 'view-ai';
  section.className = 'view';
  section.hidden = true;
  section.innerHTML = `
    <div class="view-head">
      <a href="#today" class="back">← Today</a>
      <h1>AI visibility</h1>
      <span class="actions"><button id="ai-run">Check now</button></span>
    </div>
    <p class="muted">When a customer asks ChatGPT, Claude or Gemini for a recommendation, are you named? Plume asks your questions exactly as a member of the public would — no hints about you — and records who each assistant recommends. Answers come from what each assistant already knows, so they change slowly; checking weekly is plenty.</p>
    <p id="ai-status" class="small"></p>
    <div id="ai-body"></div>

    <h2>Questions customers ask</h2>
    <form id="ai-q-form" class="rk-form">
      <input id="ai-q-input" placeholder="e.g. What is the best app to practise for the driving theory test?" dir="auto" autocomplete="off">
      <button type="submit">Add</button>
      <button type="button" id="ai-suggest" class="secondary">Suggest questions</button>
      <span id="ai-q-msg" class="small"></span>
    </form>
    <ul id="ai-q-list" class="item-list"></ul>

    <details class="instructions" id="ai-setup">
      <summary>Assistants and names <span id="ai-setup-tag" class="muted small"></span></summary>
      <p class="muted small">Plume reaches each assistant through your AI connection. With a gateway such as LiteLLM, GPT and Gemini models are usually available too; type the exact model name if Plume can't find one.</p>
      <div id="ai-engines" class="form"></div>
      <div class="editor-bar"><span id="ai-eng-msg" class="small"></span><span><button id="ai-detect" class="secondary">Find assistants</button></span></div>
      <label class="small muted">Names your business goes by (one per line — include spellings in other languages)
        <textarea id="ai-names" rows="3" dir="auto"></textarea></label>
      <div class="editor-bar"><span id="ai-names-msg" class="small"></span><span><button id="ai-names-save" class="secondary">Save names</button></span></div>
    </details>
    <div id="ai-answer" class="card rk-serp" hidden></div>`;
  $('col-center').appendChild(section);

  let data = null;
  let polling = null;

  const pct = (n, d) => (d ? Math.round((100 * n) / d) : 0);

  function cell(c) {
    if (!c) return '<td class="muted">—</td>';
    if (c.error) return `<td><a href="#" data-ans="${c.answerId}" class="warn" title="${esc(c.error)}">error</a></td>`;
    const label = c.mentioned ? `✓${c.position ? ` #${c.position}` : ''}` : '✗';
    const cls = c.mentioned ? (c.sentiment === 'negative' ? 'bad' : 'good') : 'muted';
    return `<td><a href="#" data-ans="${c.answerId}" class="${cls}" title="${esc(c.excerpt)}">${label}</a>${c.mentioned && c.sentiment === 'negative' ? ' <small class="bad">negative</small>' : ''}</td>`;
  }

  function render() {
    const s = data.summary;
    const engines = data.engines;
    $('ai-setup-tag').textContent = `· ${['claude', 'gpt', 'gemini'].filter((e) => engines[e].status === 'ok').length} of 3 assistants available`;
    $('ai-run').disabled = !!data.running || !data.questions.length;
    $('ai-run').title = data.questions.length ? `About ${data.estimate.checks} checks, roughly $${data.estimate.usd.toFixed(2)}` : 'Add some questions first';
    $('ai-status').className = 'small muted';
    $('ai-status').textContent = data.running ? `Checking: ${data.running}` : s ? `Last checked ${when(s.at)} · cost $${s.cost.toFixed(3)}${s.failed ? ` · ${s.failed} answer(s) failed` : ''}` : 'Not checked yet.';

    if (!s) {
      $('ai-body').innerHTML = `<div class="today empty">${data.questions.length ? 'Click “Check now” to see what the assistants say.' : 'Add the questions your customers ask (or let Plume suggest some), then check.'}</div>`;
    } else {
      const engCols = s.perEngine.map((e) => `<th title="${esc(e.model)}">${esc(e.label)}</th>`).join('');
      const maxVoice = Math.max(1, ...s.shareOfVoice.map((x) => x.answers));
      $('ai-body').innerHTML = `
        <div class="gauges ai-gauges">
          <div class="gauge"><div class="ring ${s.overall.score >= 50 ? 'good' : s.overall.score >= 20 ? 'mid' : 'bad'}" style="background: conic-gradient(currentColor ${s.overall.score * 3.6}deg, var(--line) 0)"><span class="ring-in">${s.overall.score}%</span></div>named in ${s.overall.mentioned} of ${s.overall.answered} answers</div>
          ${s.perEngine
            .map(
              (e) => `<div class="gauge"><div class="big">${pct(e.mentioned, e.answered)}%</div>${esc(e.label)}<div class="muted small">${e.mentioned}/${e.answered}${e.avgPosition ? ` · avg #${e.avgPosition}` : ''}</div></div>`,
            )
            .join('')}
        </div>
        ${s.trend.length > 1 ? `<p class="muted small">Trend: ${s.trend.map((t) => `${t.score}%`).join(' → ')}</p>` : ''}
        <h2>Who gets recommended</h2>
        <p class="muted small">In how many answers each name appears. If others appear far more than you, those are the sources the assistants trust for this topic.</p>
        <div class="voice">${s.shareOfVoice
          .map((v) => `<div class="voice-row ${v.you ? 'you' : ''}"><span dir="auto">${esc(v.name)}</span><span class="voice-bar"><span style="width:${(100 * v.answers) / maxVoice}%"></span></span><span>${v.answers}</span></div>`)
          .join('')}</div>
        <h2>Question by question</h2>
        <div class="table-wrap"><table class="rk-table"><thead><tr><th>Question</th>${engCols}</tr></thead><tbody>
          ${s.questions.map((q) => `<tr><td dir="auto">${esc(q.question)}</td>${s.perEngine.map((e) => cell(q.cells[e.engine])).join('')}</tr>`).join('')}
        </tbody></table></div>
        <p class="muted small">✓ named (#2 = second business it recommends) · ✗ not named · click any cell to read the full answer.</p>`;
    }

    $('ai-q-list').innerHTML = data.questions.length
      ? data.questions.map((q) => `<li><span dir="auto">${esc(q.question)}</span>${q.source === 'suggested' ? ' <small class="muted">suggested</small>' : ''} <button class="secondary small-btn" data-delq="${q.id}" title="Remove">×</button></li>`).join('')
      : '<li class="muted">No questions yet.</li>';

    $('ai-engines').innerHTML = ['claude', 'gpt', 'gemini']
      .map((e) => {
        const st = engines[e];
        const label = { claude: 'Claude', gpt: 'ChatGPT (GPT)', gemini: 'Gemini' }[e];
        return `<label>${label} <span class="${st.status === 'ok' ? 'good' : st.status === 'unavailable' ? 'warn' : 'muted'} small">${st.status === 'ok' ? 'available' : st.status === 'unavailable' ? 'not available' : 'not checked'}</span>
          <input data-eng="${e}" value="${esc(st.model ?? '')}" placeholder="model name, e.g. azure/gpt-5.5" spellcheck="false"><small class="muted">${esc(st.note)}</small></label>`;
      })
      .join('');
    if (document.activeElement !== $('ai-names')) $('ai-names').value = data.brandNames.join('\n');
    wire();
  }

  async function load() {
    showView('ai');
    data = await api('/api/ai-visibility');
    render();
    clearTimeout(polling);
    if (data.running) polling = setTimeout(load, 2500);
  }

  async function showAnswer(id) {
    const box = $('ai-answer');
    box.hidden = false;
    box.innerHTML = '<p class="muted">Loading…</p>';
    box.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    try {
      const a = await api(`/api/ai-visibility/answers/${id}`);
      box.innerHTML = `<div class="view-head small-head"><h2 dir="auto">${esc(a.question)}</h2><span class="actions"><button class="secondary small-btn" id="ai-ans-close">Close</button></span></div>
        <p class="muted small">${esc({ claude: 'Claude', gpt: 'ChatGPT (GPT)', gemini: 'Gemini' }[a.engine] ?? a.engine)} · ${esc(a.model)}</p>
        ${a.error ? `<p class="warn">${esc(a.error)}</p>` : `<div class="ai-answer-text" dir="auto">${esc(a.answer)}</div>`}`;
      $('ai-ans-close').onclick = () => (box.hidden = true);
    } catch (err) {
      box.innerHTML = `<p class="warn">${esc(err.message)}</p>`;
    }
  }

  function wire() {
    for (const a of section.querySelectorAll('[data-ans]')) a.onclick = (e) => (e.preventDefault(), showAnswer(a.dataset.ans));
    for (const b of section.querySelectorAll('[data-delq]'))
      b.onclick = async () => {
        await api(`/api/ai-visibility/questions/${b.dataset.delq}`, { method: 'DELETE' });
        load();
      };
    for (const i of section.querySelectorAll('[data-eng]'))
      i.onchange = async () => {
        try {
          await api('/api/ai-visibility/engines', { method: 'PUT', body: JSON.stringify({ engine: i.dataset.eng, model: i.value }) });
          $('ai-eng-msg').className = 'small muted';
          $('ai-eng-msg').textContent = 'Saved. Click “Find assistants” to check it answers.';
          load();
        } catch (err) {
          $('ai-eng-msg').className = 'small warn';
          $('ai-eng-msg').textContent = err.message;
        }
      };
  }

  $('ai-q-form').onsubmit = async (e) => {
    e.preventDefault();
    const q = $('ai-q-input').value.trim();
    if (!q) return;
    try {
      await post('/api/ai-visibility/questions', { question: q });
      $('ai-q-input').value = '';
      $('ai-q-msg').textContent = '';
      load();
    } catch (err) {
      $('ai-q-msg').className = 'small warn';
      $('ai-q-msg').textContent = err.message;
    }
  };
  $('ai-suggest').onclick = async () => {
    $('ai-suggest').disabled = true;
    $('ai-q-msg').className = 'small muted';
    $('ai-q-msg').textContent = 'Thinking of questions…';
    try {
      const r = await post('/api/ai-visibility/suggest');
      $('ai-q-msg').textContent = r.added.length ? `Added ${r.added.length}. Remove any that don't fit.` : 'No new ones — the list already covers it.';
      load();
    } catch (err) {
      $('ai-q-msg').className = 'small warn';
      $('ai-q-msg').textContent = err.message;
    } finally {
      $('ai-suggest').disabled = false;
    }
  };
  $('ai-run').onclick = async () => {
    if (!confirm(`Ask ${data.estimate.checks} question-and-assistant pairs now? It costs roughly $${data.estimate.usd.toFixed(2)} and takes a few minutes.`)) return;
    try {
      await post('/api/ai-visibility/run');
      load();
    } catch (err) {
      alert(err.message);
    }
  };
  $('ai-detect').onclick = async () => {
    $('ai-detect').disabled = true;
    $('ai-eng-msg').className = 'small muted';
    $('ai-eng-msg').textContent = 'Asking each assistant a one-word question (costs a fraction of a cent)…';
    try {
      await post('/api/ai-visibility/engines/detect');
      $('ai-eng-msg').textContent = 'Done.';
      load();
    } catch (err) {
      $('ai-eng-msg').className = 'small warn';
      $('ai-eng-msg').textContent = err.message;
    } finally {
      $('ai-detect').disabled = false;
    }
  };
  $('ai-names-save').onclick = async () => {
    const names = $('ai-names').value.split('\n').map((n) => n.trim()).filter(Boolean);
    const r = await api('/api/ai-visibility/names', { method: 'PUT', body: JSON.stringify({ names }) });
    $('ai-names').value = r.names.join('\n');
    $('ai-names-msg').className = 'small good';
    $('ai-names-msg').textContent = 'Saved. They count from the next check.';
  };

  // ---- "Fix with a pull request" on site fixes (Today card and the Site fixes view) ----
  let ghState = null;
  async function github() {
    ghState = ghState ?? (await api('/api/code-fixes').catch(() => ({ connected: false, fixes: {} })));
    return ghState;
  }

  /** Add the button next to every fix in `container` that has a data-pr-issue attribute holder. */
  async function wirePr(container) {
    const g = await github();
    for (const holder of container.querySelectorAll('[data-pr-issue]')) {
      if (holder.dataset.prWired) continue;
      holder.dataset.prWired = '1';
      const id = holder.dataset.prIssue;
      const prior = g.fixes[id];
      if (prior?.status === 'opened' && prior.prUrl) {
        holder.innerHTML = `<a href="${esc(prior.prUrl)}" target="_blank" rel="noopener"><button class="secondary">Pull request opened ↗</button></a>`;
        continue;
      }
      if (!g.connected) {
        holder.innerHTML = '<a href="#settings"><button class="secondary" title="Connect this website\'s GitHub repository under Settings">Fix with a pull request…</button></a>';
        continue;
      }
      holder.innerHTML = `<button class="secondary">Fix with a pull request</button>${prior && prior.status !== 'opened' ? `<small class="muted"> last try: ${esc(prior.message ?? prior.status)}</small>` : ''}`;
      holder.querySelector('button').onclick = async (e) => {
        const b = e.target;
        b.disabled = true;
        b.textContent = 'Preparing…';
        try {
          const { jobId } = await post('/api/code-fixes', { issueId: id });
          for (;;) {
            await new Promise((r) => setTimeout(r, 2000));
            const job = await api(`/api/jobs/${jobId}`);
            b.textContent = job.progress || 'Preparing…';
            if (job.status !== 'running') {
              ghState = null;
              const fix = (await api(`/api/code-fixes/status?issueId=${encodeURIComponent(id)}`)).fix;
              if (fix?.prUrl) holder.innerHTML = `<a href="${esc(fix.prUrl)}" target="_blank" rel="noopener"><button>Review the pull request ↗</button></a>`;
              else holder.innerHTML = `<small class="warn">${esc(job.error || fix?.message || 'Could not open a pull request.')}</small>`;
              break;
            }
          }
        } catch (err) {
          b.disabled = false;
          b.textContent = 'Fix with a pull request';
          alert(err.message);
        }
      };
    }
  }

  window.plumeGeo = { load, wirePr };
})();
