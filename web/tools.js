// Free tools (no AI): meta tag checker, robots.txt, sitemap, UTM links, structured data.
// Uses $, esc, api, post and showView from app.js (loaded first). Builds its own view section.
(() => {
  const section = document.createElement('section');
  section.id = 'view-tools';
  section.className = 'view';
  section.hidden = true;
  section.innerHTML = `
    <div class="view-head"><a href="#today" class="back">← Today</a><h1>Tools</h1></div>
    <p class="muted">Free helpers — no AI, nothing is changed on your site. Each one gives you text to copy into your site or share. Your <a href="#llms">llms.txt</a> has its own page.</p>
    <div class="tabs" id="tl-tabs">
      <button data-tool="meta">Meta tag checker</button><button data-tool="robots">robots.txt</button><button data-tool="sitemap">Sitemap</button>
      <button data-tool="utm">Campaign links (UTM)</button><button data-tool="schema">Structured data</button>
    </div>

    <div class="tool" data-tool="meta">
      <p class="muted small">How a page looks to Google and in shared-link previews, and what's missing.</p>
      <form id="tl-meta" class="rk-form"><input id="tl-meta-url" placeholder="https://…" spellcheck="false"><button type="submit">Check</button><span id="tl-meta-msg" class="small"></span></form>
      <div id="tl-meta-out"></div>
    </div>

    <div class="tool" data-tool="robots" hidden>
      <p class="muted small">robots.txt tells crawlers what they may read. Put it at the top of your site (yourdomain.com/robots.txt).</p>
      <div class="form">
        <label class="check"><input type="checkbox" id="tl-r-search" checked> Let AI answer engines read the site (ChatGPT, Claude, Perplexity, Gemini) — recommended, or they can't recommend you</label>
        <label class="check"><input type="checkbox" id="tl-r-train"> Also let crawlers that only collect text for training AI models</label>
        <label class="wide">Keep all crawlers out of (one path per line) <textarea id="tl-r-dis" rows="3" placeholder="/admin&#10;/cart" spellcheck="false"></textarea></label>
        <label class="wide">Sitemap address <input id="tl-r-sitemap" spellcheck="false"></label>
      </div>
      <p class="actions-row"><button id="tl-r-make">Make robots.txt</button></p>
      <div id="tl-r-out"></div>
    </div>

    <div class="tool" data-tool="sitemap" hidden>
      <p class="muted small">A list of your pages for search engines, from the pages Plume read during the last site check — only ones that load and aren't copies of another page. Save it as sitemap.xml at the top of your site, then add it in Google Search Console.</p>
      <p class="actions-row"><button id="tl-s-make">Make sitemap.xml</button> <span id="tl-s-msg" class="small muted"></span></p>
      <div id="tl-s-out"></div>
    </div>

    <div class="tool" data-tool="utm" hidden>
      <p class="muted small">Add these to links you share in newsletters, ads or posts, so Google Analytics shows which ones bring visitors.</p>
      <div class="form">
        <label class="wide">Page address <input id="tl-u-url" spellcheck="false"></label>
        <label>Source <input id="tl-u-source" placeholder="newsletter, linkedin, partner-site"></label>
        <label>Medium <input id="tl-u-medium" placeholder="email, social, cpc"></label>
        <label>Campaign <input id="tl-u-campaign" placeholder="autumn-sale"></label>
        <label>Content <span class="muted">(optional)</span><input id="tl-u-content" placeholder="top-button"></label>
      </div>
      <p class="actions-row"><button id="tl-u-make">Make link</button> <span id="tl-u-msg" class="small"></span></p>
      <div id="tl-u-out"></div>
    </div>

    <div class="tool" data-tool="schema" hidden>
      <p class="muted small">Structured data tells Google and AI assistants exactly what a page is. Paste the result into the page's &lt;head&gt;, then check it with Google's <a href="https://search.google.com/test/rich-results" target="_blank" rel="noopener">Rich Results Test</a>.</p>
      <div class="tabs" id="tl-sc-kind"><button data-kind="organization">Your business</button><button data-kind="faq">Questions and answers</button><button data-kind="article">Article</button></div>
      <div class="form" id="tl-sc-form"></div>
      <p class="actions-row"><button id="tl-sc-make">Make code</button> <span id="tl-sc-msg" class="small"></span></p>
      <div id="tl-sc-out"></div>
    </div>`;
  $('col-center').appendChild(section);

  let defaults = null;
  let tool = 'meta';
  let kind = 'organization';

  function outBox(id, text, filename) {
    $(id).innerHTML = `<div class="tool-out"><textarea readonly rows="${Math.min(18, text.split('\n').length + 1)}" spellcheck="false">${esc(text)}</textarea>
      <p class="actions-row"><button class="secondary" data-copy>Copy</button>${filename ? ` <button class="secondary" data-save>Download ${esc(filename)}</button>` : ''}</p></div>`;
    $(id).querySelector('[data-copy]').onclick = (e) => navigator.clipboard?.writeText(text).then(() => (e.target.textContent = 'Copied'));
    const save = $(id).querySelector('[data-save]');
    if (save) save.onclick = () => {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
      a.download = filename;
      a.click();
      URL.revokeObjectURL(a.href);
    };
  }
  const fail = (id, err) => (($(id).className = 'small bad'), ($(id).textContent = err.message));
  const ok = (id, text = '') => (($(id).className = 'small muted'), ($(id).textContent = text));

  function showTool(t) {
    tool = t;
    for (const b of $('tl-tabs').querySelectorAll('button')) b.classList.toggle('on', b.dataset.tool === t);
    for (const el of section.querySelectorAll('.tool')) el.hidden = el.dataset.tool !== t;
  }

  async function load(t) {
    showView('tools');
    defaults = defaults ?? (await api('/api/tools'));
    if (!$('tl-meta-url').value) $('tl-meta-url').value = defaults.site;
    if (!$('tl-r-sitemap').value) $('tl-r-sitemap').value = defaults.sitemapUrl;
    if (!$('tl-u-url').value) $('tl-u-url').value = defaults.site;
    $('tl-s-msg').textContent = defaults.sitemapPages ? `${defaults.sitemapPages} page(s) to list.` : 'Run the site check first, so Plume has read your pages.';
    $('tl-s-make').disabled = !defaults.sitemapPages;
    if (!$('tl-sc-form').innerHTML) schemaForm();
    showTool(['meta', 'robots', 'sitemap', 'utm', 'schema'].includes(t) ? t : tool);
  }

  for (const b of $('tl-tabs').querySelectorAll('button')) b.onclick = () => showTool(b.dataset.tool);

  // ---- meta
  $('tl-meta').onsubmit = async (e) => {
    e.preventDefault();
    ok('tl-meta-msg', 'Reading the page…');
    $('tl-meta-out').innerHTML = '';
    try {
      const r = await post('/api/tools/meta', { url: $('tl-meta-url').value });
      ok('tl-meta-msg');
      const row = (k, v, limit) => `<tr><th>${esc(k)}</th><td dir="auto">${v ? esc(v) : '<span class="muted">—</span>'}${limit && v ? ` <small class="${v.length > limit ? 'warn' : 'muted'}">${v.length}</small>` : ''}</td></tr>`;
      $('tl-meta-out').innerHTML = `
        ${r.problems.length ? `<ul class="tool-list">${r.problems.map((p) => `<li class="warn">${esc(p)}</li>`).join('')}</ul>` : '<p class="good">Nothing missing.</p>'}
        ${r.good.length ? `<ul class="tool-list">${r.good.map((p) => `<li class="good">✓ ${esc(p)}</li>`).join('')}</ul>` : ''}
        <div class="serp-preview"><div class="small muted">${esc(r.url)}</div><div class="serp-title" dir="auto">${esc(r.title || '(no title)')}</div><div class="small" dir="auto">${esc(r.description || '(no description — Google picks text from the page)')}</div></div>
        <table class="tool-table">${row('Title', r.title, 60)}${row('Description', r.description, 155)}${row('Canonical', r.canonical)}${row('Robots', r.robots)}${row('Language', r.lang)}
          ${row('Share title (og:title)', r.og.title)}${row('Share text (og:description)', r.og.description)}${row('Share image (og:image)', r.og.image)}${row('X card (twitter:card)', r.twitter.card)}</table>`;
    } catch (err) {
      fail('tl-meta-msg', err);
    }
  };

  // ---- robots
  $('tl-r-make').onclick = async () => {
    try {
      const r = await post('/api/tools/robots', { aiSearch: $('tl-r-search').checked, aiTraining: $('tl-r-train').checked, disallow: $('tl-r-dis').value.split('\n'), sitemap: $('tl-r-sitemap').value });
      outBox('tl-r-out', r.text, 'robots.txt');
    } catch (err) {
      $('tl-r-out').innerHTML = `<p class="bad small">${esc(err.message)}</p>`;
    }
  };

  // ---- sitemap
  $('tl-s-make').onclick = async () => {
    try {
      const r = await post('/api/tools/sitemap');
      ok('tl-s-msg', `${r.count} page(s).`);
      outBox('tl-s-out', r.text, 'sitemap.xml');
    } catch (err) {
      fail('tl-s-msg', err);
    }
  };

  // ---- UTM
  $('tl-u-make').onclick = async () => {
    try {
      const body = Object.fromEntries(['url', 'source', 'medium', 'campaign', 'content'].map((k) => [k, $(`tl-u-${k}`).value]));
      const r = await post('/api/tools/utm', body);
      ok('tl-u-msg');
      outBox('tl-u-out', r.text);
    } catch (err) {
      fail('tl-u-msg', err);
    }
  };

  // ---- structured data
  function schemaForm() {
    for (const b of $('tl-sc-kind').querySelectorAll('button')) b.classList.toggle('on', b.dataset.kind === kind);
    const d = defaults ?? { name: '', site: '', author: '', sameAs: [] };
    const f = $('tl-sc-form');
    if (kind === 'organization') {
      f.innerHTML = `<label>Business name <input data-k="name" value="${esc(d.name)}" dir="auto"></label>
        <label>Website <input data-k="url" value="${esc(d.site)}" spellcheck="false"></label>
        <label>Logo address <span class="muted">(optional)</span><input data-k="logo" placeholder="https://…/logo.png" spellcheck="false"></label>
        <label class="wide">One-line description <span class="muted">(optional)</span><input data-k="description" dir="auto"></label>
        <label class="wide">Your profiles elsewhere, one per line <textarea data-k="sameAs" rows="3" spellcheck="false">${esc(d.sameAs.join('\n'))}</textarea></label>`;
    } else if (kind === 'faq') {
      f.innerHTML = `<p class="muted small wide">Only questions that are answered on the page itself — Google ignores the rest.</p>
        <div class="wide" id="tl-faq">${[0, 1, 2].map(faqRow).join('')}</div>
        <p class="wide"><button type="button" class="secondary" id="tl-faq-add">Add a question</button></p>`;
      $('tl-faq-add').onclick = () => $('tl-faq').insertAdjacentHTML('beforeend', faqRow());
    } else {
      f.innerHTML = `<label class="wide">Headline <input data-k="headline" dir="auto"></label>
        <label>Author <input data-k="author" value="${esc(d.author)}" dir="auto"></label>
        <label>Published on <input data-k="datePublished" type="date"></label>
        <label>Main image address <span class="muted">(optional)</span><input data-k="image" spellcheck="false"></label>
        <label>Publisher <input data-k="name" value="${esc(d.name)}" dir="auto"></label>`;
    }
  }
  const faqRow = () => `<div class="faq-row"><input data-q placeholder="Question" dir="auto"><textarea data-a rows="2" placeholder="Answer, as written on the page" dir="auto"></textarea></div>`;
  for (const b of $('tl-sc-kind').querySelectorAll('button')) b.onclick = () => ((kind = b.dataset.kind), ($('tl-sc-out').innerHTML = ''), schemaForm());
  $('tl-sc-make').onclick = async () => {
    const body = { kind };
    for (const el of $('tl-sc-form').querySelectorAll('[data-k]')) body[el.dataset.k] = el.dataset.k === 'sameAs' ? el.value.split('\n') : el.value;
    if (kind === 'faq') body.faq = [...$('tl-sc-form').querySelectorAll('.faq-row')].map((r) => ({ q: r.querySelector('[data-q]').value, a: r.querySelector('[data-a]').value }));
    try {
      const r = await post('/api/tools/schema', body);
      ok('tl-sc-msg');
      outBox('tl-sc-out', r.text);
    } catch (err) {
      fail('tl-sc-msg', err);
    }
  };

  window.plumeTools = { load };
})();
