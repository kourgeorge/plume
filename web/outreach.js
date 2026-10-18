// Outreach (creators and link pages) and video previews on video-script drafts.
// Uses $, esc, api, post, when and showView from app.js (loaded first). Builds its own view section.
(() => {
  const section = document.createElement('section');
  section.id = 'view-outreach';
  section.className = 'view';
  section.hidden = true;
  section.innerHTML = `
    <div class="view-head">
      <a href="#today" class="back">← Today</a>
      <h1>Outreach</h1>
      <span class="actions"><button id="or-add-shortcut" class="secondary" hidden>Add page</button><button id="or-find">Find creators</button></span>
    </div>
    <div class="tabs" id="or-tabs"><button data-kind="creator">Creators</button><button data-kind="link">Link pages</button></div>
    <p id="or-intro" class="muted"></p>
    <p id="or-email" class="small"></p>
    <p id="or-status" class="small muted"></p>
    <div id="or-counts" class="or-counts"></div>
    <ul id="or-list" class="item-list"></ul>
    <details class="instructions" id="or-add-box">
      <summary>Add someone yourself</summary>
      <form id="or-add" class="form or-add">
        <label>Name <input id="or-add-name" dir="auto" required></label>
        <label>Page or profile address <input id="or-add-url" placeholder="https://…" required></label>
        <label>Email (optional — only if you know it's theirs) <input id="or-add-email" type="email"></label>
        <div class="editor-bar"><span id="or-add-msg" class="small"></span><span><button type="submit">Add</button></span></div>
      </form>
    </details>`;
  $('col-center').appendChild(section);

  const INTRO = {
    creator:
      'Creators whose audience is your customers. Plume finds them, looks for a public contact address on their own pages, and drafts a short first message for you to approve. Keep track of replies, rates and posts here.',
    link: 'Pages that should link to you: they mention you without a link, or link to your competitors and not to you. Plume reads every page itself before it lands here — nothing is guessed.',
  };
  const STEP = {
    found: 'Found', drafted: 'Message drafted', contacted: 'Contacted', replied: 'Replied', agreed: 'Agreed',
    posted: 'Posted', paid: 'Paid', linked: 'Linked to you', declined: 'Said no',
  };
  let kind = 'creator';
  let data = null;
  let polling = null;
  let linkFilter = 'review';
  let selectedLink = null;
  let linkDraft = null;
  let linkNotice = '';
  const linkGroups = { review: 'To review', drafts: 'Drafts', sent: 'Sent', verified: 'Verified', closed: 'Closed' };
  const groupFor = c => c.status === 'declined' ? 'closed' : c.evidence?.verification === 'verified' && c.status === 'linked' ? 'verified' : ['contacted', 'replied', 'linked'].includes(c.status) ? 'sent' : c.status === 'drafted' ? 'drafts' : 'review';

  function emailLine(e) {
    if (!e.connected) return '<span class="muted">Email isn\'t connected, so messages are saved for you to send yourself. Connect your mail account under <a href="#settings">Settings</a> to send approved emails from Plume.</span>';
    return `<span class="good">Email connected.</span> <span class="muted">${e.sentToday} of ${e.dailyLimit} sent today. Plume never writes twice to the same address within 30 days, or ever again to someone who said no.</span>`;
  }

  function contactHtml(c) {
    const emailBit = c.email
      ? `<span title="${esc(c.emailSource)}">${esc(c.email)}</span> ${c.emailVerified ? `<small class="good">✓ ${c.emailSource === 'typed by you' ? 'typed by you' : 'seen on their page'}</small>` : '<small class="warn">not checked</small>'}`
      : '<span class="muted">no public email found</span>';
    const creator = c.kind === 'creator';
    return `<li data-id="${c.id}" class="or-row ${c.status === 'declined' ? 'muted' : ''}">
      <div class="or-top">
        <span><a href="${esc(c.url)}" target="_blank" rel="noopener" dir="auto">${esc(c.name)}</a>
          <small>${esc([c.platform, c.audience, c.opportunity === 'unlinked-mention' ? 'mentions you, no link' : c.opportunity === 'lists-competitors' ? 'links to competitors' : ''].filter(Boolean).join(' · '))}</small></span>
        <select class="or-step">${data.steps.map((s) => `<option value="${s}" ${s === c.status ? 'selected' : ''}>${esc(STEP[s] ?? s)}</option>`).join('')}</select>
      </div>
      <p class="why" dir="auto">${esc(c.why)}</p>
      <div class="small">${emailBit}${c.lastEmailedAt ? ` <span class="muted">· last emailed ${esc(when(c.lastEmailedAt))}</span>` : ''}${c.rate ? ` · <b>${esc(c.rate)}</b>` : ''}${c.paid ? ' · <span class="good">paid</span>' : ''}${c.deliverableUrl ? ` · <a href="${esc(c.deliverableUrl)}" target="_blank" rel="noopener">${creator ? 'their post' : 'the link'} ↗</a>` : ''}</div>
      ${c.notes ? `<p class="small muted" dir="auto">${esc(c.notes)}</p>` : ''}
      <div class="acts">
        <button class="or-draft" ${c.status === 'declined' ? 'disabled title="They said no"' : ''}>${c.status === 'found' ? 'Draft a message' : 'Draft another message'}</button>
        <button class="secondary or-edit">Details</button>
        <span class="right"><button class="secondary or-remove">Remove</button></span>
      </div>
      <form class="form or-details" hidden>
        <label>Email <input name="email" type="email" value="${esc(c.email)}"></label>
        ${creator ? `<label>Their rate <input name="rate" value="${esc(c.rate)}" placeholder="e.g. $200 per video"></label>` : ''}
        <label>${creator ? 'Link to their post about you' : 'Page with your link'} <input name="deliverableUrl" value="${esc(c.deliverableUrl)}" placeholder="https://…"></label>
        ${creator ? `<label class="check"><input name="paid" type="checkbox" ${c.paid ? 'checked' : ''}> Paid</label>` : ''}
        <label>Notes <textarea name="notes" rows="2" dir="auto">${esc(c.notes)}</textarea></label>
        <div class="editor-bar"><span class="small or-msg"></span><span><button type="submit">Save</button></span></div>
      </form>
    </li>`;
  }

  function render() {
    for (const b of $('or-tabs').querySelectorAll('button')) b.classList.toggle('on', b.dataset.kind === kind);
    $('or-intro').textContent = INTRO[kind];
    $('or-email').innerHTML = emailLine(data.email);
    $('or-find').textContent = kind === 'creator' ? 'Find creators' : 'Find link pages';
    $('or-find').disabled = !!data.running;
    $('or-find').title = 'Uses web search and the AI — a few cents';
    $('or-status').textContent = data.running ? `Looking: ${data.running}` : kind === 'creator' && !data.youtube ? 'Tip: add a YouTube key under Settings for real subscriber counts.' : '';
    $('or-counts').innerHTML = data.steps
      .filter((s) => data.counts[s])
      .map((s) => `<span class="pill">${esc(STEP[s] ?? s)} <b>${data.counts[s]}</b></span>`)
      .join('');
    section.querySelector('h1').textContent = kind === 'link' ? 'Link opportunities' : 'Outreach';
    section.classList.toggle('link-workspace', kind === 'link');
    $('or-email').hidden = kind === 'link';
    $('or-counts').hidden = kind === 'link';
    $('or-status').hidden = kind === 'link';
    $('or-add-shortcut').hidden = kind !== 'link';
    $('or-add-shortcut').onclick = () => { $('or-add-box').hidden = false; $('or-add-box').open = true; $('or-add-name').focus(); };
    $('or-add-box').hidden = kind === 'link' && !$('or-add-box').open;
    if (kind === 'link') return renderLinkWorkspace();
    $('or-add-box').querySelector('summary').textContent = 'Add someone yourself';
    $('or-add-box').querySelector('label').firstChild.textContent = 'Name ';
    $('or-list').innerHTML = data.contacts.length
      ? data.contacts.map(contactHtml).join('')
      : `<li class="muted">Nobody here yet. Click “${esc($('or-find').textContent)}”, or add someone below.</li>`;
    for (const li of $('or-list').querySelectorAll('li[data-id]')) wireRow(li);
  }

  function wireRow(li) {
    const id = li.dataset.id;
    li.querySelector('.or-step').onchange = async (e) => {
      try {
        await api(`/api/outreach/${id}`, { method: 'PUT', body: JSON.stringify({ status: e.target.value }) });
        await refresh();
      } catch (err) {
        alert(err.message);
      }
    };
    li.querySelector('.or-edit').onclick = () => (li.querySelector('.or-details').hidden = !li.querySelector('.or-details').hidden);
    li.querySelector('.or-remove').onclick = async () => {
      if (!confirm('Remove from the list? Plume may find them again later.')) return;
      await api(`/api/outreach/${id}`, { method: 'DELETE' });
      await refresh();
    };
    li.querySelector('.or-draft').onclick = async (e) => {
      const b = e.target;
      b.disabled = true;
      b.textContent = 'Writing…';
      try {
        const { draftId } = await post(`/api/outreach/${id}/draft`);
        location.hash = `#draft/${draftId}`;
      } catch (err) {
        alert(err.message);
        await refresh();
      }
    };
    li.querySelector('.or-details').onsubmit = async (e) => {
      e.preventDefault();
      const f = e.target;
      const body = { email: f.email.value, notes: f.notes.value, deliverableUrl: f.deliverableUrl.value };
      if (f.rate) body.rate = f.rate.value;
      if (f.paid) body.paid = f.paid.checked;
      try {
        await api(`/api/outreach/${id}`, { method: 'PUT', body: JSON.stringify(body) });
        await refresh();
      } catch (err) {
        f.querySelector('.or-msg').className = 'small bad';
        f.querySelector('.or-msg').textContent = err.message;
      }
    };
  }

  async function refresh() {
    data = await api(`/api/outreach?kind=${kind}`);
    render();
    if (data.running && !polling) polling = setTimeout(() => ((polling = null), section.hidden || refresh()), 2500);
  }

  async function load(k) {
    showView('outreach');
    if (k?.startsWith('link')) { kind = 'link'; linkFilter = linkGroups[k.split('/')[1]] ? k.split('/')[1] : 'review'; selectedLink = null; linkDraft = null; }
    else if (k === 'creator') kind = k;
    await refresh();
  }

  for (const b of $('or-tabs').querySelectorAll('button')) b.onclick = () => ((kind = b.dataset.kind), refresh());

  $('or-find').onclick = async () => {
    $('or-find').disabled = true;
    linkNotice = '';
    try {
      await post('/api/outreach/discover', { kind });
    } catch (err) {
      linkNotice = err.message;
    }
    await refresh();
  };

  $('or-add').onsubmit = async (e) => {
    e.preventDefault();
    const msg = $('or-add-msg');
    try {
      await post('/api/outreach', { kind, name: $('or-add-name').value, url: $('or-add-url').value, email: $('or-add-email').value || undefined });
      for (const f of ['or-add-name', 'or-add-url', 'or-add-email']) $(f).value = '';
      msg.className = 'small good';
      msg.textContent = 'Added.';
      await refresh();
    } catch (err) {
      msg.className = 'small bad';
      msg.textContent = err.message;
    }
  };

  function discoveryMarkup() {
    const run = data.discovery;
    if (data.running) return `<div class="link-run" role="status"><span class="link-pulse"></span><div><strong>Finding link opportunities</strong><p>${esc(data.running)}</p></div></div>`;
    if (linkNotice || run?.error) return `<div class="link-run link-error" role="alert"><div><strong>Discovery couldn’t finish</strong><p>${esc(linkNotice || run.error)}</p><button class="secondary" data-find-links>Try again</button></div></div>`;
    if (!run?.result) return '';
    const r = run.result;
    const already = r.rejected.filter(c => c.reason === 'it already links to you').length;
    const unread = r.rejected.filter(c => !['it already links to you', 'it is your own site', "it is a competitor’s site", "it is a competitor's site", 'it neither names you nor links to your competitors'].includes(c.reason)).length;
    return `<div class="link-run"><div><strong>${r.checked} pages checked · ${r.added.length} opportunities found</strong><p class="muted small">${esc(when(run.finished_at))} · ${already} already link to you · ${r.rejected.length - already - unread} weren’t relevant · ${unread} couldn’t be read</p>
      <details><summary>View checked pages</summary>${r.added.map(c => `<p class="small"><a href="${esc(c.url)}" target="_blank" rel="noopener">${esc(c.name)}</a> · Opportunity found</p>`).join('')}${r.rejected.map(c => `<p class="small"><a href="${esc(c.url)}" target="_blank" rel="noopener">${esc(c.url)}</a> · ${esc(c.reason)}</p>`).join('')}${r.checked === 0 ? '<p>No new pages to check.</p>' : ''}</details>
      ${!r.added.length ? '<p class="small">Review your competitors or add a page you already know.</p><a href="#competitor/new">Review competitors / add one →</a>' : ''}</div></div>`;
  }

  function renderLinkWorkspace() {
    if (linkDraft && $('link-body')) { linkDraft.body = $('link-body').value; linkDraft.meta.subject = $('link-subject').value; }
    $('or-intro').textContent = 'Find pages that mention you or link to competitors, then manage your requests.';
    $('or-status').textContent = '';
    $('or-find').textContent = 'Find opportunities';
    $('or-counts').innerHTML = '';
    const rows = data.contacts.filter(c => groupFor(c) === linkFilter);
    $('or-list').innerHTML = `<li class="link-surface">${discoveryMarkup()}
      <div class="link-toolbar" ${data.contacts.length ? '' : 'hidden'}><div class="tabs" aria-label="Opportunity status">${Object.entries(linkGroups).map(([key, label]) => `<button data-link-filter="${key}" class="${key === linkFilter ? 'on' : ''}">${label} <small>${data.contacts.filter(c => groupFor(c) === key).length}</small></button>`).join('')}</div></div>
      ${!data.contacts.length ? `<div class="link-empty"><h3>No opportunities yet</h3><p>Run a search to find relevant articles and resource pages for your site.</p><span class="small muted">Discovery uses AI and web search, with a small usage cost.</span></div>` : ''}
      <div class="link-layout"><div class="link-results">${rows.map(c => `<article class="link-prospect ${selectedLink === c.id ? 'selected' : ''}"><div class="link-eyebrow">${esc(new URL(c.url).hostname)} · ${c.evidence?.checked_at ? 'Checked ' + esc(when(c.evidence.checked_at)) : 'Added manually'}</div><h3><a href="${esc(c.url)}" target="_blank" rel="noopener" dir="auto">${esc(c.name)} ↗</a></h3><span class="link-tag">${esc(c.opportunity === 'unlinked-mention' ? 'Mentions your business' : c.opportunity === 'lists-competitors' ? 'Links to competitors' : 'Needs review')}</span><p class="small muted">${c.emailVerified ? 'Public email available' : 'Use the website’s contact form'}${c.status === 'linked' && groupFor(c) !== 'verified' ? ' · Link recorded manually' : ''}</p><button class="secondary" data-review-link="${c.id}">${linkFilter === 'review' ? 'Review & draft' : 'Open opportunity'}</button></article>`).join('') || (data.contacts.length ? `<div class="link-empty"><h3>No pages in ${esc(linkGroups[linkFilter].toLowerCase())}</h3><p>Choose another stage to continue.</p></div>` : '')}</div><div id="link-detail" class="link-detail" ${selectedLink ? '' : 'hidden'}></div></div>
      <div class="link-footer"><span>Discovered and added pages only · Not a full backlink index</span>${data.contacts.length && !data.email.connected ? '<span>Send requests manually · <a href="#settings">Connect email</a></span>' : ''}</div></li>`;
    $('or-add-box').querySelector('summary').textContent = 'Add a page yourself';
    $('or-add-box').querySelector('label').firstChild.textContent = 'Page title ';
    for (const b of section.querySelectorAll('[data-find-links]')) b.onclick = () => $('or-find').click();
    for (const b of section.querySelectorAll('[data-link-filter]')) b.onclick = () => { linkFilter = b.dataset.linkFilter; selectedLink = null; linkDraft = null; renderLinkWorkspace(); };
    for (const b of section.querySelectorAll('[data-review-link]')) b.onclick = () => { selectedLink = Number(b.dataset.reviewLink); linkDraft = null; renderLinkDetail(); };
    if (selectedLink) renderLinkDetail();
  }

  function renderLinkDetail() {
    const c = data.contacts.find(c => c.id === selectedLink);
    const panel = $('link-detail');
    if (!c || !panel) return;
    panel.hidden = false;
    panel.innerHTML = `<div class="view-head"><h3>Review opportunity</h3><button class="secondary small-btn" id="link-close">Close</button></div><h2 dir="auto">${esc(c.name)}</h2><a href="${esc(c.url)}" target="_blank" rel="noopener">Open source page ↗</a>
      <h4>Why this page qualifies</h4><blockquote dir="auto">${esc(c.evidence?.evidence || c.why || 'Added manually. Review this page before contacting the owner.')}</blockquote><p class="small muted">${c.evidence?.checked_at ? 'Page checked ' + esc(when(c.evidence.checked_at)) : 'No saved page check yet'}</p>
      ${c.evidence?.verification ? `<div class="link-verification ${c.evidence.verification === 'verified' ? 'good' : ''}"><strong>${esc({ verified: 'Link verified', missing: 'No link found', error: 'Couldn’t check' }[c.evidence.verification])}</strong><p>${esc(c.evidence.verification_note)}</p><small>${esc(when(c.evidence.verification_at))}</small>${c.evidence.verified_url ? `<p><a href="${esc(c.evidence.verified_url)}" target="_blank" rel="noopener">${esc(c.evidence.verified_url)}</a></p>` : ''}</div>` : ''}
      <p class="small">${c.emailVerified ? 'Contact: ' + esc(c.email) : 'No public email found. Use the website’s contact form.'}</p><div id="link-message"></div>
      <div class="link-actions"><button id="link-draft">${c.draft ? 'Open draft' : 'Draft a request'}</button><button class="secondary" id="link-check">Check for link</button></div>
      <details class="link-notes"><summary>Details & notes</summary><form id="link-notes-form" class="form"><label>Contact email<input name="email" type="email" value="${esc(c.email)}"></label><label>Page to verify<input name="deliverableUrl" type="url" value="${esc(c.deliverableUrl || c.url)}"></label><label>Notes<textarea name="notes">${esc(c.notes)}</textarea></label><button class="secondary">Save details</button></form><label>Dismissal reason (optional)<input id="link-dismiss-reason" placeholder="Why this page isn’t a fit"></label></details>
      <div class="link-actions"><button class="secondary" id="link-dismiss">${c.status === 'declined' ? 'Reopen opportunity' : 'Dismiss'}</button>${['contacted', 'replied', 'linked'].includes(c.status) ? '' : '<button class="secondary" id="link-mark-sent">Mark as sent</button>'}</div><p class="small" id="link-feedback" role="status"></p>`;
    $('link-close').onclick = () => { selectedLink = null; linkDraft = null; panel.hidden = true; };
    const action = (id, work) => { $(id).onclick = async () => { $(id).disabled = true; try { await work(); } catch (err) { $('link-feedback').textContent = err.message; if ($(id)) $(id).disabled = false; } }; };
    action('link-draft', async () => {
      const id = c.draft || (await post(`/api/outreach/${c.id}/draft`)).draftId;
      c.draft = id; c.status = 'drafted';
      linkDraft = await api(`/api/drafts/${id}`);
      renderLinkWorkspace();
    });
    action('link-check', async () => { await post(`/api/outreach/${c.id}/verify`); await refresh(); });
    action('link-dismiss', async () => { await api(`/api/outreach/${c.id}`, { method: 'PUT', body: JSON.stringify({ status: c.status === 'declined' ? 'found' : 'declined', notes: $('link-dismiss-reason').value.trim() ? [c.notes, 'Dismissed: ' + $('link-dismiss-reason').value.trim()].filter(Boolean).join('\n') : c.notes }) }); selectedLink = null; linkDraft = null; await refresh(); });
    if ($('link-mark-sent')) action('link-mark-sent', async () => { await post(`/api/outreach/${c.id}/sent`); selectedLink = null; linkDraft = null; linkFilter = 'sent'; await refresh(); });
    $('link-notes-form').onsubmit = async e => { e.preventDefault(); try { const f = new FormData(e.target); await api(`/api/outreach/${c.id}`, { method: 'PUT', body: JSON.stringify(Object.fromEntries(f)) }); await refresh(); $('link-feedback').textContent = 'Details saved.'; } catch (err) { $('link-feedback').textContent = err.message; } };
    if (c.status === 'declined') { $('link-draft').hidden = true; if ($('link-mark-sent')) $('link-mark-sent').hidden = true; }
    if (linkDraft && c.status !== 'declined') {
      const d = linkDraft;
      const editable = ['draft', 'failed'].includes(d.status);
      $('link-message').innerHTML = `<h4>Your request</h4><p class="small">${d.meta.to ? 'To: ' + esc(d.meta.to) : 'Send using the website’s contact form'}</p>${editable ? `<label>Subject<input id="link-subject" value="${esc(d.meta.subject || '')}"></label><label>Message<textarea id="link-body" rows="9" dir="auto">${esc(d.body)}</textarea></label><div class="link-actions"><button id="link-send">${d.meta.to && data.email.connected ? 'Approve & send' : 'Copy message & open website'}</button><button class="secondary" id="link-save">Save draft</button></div>` : `<p class="muted">${esc(d.status === 'approved' ? 'Request approved and waiting to send.' : 'This request is ' + d.status + '.')}</p><a href="#draft/${d.id}">View request →</a>`}`;
      $('link-draft').hidden = true;
      const save = async () => { linkDraft = await api(`/api/drafts/${d.id}`, { method: 'PUT', body: JSON.stringify({ body: $('link-body').value, meta: { subject: $('link-subject').value } }) }); };
      if (editable) {
        action('link-save', async () => { await save(); $('link-feedback').textContent = 'Draft saved.'; $('link-save').disabled = false; });
        action('link-send', async () => {
          if (!d.meta.to || !data.email.connected) {
            const text = $('link-subject').value + '\n\n' + $('link-body').value;
            await navigator.clipboard.writeText(text);
            window.open(new URL(c.url).origin, '_blank', 'noopener');
            await save(); $('link-feedback').textContent = 'Message copied. After sending it on their website, choose “Mark as sent”.'; $('link-send').disabled = false;
          } else {
            await save(); const result = await post(`/api/drafts/${d.id}/approve`, { target: 'email' });
            if (result.status === 'failed') throw new Error(result.error || 'Sending failed. Open the request to see details.');
            linkDraft = result; await refresh();
          }
        });
      }
    }
  }

  // ---- the draft view: who an outreach message goes to, and video previews for scripts ----
  const extra = document.createElement('div');
  extra.id = 'draft-extra';
  $('draft-body').before(extra);
  const OUTREACH = ['outreach_email', 'outreach_message'];

  async function wireDraft(d) {
    extra.innerHTML = '';
    if (OUTREACH.includes(d.kind)) {
      const editable = d.status === 'draft' || d.status === 'failed';
      extra.innerHTML = `<div class="seo-fields">
        <label>To ${d.meta.to ? `<input value="${esc(d.meta.to)}" disabled>` : `<span class="muted">${esc(d.meta.howToSend ?? 'Send it yourself.')}</span>`}</label>
        <label>Subject <input id="draft-subject" dir="auto" value="${esc(d.meta.subject ?? '')}" ${editable ? '' : 'disabled'}></label>
      </div>
      ${d.meta.contactUrl ? `<p class="small muted">About: <a href="${esc(d.meta.contactUrl)}" target="_blank" rel="noopener">${esc(d.meta.contactUrl)}</a> · <a href="#outreach">Outreach list</a></p>` : ''}`;
      const s = $('draft-subject');
      // Saved on its own as it changes; the main Save button keeps the body and title.
      if (s) s.onchange = () => api(`/api/drafts/${d.id}`, { method: 'PUT', body: JSON.stringify({ meta: { subject: s.value } }) }).catch((err) => alert(err.message));
      return;
    }
    if (d.kind !== 'video_script') return;
    const editable = d.status === 'draft' || d.status === 'failed';
    extra.innerHTML = `<div class="video-box">
      <div class="editor-bar"><span class="small" id="foot-msg"><strong>Your video</strong> <span class="muted">— film the script, then add the finished video here. This is what gets posted as a Reel, with the caption below.</span></span><span><label class="small-btn" id="foot-pick" ${editable ? '' : 'hidden'}>Add video<input type="file" id="foot-file" accept="video/mp4,video/quicktime,.mp4,.mov" hidden></label> <button id="foot-remove" class="secondary small-btn" hidden>Remove</button></span></div>
      <progress id="foot-progress" max="100" value="0" hidden></progress>
      <div id="foot-player" class="vid-players"></div>
      <div class="editor-bar"><span class="small muted" id="vid-msg">A quick preview: each scene's on-screen text on your brand colours, timed like the script. It is only for checking timing and is never posted.</span><span><button id="vid-make" class="secondary">Make preview</button></span></div><div id="vid-players" class="vid-players"></div></div>`;
    const footMsg = (text, cls = 'small bad') => {
      $('foot-msg').className = cls;
      $('foot-msg').textContent = text;
    };
    $('foot-file').onchange = () => {
      const file = $('foot-file').files[0];
      if (!file) return;
      // XMLHttpRequest, not fetch: it is the only way to show how far an upload has got.
      const xhr = new XMLHttpRequest();
      xhr.open('POST', `/api/video/${d.id}/footage`);
      xhr.setRequestHeader('x-plume-site', SITE);
      xhr.setRequestHeader('content-type', /\.mov$/i.test(file.name) ? 'video/quicktime' : 'video/mp4');
      $('foot-progress').hidden = false;
      $('foot-pick').hidden = true;
      xhr.upload.onprogress = (e) => e.lengthComputable && ($('foot-progress').value = Math.round((e.loaded / e.total) * 100));
      xhr.onloadend = () => {
        $('foot-progress').hidden = true;
        $('foot-file').value = '';
        if (xhr.status !== 200) {
          let why = xhr.statusText || 'the upload did not finish';
          try {
            why = JSON.parse(xhr.responseText).error || why;
          } catch {}
          footMsg(`Upload failed: ${why}`);
        }
        show();
      };
      xhr.send(file);
    };
    $('foot-remove').onclick = async () => {
      if (!(await confirmBox('Remove your uploaded video from this draft?', { title: 'Remove video?', ok: 'Remove', danger: true }))) return;
      try {
        await api(`/api/video/${d.id}/footage`, { method: 'DELETE' });
      } catch (err) {
        footMsg(err.message);
      }
      show();
    };
    const show = async () => {
      if (currentDraft !== d.id) return;
      const v = await api(`/api/video/${d.id}`);
      const f = v.footage;
      $('foot-pick').hidden = !editable || !$('foot-progress').hidden;
      $('foot-pick').firstChild.textContent = f ? 'Replace video' : 'Add video';
      $('foot-remove').hidden = !editable || !f;
      $('foot-player').innerHTML = f
        ? `<figure><video controls preload="metadata" src="${withSite(`/api/video/${d.id}/${f.file}`)}&t=${encodeURIComponent(f.at)}"></video><figcaption class="small muted">${(f.bytes / 1048576).toFixed(1)} MB · added ${esc(when(f.at))}</figcaption></figure>`
        : `<p class="small muted">No video yet. Approving to Facebook or Instagram needs one.</p>`;
      $('vid-make').disabled = !!v.running;
      $('vid-make').textContent = v.running ? v.running : v.previews.length ? 'Make again' : 'Make preview';
      $('vid-players').innerHTML = v.previews
        .map((p) => `<figure><video controls preload="metadata" src="${withSite(`/api/video/${d.id}/${p.file}`)}&t=${encodeURIComponent(p.at ?? '')}"></video><figcaption class="small muted">${esc(v.sizes[p.size] ?? p.size)} · <a href="${withSite(`/api/video/${d.id}/${p.file}`)}" download="${esc(p.file)}">download</a></figcaption></figure>`)
        .join('');
      if (v.running) setTimeout(show, 2000);
    };
    $('vid-make').onclick = async () => {
      // Edits to the script count, so save them first.
      try {
        await api(`/api/drafts/${d.id}`, { method: 'PUT', body: JSON.stringify({ body: $('draft-body').value }) });
        await post(`/api/video/${d.id}/render`);
      } catch (err) {
        $('vid-msg').className = 'small bad';
        $('vid-msg').textContent = err.message;
      }
      show();
    };
    show();
  }

  window.plumeOutreach = { load, wireDraft };
})();
