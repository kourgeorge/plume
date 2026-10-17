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
      <span class="actions"><button id="or-find">Find creators</button></span>
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
    if (k === 'creator' || k === 'link') kind = k;
    await refresh();
  }

  for (const b of $('or-tabs').querySelectorAll('button')) b.onclick = () => ((kind = b.dataset.kind), refresh());

  $('or-find').onclick = async () => {
    $('or-find').disabled = true;
    try {
      await post('/api/outreach/discover', { kind });
    } catch (err) {
      alert(err.message);
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

  // ---- the draft view: who an outreach message goes to, and video previews for scripts ----
  const extra = document.createElement('div');
  extra.id = 'draft-extra';
  $('draft-body').before(extra);
  const OUTREACH = ['outreach_email', 'outreach_message'];

  async function wireDraft(d) {
    const seo = document.querySelector('#view-draft .seo-fields');
    if (seo) seo.hidden = OUTREACH.includes(d.kind) || d.kind === 'video_script';
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
    extra.innerHTML = `<div class="video-box"><div class="editor-bar"><span class="small muted" id="vid-msg">A quick preview: each scene's on-screen text on your brand colours, timed like the script. Film the real clips from the shot list.</span><span><button id="vid-make" class="secondary">Make preview</button></span></div><div id="vid-players" class="vid-players"></div></div>`;
    const show = async () => {
      if (currentDraft !== d.id) return;
      const v = await api(`/api/video/${d.id}`);
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
