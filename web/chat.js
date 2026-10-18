// The chat assistant panel. Uses $, esc, api, post and when from app.js (loaded first).
(() => {
  let threadId = null;
  let polling = null;
  let mentions = [];
  let shownCount = -1;

  const log = $('chat-log');
  const input = $('chat-input');

  async function loadChat() {
    let info;
    try {
      info = await api('/api/chat');
    } catch {
      return; // no site yet: the workspace isn't showing
    }
    mentions = info.mentions;
    $('chat-threads').innerHTML =
      '<option value="">Earlier chats…</option>' + info.threads.map((t) => `<option value="${t.id}" ${t.id === threadId ? 'selected' : ''}>${esc(t.title)}</option>`).join('');
    $('chat-threads').parentElement.hidden = !info.threads.length;
    if (!info.aiReady) {
      log.innerHTML = `<div class="chat-empty warn">${esc(info.aiProblem)} — <a href="/#llm">set it up</a>.</div>`;
      $('chat-suggest').innerHTML = '';
      input.disabled = $('chat-send').disabled = true;
      return;
    }
    input.disabled = $('chat-send').disabled = false;
    if (!threadId) {
      $('chat-title').textContent = 'Ask Plume';
      log.innerHTML = '<div class="chat-empty muted">Ask about your marketing, or have Plume write something. It knows your documents, results and competitors. Changes it suggests wait for you to apply them.</div>';
      showSuggestions(info.suggestions);
    }
  }

  function showSuggestions(list) {
    $('chat-suggest').innerHTML = list.map((s) => `<button type="button" class="chip-btn" dir="auto">${esc(s)}</button>`).join('');
    for (const b of $('chat-suggest').querySelectorAll('button')) b.onclick = () => ((input.value = b.textContent), grow(), input.focus());
  }

  async function openThread(id) {
    threadId = id;
    shownCount = -1;
    $('chat-suggest').innerHTML = '';
    await refreshThread();
  }

  async function refreshThread() {
    if (!threadId) return;
    let t;
    try {
      t = await api(`/api/chat/${threadId}`);
    } catch (err) {
      threadId = null;
      return loadChat();
    }
    $('chat-title').textContent = t.thread.title || 'Ask Plume';
    const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 60;
    log.innerHTML = t.items.map(renderItem).join('') + (t.thread.running ? '<div class="msg assistant thinking"><span class="dot-anim"></span> Working…</div>' : '') + (t.thread.error ? `<div class="msg error">${esc(t.thread.error)}</div>` : '');
    wireActions();
    if (atBottom || t.items.length !== shownCount) log.scrollTop = log.scrollHeight;
    shownCount = t.items.length;
    $('chat-cost').textContent = t.cost ? `This chat: $${t.cost.toFixed(3)}` : '';
    input.disabled = $('chat-send').disabled = t.thread.running;
    clearTimeout(polling);
    // Keep checking while it's answering, or while an agent it started is still working.
    const jobRunning = t.items.some((i) => (i.actions ?? []).some((a) => a.kind === 'job' && a.job?.status === 'running'));
    if (t.thread.running || jobRunning) polling = setTimeout(refreshThread, t.thread.running ? 1200 : 4000);
  }

  const COPY_ICON = '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M5 15V6a2 2 0 0 1 2-2h8" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';
  const CHECK_ICON = '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path d="m5 12 5 5 9-10" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

  function renderItem(item) {
    if (item.role === 'you') return `<div class="msg you" dir="auto">${esc(item.text)}</div>`;
    const steps = item.steps?.length ? `<div class="steps">${item.steps.map((s) => `<span>${esc(s)}</span>`).join('')}</div>` : '';
    const body = item.html ? `<div class="msg-body doc" dir="auto">${item.html}</div>` : '';
    const actions = (item.actions ?? []).map(renderAction).join('');
    const tools = item.html ? `<div class="msg-tools"><button type="button" data-copy title="Copy" aria-label="Copy">${COPY_ICON}</button></div>` : '';
    return `<div class="msg assistant">${steps}${body}${actions}${tools}</div>`;
  }

  function renderAction(a) {
    if (a.kind === 'doc-change') {
      const lines = a.diff
        .map((l) => `<div class="d-${l.t}" dir="auto">${l.t === 'add' ? '+ ' : l.t === 'del' ? '− ' : l.t === 'gap' ? '' : '  '}${esc(l.line) || '&nbsp;'}</div>`)
        .join('');
      const state =
        a.status === 'pending'
          ? a.stale
            ? '<span class="warn small">The document changed since — ask again to update this suggestion.</span> <button class="secondary small-btn" data-discard="' + a.id + '">Discard</button>'
            : `<button class="small-btn" data-apply="${a.id}">Apply</button> <button class="secondary small-btn" data-discard="${a.id}">Discard</button>`
          : `<span class="muted small">${a.status === 'applied' ? 'Applied ✓' : 'Discarded'}</span>`;
      return `<div class="act">
        <div class="act-head"><strong>${esc(a.title)}</strong> <span class="muted small">+${a.stats.added} −${a.stats.removed} lines</span></div>
        ${a.summary ? `<div class="small" dir="auto">${esc(a.summary)}</div>` : ''}
        <details ${a.status === 'pending' ? 'open' : ''}><summary class="small">Show the change</summary><div class="diff">${lines}</div></details>
        <div class="act-foot">${state}</div></div>`;
    }
    if (a.kind === 'draft') {
      const where = !a.draft ? 'removed' : a.draft.status === 'draft' ? 'waiting in Today' : a.draft.status;
      return `<div class="act"><div class="act-head">Draft: <a href="#draft/${a.draft?.id ?? ''}" dir="auto">${esc(a.title)}</a></div><div class="muted small">${esc(where)}</div></div>`;
    }
    if (a.kind === 'job') {
      const j = a.job;
      const status = !j ? 'gone' : j.status === 'running' ? `working: ${j.progress ?? ''}` : j.status === 'done' ? (a.doneText ?? 'finished — new drafts are in Today') : `stopped: ${j.error ?? ''}`;
      return `<div class="act"><div class="act-head">${esc(a.title)}${a.doneText ? '' : ' run'}</div><div class="muted small ${j?.status === 'running' ? 'pulse-text' : ''}">${esc(status)}</div></div>`;
    }
    if (a.kind === 'competitor')
      return `<div class="act"><div class="act-head">Added competitor <strong>${esc(a.title)}</strong></div><div class="act-foot">${a.status === 'done' ? `<button class="secondary small-btn" data-undo="${a.id}">Undo</button>` : '<span class="muted small">Removed again</span>'}</div></div>`;
    return '';
  }

  function wireActions() {
    for (const b of log.querySelectorAll('[data-copy]')) {
      b.onclick = async () => {
        await navigator.clipboard.writeText(b.closest('.msg').querySelector('.msg-body').innerText);
        b.innerHTML = CHECK_ICON;
        setTimeout(() => (b.innerHTML = COPY_ICON), 1500);
      };
    }
    for (const [attr, verb] of [['data-apply', 'apply'], ['data-discard', 'discard'], ['data-undo', 'undo']]) {
      for (const b of log.querySelectorAll(`[${attr}]`)) {
        b.onclick = async () => {
          b.disabled = true;
          try {
            await post(`/api/chat/actions/${b.getAttribute(attr)}/${verb}`);
            await refreshThread();
            if (verb === 'apply' || verb === 'undo') renderChrome(); // documents and competitors in the left column
          } catch (err) {
            alert(err.message);
            b.disabled = false;
          }
        };
      }
    }
  }

  async function send() {
    const text = input.value.trim();
    if (!text || input.disabled) return;
    input.disabled = $('chat-send').disabled = true;
    $('mention-box').hidden = true;
    try {
      const r = await post('/api/chat', { threadId, text });
      input.value = '';
      grow();
      $('chat-suggest').innerHTML = '';
      if (r.threadId !== threadId) {
        threadId = r.threadId;
        loadChat();
      }
      await refreshThread();
    } catch (err) {
      alert(err.message);
      input.disabled = $('chat-send').disabled = false;
    }
  }

  // ---- @ mentions ----
  function mentionQuery() {
    const before = input.value.slice(0, input.selectionStart);
    const m = before.match(/(^|\s)@([\w:-]*)$/);
    return m ? m[2].toLowerCase() : null;
  }

  function showMentions() {
    const q = mentionQuery();
    const box = $('mention-box');
    if (q === null) return (box.hidden = true);
    const hits = mentions.filter((m) => m.token.slice(1).toLowerCase().includes(q) || m.label.toLowerCase().includes(q)).slice(0, 8);
    if (!hits.length) return (box.hidden = true);
    box.innerHTML = hits.map((m, i) => `<button type="button" data-token="${esc(m.token)}" class="${i === 0 ? 'on' : ''}"><code>${esc(m.token)}</code> ${esc(m.label)}</button>`).join('');
    box.hidden = false;
    for (const b of box.querySelectorAll('button')) b.onmousedown = (e) => (e.preventDefault(), pickMention(b.dataset.token));
  }

  function pickMention(token) {
    const pos = input.selectionStart;
    const before = input.value.slice(0, pos).replace(/@[\w:-]*$/, `${token} `);
    input.value = before + input.value.slice(pos);
    input.selectionStart = input.selectionEnd = before.length;
    $('mention-box').hidden = true;
    input.focus();
  }

  // The box grows with what you type, up to the CSS max-height.
  function grow() {
    input.style.height = 'auto';
    input.style.height = `${input.scrollHeight}px`;
  }
  input.addEventListener('input', () => (grow(), showMentions()));
  input.addEventListener('keydown', (e) => {
    const box = $('mention-box');
    if (!box.hidden) {
      const items = [...box.querySelectorAll('button')];
      const on = items.findIndex((b) => b.classList.contains('on'));
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        items[on]?.classList.remove('on');
        items[(on + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length].classList.add('on');
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        return pickMention(items[Math.max(0, on)].dataset.token);
      }
      if (e.key === 'Escape') return (box.hidden = true);
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      send();
    }
  });
  input.addEventListener('blur', () => setTimeout(() => ($('mention-box').hidden = true), 150));

  $('chat-form').onsubmit = (e) => (e.preventDefault(), send());
  // Enlarging the panel: drag its left edge, or flip between normal and wide with the header button.
  const NORMAL_W = 340;
  const MIN_W = 300;
  const maxW = () => Math.max(MIN_W, window.innerWidth - 280 - 420); // always leave room for the sidebar and the main page
  const clampW = (w) => Math.round(Math.min(maxW(), Math.max(MIN_W, w)));
  const wideBtn = $('chat-wide');
  let chatW = pref.get('chatWidth', NORMAL_W);
  function setChatW(w, save = true) {
    chatW = clampW(w);
    $('workspace').style.setProperty('--chat-w', `${chatW}px`);
    const wide = chatW > NORMAL_W + 40;
    wideBtn.setAttribute('aria-pressed', String(wide));
    wideBtn.title = wideBtn.ariaLabel = wide ? 'Make the chat smaller' : 'Enlarge the chat';
    if (save) pref.set('chatWidth', chatW);
  }
  setChatW(chatW, false);
  wideBtn.onclick = () => setChatW(chatW > NORMAL_W + 40 ? NORMAL_W : Math.max(720, window.innerWidth * 0.45));
  window.addEventListener('resize', () => setChatW(pref.get('chatWidth', NORMAL_W), false));
  const grip = $('chat-resize');
  grip.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    grip.setPointerCapture(e.pointerId);
    document.body.classList.add('chat-resizing');
    const move = (ev) => setChatW(window.innerWidth - ev.clientX, false);
    const up = () => {
      grip.removeEventListener('pointermove', move);
      document.body.classList.remove('chat-resizing');
      pref.set('chatWidth', chatW);
    };
    grip.addEventListener('pointermove', move);
    grip.addEventListener('pointerup', up, { once: true });
    grip.addEventListener('pointercancel', up, { once: true });
  });
  grip.ondblclick = () => setChatW(NORMAL_W);

  $('chat-new').onclick = () => {
    threadId = null;
    clearTimeout(polling);
    $('chat-cost').textContent = '';
    loadChat();
    input.focus();
  };
  $('chat-threads').onchange = () => {
    const id = Number($('chat-threads').value);
    if (id) openThread(id);
  };

  loadChat();
  window.plumeChat = { reload: loadChat };
})();
