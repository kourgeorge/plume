// Client & White-Label Reporting view.
// Uses $, esc, api, post, showView from app.js.
(() => {
  const section = document.createElement('section');
  section.id = 'view-report';
  section.className = 'view';
  section.hidden = true;
  section.innerHTML = `
    <div class="view-head">
      <a href="#dashboard" class="back">← Dashboard</a>
      <h1>Client Report</h1>
      <span class="actions">
        <a id="rep-open-html" target="_blank" rel="noopener"><button class="btn-primary" style="background:#2f6f5e;color:#fff;font-weight:600">🖨️ View Print-Ready Report</button></a>
        <a id="rep-dl-md" download="client-report.md"><button class="secondary">Download Markdown</button></a>
      </span>
    </div>
    <p class="muted">Generate white-label, client-ready performance and growth reports covering SEO audits, AI visibility benchmarks, organic search traffic, and published content.</p>

    <!-- Agency & White-Label Branding Card -->
    <details class="card" id="rep-settings-box" style="margin-bottom:20px;padding:16px;">
      <summary style="cursor:pointer;font-weight:600;font-size:14px;color:var(--brand)">⚙️ White-Label &amp; Agency Branding Settings</summary>
      <div class="form" style="margin-top:14px;">
        <label>Agency Name <input id="rep-cfg-agency" placeholder="Your Agency Name"></label>
        <label>Agency Tagline <input id="rep-cfg-tagline" placeholder="Growth &amp; Search Optimization"></label>
        <label>Prepared By <input id="rep-cfg-by" placeholder="Your Name or Team"></label>
        <label>Prepared For (Client Name) <input id="rep-cfg-for" placeholder="Client / Business Name"></label>
        <label class="wide">Executive Notes / Summary for Client
          <textarea id="rep-cfg-notes" rows="3" placeholder="Add custom commentary, highlights or next steps for the client…"></textarea>
        </label>
      </div>
      <p class="actions-row" style="margin-top:12px;">
        <button id="rep-save-cfg">Save Report Settings</button>
        <span id="rep-cfg-msg" class="small muted"></span>
      </p>
    </details>

    <div id="rep-loading" class="muted small" style="margin-bottom:12px;">Loading report data…</div>
    <div id="rep-content" hidden></div>
  `;
  $('col-center').appendChild(section);

  async function load() {
    showView('report');
    $('rep-loading').hidden = false;
    $('rep-content').hidden = true;

    try {
      const [data, settings] = await Promise.all([
        api('/api/report'),
        api('/api/report/settings'),
      ]);

      $('rep-cfg-agency').value = settings.agencyName || '';
      $('rep-cfg-tagline').value = settings.agencyTagline || '';
      $('rep-cfg-by').value = settings.preparedBy || '';
      $('rep-cfg-for').value = settings.preparedFor || '';
      $('rep-cfg-notes').value = settings.customNotes || '';

      $('rep-open-html').href = withSite('/api/report/html');
      $('rep-dl-md').href = withSite('/api/report/markdown');
      $('rep-dl-md').download = `${(data.siteName || 'client').replace(/[^a-zA-Z0-9_-]/g, '_')}-report.md`;

      const scoreClass = (s) => (s === null ? 'muted' : s >= 80 ? 'good' : s >= 50 ? 'warn' : 'bad');

      $('rep-content').innerHTML = `
        <div class="folders" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px;margin-bottom:20px;">
          <div class="card" style="text-align:center;padding:16px;">
            <div class="muted small" style="font-weight:600;text-transform:uppercase;">Overall Health</div>
            <div style="font-size:28px;font-weight:700;margin:4px 0" class="${scoreClass(data.executiveSummary.overallScore)}">${data.executiveSummary.overallScore}/100</div>
          </div>
          <div class="card" style="text-align:center;padding:16px;">
            <div class="muted small" style="font-weight:600;text-transform:uppercase;">Technical SEO</div>
            <div style="font-size:28px;font-weight:700;margin:4px 0" class="${scoreClass(data.executiveSummary.seoScore)}">${data.executiveSummary.seoScore !== null ? `${data.executiveSummary.seoScore}/100` : '—'}</div>
          </div>
          <div class="card" style="text-align:center;padding:16px;">
            <div class="muted small" style="font-weight:600;text-transform:uppercase;">AI (GEO) Visibility</div>
            <div style="font-size:28px;font-weight:700;margin:4px 0" class="${scoreClass(data.executiveSummary.geoScore)}">${data.executiveSummary.geoScore !== null ? `${data.executiveSummary.geoScore}%` : '—'}</div>
          </div>
          <div class="card" style="text-align:center;padding:16px;">
            <div class="muted small" style="font-weight:600;text-transform:uppercase;">Search Clicks (28d)</div>
            <div style="font-size:28px;font-weight:700;margin:4px 0">${data.executiveSummary.totalClicks.toLocaleString()}</div>
          </div>
        </div>

        <!-- Section: SEO Audit -->
        <div class="card" style="margin-bottom:20px;padding:16px;">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
            <h2 style="margin:0;font-size:16px;">Technical SEO Health</h2>
            <span class="tag ${scoreClass(data.seoAudit.score)}">${data.seoAudit.score !== null ? `${data.seoAudit.score}/100` : 'No audit'}</span>
          </div>
          <p class="small muted" style="margin:0 0 12px;">${data.seoAudit.pagesChecked} pages checked · ${data.seoAudit.counts.passed} passed · ${data.seoAudit.counts.warnings} warnings · ${data.seoAudit.counts.critical} critical issues</p>
          ${data.seoAudit.topIssues.length ? `
            <table class="tool-table">
              <thead><tr><th>Severity</th><th>Issue</th><th>Page</th></tr></thead>
              <tbody>
                ${data.seoAudit.topIssues.slice(0, 5).map((i) => `
                  <tr>
                    <td><span class="tag ${i.severity === 'critical' ? 'bad' : i.severity === 'high' ? 'warn' : 'muted'}">${esc(i.severity)}</span></td>
                    <td><strong>${esc(i.title)}</strong><br><small class="muted">${esc(i.why)}</small></td>
                    <td class="small" style="max-width:180px;word-break:break-all;">${esc(i.url)}</td>
                  </tr>
                `).join('')}
              </tbody>
            </table>
          ` : '<p class="good small">✓ No open issues found.</p>'}
        </div>

        <!-- Section: AI Visibility -->
        <div class="card" style="margin-bottom:20px;padding:16px;">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
            <h2 style="margin:0;font-size:16px;">AI Engine Visibility (GEO)</h2>
            <span class="tag ${scoreClass(data.geoVisibility.score)}">${data.geoVisibility.score !== null ? `${data.geoVisibility.score}% cited` : 'No test run'}</span>
          </div>
          <p class="small muted" style="margin:0 0 12px;">Brand cited in ${data.geoVisibility.mentioned} of ${data.geoVisibility.answered} tested search prompt answers across ChatGPT, Claude and Gemini.</p>
          ${data.geoVisibility.topQuestions.length ? `
            <table class="tool-table">
              <thead><tr><th>Prompt Query</th><th>Result</th><th>Rank</th></tr></thead>
              <tbody>
                ${data.geoVisibility.topQuestions.slice(0, 5).map((q) => `
                  <tr>
                    <td>"${esc(q.question)}"</td>
                    <td><span class="tag ${q.mentioned ? 'good' : 'bad'}">${q.mentioned ? 'Cited ✓' : 'Not Cited'}</span></td>
                    <td>${q.position ? `#${q.position}` : '—'}</td>
                  </tr>
                `).join('')}
              </tbody>
            </table>
          ` : '<p class="muted small">Run an AI Visibility check from the Dashboard to see citation benchmarks.</p>'}
        </div>

        <!-- Section: Search Queries -->
        <div class="card" style="margin-bottom:20px;padding:16px;">
          <h2 style="margin:0 0 8px;font-size:16px;">Top Organic Search Queries (28d)</h2>
          ${data.searchAnalytics.topQueries.length ? `
            <table class="tool-table">
              <thead><tr><th>Query</th><th>Clicks</th><th>Impressions</th><th>Position</th></tr></thead>
              <tbody>
                ${data.searchAnalytics.topQueries.slice(0, 6).map((q) => `
                  <tr>
                    <td><strong>${esc(q.query)}</strong></td>
                    <td>${q.clicks}</td>
                    <td>${q.impressions.toLocaleString()}</td>
                    <td>${q.position}</td>
                  </tr>
                `).join('')}
              </tbody>
            </table>
          ` : '<p class="muted small">Connect Google Search Console in Integrations to populate live search analytics.</p>'}
        </div>

        <!-- Section: Published Output -->
        <div class="card" style="padding:16px;">
          <h2 style="margin:0 0 8px;font-size:16px;">Published Marketing Content (${data.contentOutput.published.length})</h2>
          ${data.contentOutput.published.length ? `
            <table class="tool-table">
              <thead><tr><th>Title</th><th>Agent</th><th>Date</th></tr></thead>
              <tbody>
                ${data.contentOutput.published.slice(0, 8).map((p) => `
                  <tr>
                    <td>${p.url ? `<a href="${esc(p.url)}" target="_blank" rel="noopener">${esc(p.title)} ↗</a>` : esc(p.title)}</td>
                    <td><span class="tag muted">${esc(p.agent)}</span></td>
                    <td class="small muted">${esc(p.publishedAt.slice(0, 10))}</td>
                  </tr>
                `).join('')}
              </tbody>
            </table>
          ` : '<p class="muted small">No published content recorded yet.</p>'}
        </div>
      `;

      $('rep-loading').hidden = true;
      $('rep-content').hidden = false;
    } catch (err) {
      $('rep-loading').textContent = `Failed to load report data: ${err.message}`;
    }
  }

  $('rep-save-cfg').onclick = async () => {
    $('rep-cfg-msg').textContent = 'Saving…';
    try {
      await post('/api/report/settings', {
        agencyName: $('rep-cfg-agency').value,
        agencyTagline: $('rep-cfg-tagline').value,
        preparedBy: $('rep-cfg-by').value,
        preparedFor: $('rep-cfg-for').value,
        customNotes: $('rep-cfg-notes').value,
      });
      $('rep-cfg-msg').textContent = 'Saved!';
      setTimeout(() => ($('rep-cfg-msg').textContent = ''), 2000);
      load();
    } catch (err) {
      $('rep-cfg-msg').textContent = err.message;
    }
  };

  window.plumeReport = { load };
})();
