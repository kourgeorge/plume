import { getSetting, setSetting } from '../db';
import { currentSite, currentSiteOrNull } from '../site';
import { getSite, siteUrl } from '../sites';
import { AuditResult, Issue } from '../agents/seoAudit';
import { visibilitySummary } from '../geo/visibility';
import { resultsSummary, topPages, topQueries } from '../analytics/results';
import { rankingsTable } from '../seo/rankings';
import { listDrafts } from '../queue';
import { readDoc } from '../context/profile';
import { listCompetitors } from '../context/extra';
import { escapeHtml } from '../publish';

export interface ReportSettings {
  agencyName: string;
  agencyTagline: string;
  preparedBy: string;
  preparedFor: string;
  logoUrl: string;
  customNotes: string;
}

export function getReportSettings(): ReportSettings {
  const saved = getSetting<Partial<ReportSettings>>('reportSettings', {});
  const slug = currentSiteOrNull();
  const site = slug ? getSite(slug) : null;
  return {
    agencyName: saved.agencyName ?? 'Plume Marketing Intelligence',
    agencyTagline: saved.agencyTagline ?? 'AI-Powered Growth & Search Engine Optimization',
    preparedBy: saved.preparedBy ?? '',
    preparedFor: saved.preparedFor ?? site?.name ?? '',
    logoUrl: saved.logoUrl ?? '',
    customNotes: saved.customNotes ?? '',
  };
}

export function saveReportSettings(settings: Partial<ReportSettings>): ReportSettings {
  const current = getReportSettings();
  const next: ReportSettings = {
    agencyName: String(settings.agencyName ?? current.agencyName).trim(),
    agencyTagline: String(settings.agencyTagline ?? current.agencyTagline).trim(),
    preparedBy: String(settings.preparedBy ?? current.preparedBy).trim(),
    preparedFor: String(settings.preparedFor ?? current.preparedFor).trim(),
    logoUrl: String(settings.logoUrl ?? current.logoUrl).trim(),
    customNotes: String(settings.customNotes ?? current.customNotes).trim(),
  };
  setSetting('reportSettings', next);
  return next;
}

export interface ClientReportData {
  generatedAt: string;
  siteName: string;
  siteUrl: string;
  settings: ReportSettings;
  executiveSummary: {
    overallScore: number;
    seoScore: number | null;
    geoScore: number | null;
    totalClicks: number;
    totalImpressions: number;
    totalViews: number | null;
    publishedCount: number;
  };
  seoAudit: {
    score: number | null;
    counts: { critical: number; warnings: number; passed: number };
    topIssues: Issue[];
    pagesChecked: number;
  };
  geoVisibility: {
    score: number | null;
    answered: number;
    mentioned: number;
    avgPosition: number | null;
    perEngine: { engine: string; label: string; mentioned: number; answered: number; avgPosition: number | null }[];
    topQuestions: { question: string; mentioned: boolean; position: number | null; sentiment: string | null }[];
    shareOfVoice: { name: string; answers: number; you: boolean }[];
  };
  searchAnalytics: {
    days: number;
    clicks: number;
    impressions: number;
    avgPosition: number | null;
    topQueries: { query: string; clicks: number; impressions: number; ctr: number; position: number }[];
    topPages: { page: string; views: number | null; clicks: number; impressions: number }[];
  };
  rankings: {
    trackedCount: number;
    items: { query: string; position: number | null; change: number | null; bestUrl: string | null }[];
  };
  contentOutput: {
    totalDrafts: number;
    published: { id: number; title: string; agent: string; publishedAt: string; url: string | null }[];
  };
  competitors: { name: string; url: string | null }[];
  notes: string;
}

export function buildClientReportData(custom?: Partial<ReportSettings>): ClientReportData {
  const settings = { ...getReportSettings(), ...(custom ?? {}) };
  const slug = currentSiteOrNull();
  const site = slug ? getSite(slug) : null;
  const name = settings.preparedFor || site?.name || currentSite();
  const url = siteUrl() || '';

  // 1. SEO Audit
  const lastAudit = getSetting<AuditResult | null>('lastAudit', null);
  const seoAudit = {
    score: lastAudit?.score ?? null,
    counts: lastAudit?.counts ?? { critical: 0, warnings: 0, passed: 0 },
    topIssues: (lastAudit?.issues ?? []).slice(0, 10),
    pagesChecked: lastAudit?.pagesChecked ?? 0,
  };

  // 2. GEO / AI Visibility
  const geo = visibilitySummary();
  const geoVisibility = {
    score: geo?.overall.score ?? null,
    answered: geo?.overall.answered ?? 0,
    mentioned: geo?.overall.mentioned ?? 0,
    avgPosition: geo?.overall.avgPosition ?? null,
    perEngine: geo?.perEngine ?? [],
    topQuestions: (geo?.questions ?? []).slice(0, 10).map((q) => {
      const cells = Object.values(q.cells);
      const isMentioned = cells.some((c) => c?.mentioned);
      const bestPos = cells.map((c) => c?.position).filter((p): p is number => p !== null).sort((a, b) => a - b)[0] ?? null;
      const sentiment = cells.find((c) => c?.sentiment)?.sentiment ?? null;
      return { question: q.question, mentioned: isMentioned, position: bestPos, sentiment };
    }),
    shareOfVoice: (geo?.shareOfVoice ?? []).slice(0, 8),
  };

  // 3. Search & Traffic
  const results = resultsSummary(28);
  const queries = topQueries(12, 28);
  const pages = topPages(10, 28);
  const searchAnalytics = {
    days: 28,
    clicks: results.now.clicks,
    impressions: results.now.impressions,
    avgPosition: results.now.position ? Math.round(results.now.position * 10) / 10 : null,
    topQueries: queries.map((q) => ({
      query: q.query,
      clicks: q.clicks,
      impressions: q.impressions,
      ctr: Math.round(q.ctr * 1000) / 10,
      position: Math.round(q.position * 10) / 10,
    })),
    topPages: pages.map((p) => ({
      page: p.page,
      views: p.views,
      clicks: p.clicks,
      impressions: p.impressions,
    })),
  };

  // 4. Rankings
  const ranks = rankingsTable();
  const rankings = {
    trackedCount: ranks.length,
    items: ranks.slice(0, 15).map((r) => ({
      query: r.keyword,
      position: r.current?.position ? Math.round(r.current.position * 10) / 10 : null,
      change: r.change ? Math.round(r.change * 10) / 10 : null,
      bestUrl: null,
    })),
  };

  // 5. Content Output
  const drafts = listDrafts();
  const published = drafts
    .filter((d) => d.status === 'published')
    .map((d) => ({
      id: d.id,
      title: d.title,
      agent: d.agent,
      publishedAt: d.updatedAt,
      url: d.publishedUrl ?? null,
    }));

  // 6. Overall Composite Score
  const scoreParts = [seoAudit.score, geoVisibility.score].filter((s): s is number => s !== null);
  const overallScore = scoreParts.length ? Math.round(scoreParts.reduce((a, b) => a + b, 0) / scoreParts.length) : (seoAudit.score ?? 85);

  const competitors = listCompetitors().map((c) => ({ name: c.name, url: c.url ?? null }));

  return {
    generatedAt: new Date().toISOString(),
    siteName: name,
    siteUrl: url,
    settings,
    executiveSummary: {
      overallScore,
      seoScore: seoAudit.score,
      geoScore: geoVisibility.score,
      totalClicks: searchAnalytics.clicks,
      totalImpressions: searchAnalytics.impressions,
      totalViews: results.now.views,
      publishedCount: published.length,
    },
    seoAudit,
    geoVisibility,
    searchAnalytics,
    rankings,
    contentOutput: {
      totalDrafts: drafts.length,
      published,
    },
    competitors,
    notes: settings.customNotes,
  };
}

export function renderReportHtml(data: ClientReportData): string {
  const dateStr = new Date(data.generatedAt).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  const scoreClass = (s: number | null) => (s === null ? 'muted' : s >= 80 ? 'good' : s >= 50 ? 'warn' : 'bad');

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(data.siteName)} — Growth & SEO Client Report</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=DM+Sans:opsz,wght@9..40,400;9..40,500;9..40,600;9..40,700&family=JetBrains+Mono:wght@400;500&family=Sora:wght@600;700&display=swap">
  <style>
    :root {
      --bg: #f8fafc;
      --card: #ffffff;
      --text: #0f172a;
      --muted: #64748b;
      --border: #e2e8f0;
      --brand: #2f6f5e;
      --good: #16a34a;
      --warn: #d97706;
      --bad: #dc2626;
      --radius: 10px;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: var(--bg);
      color: var(--text);
      font-family: 'DM Sans', -apple-system, BlinkMacSystemFont, sans-serif;
      line-height: 1.5;
      -webkit-font-smoothing: antialiased;
      padding-bottom: 60px;
    }
    .print-bar {
      position: sticky;
      top: 0;
      z-index: 100;
      background: #0f172a;
      color: #fff;
      padding: 10px 24px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      box-shadow: 0 2px 10px rgba(0,0,0,0.15);
    }
    .print-bar span { font-size: 14px; opacity: 0.9; }
    .print-bar .btns { display: flex; gap: 10px; }
    .btn {
      background: var(--brand);
      color: #fff;
      border: none;
      padding: 7px 16px;
      border-radius: 6px;
      font-weight: 600;
      font-size: 13px;
      cursor: pointer;
      text-decoration: none;
      display: inline-flex;
      align-items: center;
      gap: 6px;
    }
    .btn.sec { background: #334155; }
    .btn:hover { opacity: 0.9; }
    .container {
      max-width: 960px;
      margin: 32px auto;
      padding: 0 20px;
    }
    .header {
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      padding: 32px;
      margin-bottom: 24px;
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      box-shadow: 0 1px 3px rgba(0,0,0,0.04);
    }
    .header h1 { margin: 0 0 6px; font-family: 'Sora', sans-serif; font-size: 26px; }
    .header .meta { color: var(--muted); font-size: 14px; }
    .agency-badge { text-align: right; }
    .agency-name { font-weight: 700; font-size: 18px; color: var(--brand); margin-bottom: 2px; }
    .agency-tagline { font-size: 12px; color: var(--muted); }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 16px; margin-bottom: 24px; }
    .card {
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      padding: 20px;
      box-shadow: 0 1px 3px rgba(0,0,0,0.04);
      margin-bottom: 24px;
    }
    .metric-card { text-align: center; padding: 18px; }
    .metric-val { font-size: 32px; font-weight: 700; font-family: 'Sora', sans-serif; margin: 4px 0; }
    .metric-lbl { font-size: 12px; text-transform: uppercase; letter-spacing: 0.05em; color: var(--muted); font-weight: 600; }
    .good { color: var(--good); }
    .warn { color: var(--warn); }
    .bad { color: var(--bad); }
    .muted { color: var(--muted); }
    h2 { font-family: 'Sora', sans-serif; font-size: 18px; margin: 0 0 16px; border-bottom: 1px solid var(--border); padding-bottom: 8px; }
    table { width: 100%; border-collapse: collapse; font-size: 13.5px; margin-top: 8px; }
    th { text-align: left; padding: 10px 12px; background: #f1f5f9; font-weight: 600; color: var(--muted); font-size: 12px; text-transform: uppercase; }
    td { padding: 10px 12px; border-bottom: 1px solid var(--border); }
    tr:last-child td { border-bottom: none; }
    .tag { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 11px; font-weight: 600; }
    .tag.good { background: #dcfce7; color: #15803d; }
    .tag.warn { background: #fef3c7; color: #b45309; }
    .tag.bad { background: #fee2e2; color: #b91c1c; }
    .tag.muted { background: #f1f5f9; color: #64748b; }
    .notes-box { background: #f0fdf4; border: 1px solid #bbf7d0; border-radius: 8px; padding: 16px; color: #166534; font-size: 14px; margin-bottom: 24px; }
    .footer { text-align: center; color: var(--muted); font-size: 12px; margin-top: 40px; }
    @media print {
      .print-bar { display: none !important; }
      body { background: #fff; padding: 0; }
      .container { max-width: 100%; margin: 0; padding: 0; }
      .card, .header { border: 1px solid #ddd; box-shadow: none; break-inside: avoid; }
      @page { margin: 1.5cm; }
    }
  </style>
</head>
<body>
  <div class="print-bar">
    <span>Client Performance Report — <strong>${escapeHtml(data.siteName)}</strong></span>
    <div class="btns">
      <button class="btn" onclick="window.print()">🖨️ Print / Save as PDF</button>
      <a class="btn sec" href="/api/report/markdown?site=${encodeURIComponent(currentSite())}" download="${escapeHtml(data.siteName)}-report.md">Download Markdown</a>
    </div>
  </div>

  <div class="container">
    <div class="header">
      <div>
        <h1>${escapeHtml(data.siteName)}</h1>
        <div class="meta">
          ${data.siteUrl ? `<span>🌐 <a href="${escapeHtml(data.siteUrl)}" target="_blank" style="color:inherit">${escapeHtml(data.siteUrl)}</a></span> · ` : ''}
          <span>📅 Prepared on ${escapeHtml(dateStr)}</span>
          ${data.settings.preparedBy ? ` · <span>👤 Prepared by ${escapeHtml(data.settings.preparedBy)}</span>` : ''}
        </div>
      </div>
      <div class="agency-badge">
        <div class="agency-name">${escapeHtml(data.settings.agencyName)}</div>
        <div class="agency-tagline">${escapeHtml(data.settings.agencyTagline)}</div>
      </div>
    </div>

    ${data.notes ? `<div class="notes-box"><strong>Executive Notes:</strong><p style="margin:4px 0 0">${escapeHtml(data.notes)}</p></div>` : ''}

    <div class="grid">
      <div class="card metric-card">
        <div class="metric-lbl">Overall Marketing Health</div>
        <div class="metric-val ${scoreClass(data.executiveSummary.overallScore)}">${data.executiveSummary.overallScore}/100</div>
      </div>
      <div class="card metric-card">
        <div class="metric-lbl">Technical SEO Score</div>
        <div class="metric-val ${scoreClass(data.executiveSummary.seoScore)}">${data.executiveSummary.seoScore !== null ? `${data.executiveSummary.seoScore}/100` : '—'}</div>
      </div>
      <div class="card metric-card">
        <div class="metric-lbl">AI Search (GEO) Visibility</div>
        <div class="metric-val ${scoreClass(data.executiveSummary.geoScore)}">${data.executiveSummary.geoScore !== null ? `${data.executiveSummary.geoScore}%` : '—'}</div>
      </div>
      <div class="card metric-card">
        <div class="metric-lbl">Organic Search Clicks (28d)</div>
        <div class="metric-val">${data.executiveSummary.totalClicks.toLocaleString()}</div>
      </div>
    </div>

    <!-- Section 1: Technical & On-Page SEO -->
    <div class="card">
      <h2>1. Technical & On-Page SEO Audit</h2>
      <p style="color:var(--muted);font-size:13.5px;margin-top:0;">Audit of ${data.seoAudit.pagesChecked} pages. Status: <strong>${data.seoAudit.counts.passed} checks passed</strong>, <span class="warn">${data.seoAudit.counts.warnings} warnings</span>, <span class="bad">${data.seoAudit.counts.critical} critical</span>.</p>
      ${data.seoAudit.topIssues.length ? `
      <table>
        <thead>
          <tr>
            <th>Severity</th>
            <th>Issue</th>
            <th>URL</th>
            <th>Action Required</th>
          </tr>
        </thead>
        <tbody>
          ${data.seoAudit.topIssues.map((i) => `
            <tr>
              <td><span class="tag ${i.severity === 'critical' ? 'bad' : i.severity === 'high' ? 'warn' : 'muted'}">${escapeHtml(i.severity)}</span></td>
              <td><strong>${escapeHtml(i.title)}</strong><br><small style="color:var(--muted)">${escapeHtml(i.why)}</small></td>
              <td style="font-family:'JetBrains Mono',monospace;font-size:11px;max-width:200px;word-break:break-all">${escapeHtml(i.url)}</td>
              <td><small>${escapeHtml(i.steps[0] || 'Apply recommended fix')}</small></td>
            </tr>
          `).join('')}
        </tbody>
      </table>` : '<p class="good">✓ No open SEO issues found. Site is in optimal health.</p>'}
    </div>

    <!-- Section 2: AI Search Engine Optimization (GEO) -->
    <div class="card">
      <h2>2. AI Search & Generative Engine Visibility (GEO)</h2>
      <p style="color:var(--muted);font-size:13.5px;margin-top:0;">Tracks brand mentions and citations across ChatGPT (GPT), Claude, and Gemini for buyer-intent search prompts.</p>
      <div style="display:flex;gap:12px;margin-bottom:16px;flex-wrap:wrap;">
        <div class="tag ${scoreClass(data.geoVisibility.score)}" style="padding:6px 12px;font-size:13px">AI Visibility Score: ${data.geoVisibility.score !== null ? `${data.geoVisibility.score}%` : 'Not run yet'}</div>
        <div class="tag muted" style="padding:6px 12px;font-size:13px">Mentioned in ${data.geoVisibility.mentioned} of ${data.geoVisibility.answered} tested answers</div>
        ${data.geoVisibility.avgPosition ? `<div class="tag muted" style="padding:6px 12px;font-size:13px">Avg Recommendation Rank: #${data.geoVisibility.avgPosition}</div>` : ''}
      </div>

      ${data.geoVisibility.perEngine.length ? `
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:10px;margin-bottom:16px;">
        ${data.geoVisibility.perEngine.map((e) => `
          <div style="background:#f8fafc;border:1px solid var(--border);border-radius:6px;padding:10px;text-align:center;">
            <div style="font-weight:600;font-size:13px">${escapeHtml(e.label)}</div>
            <div style="font-size:20px;font-weight:700;margin:4px 0" class="${e.mentioned > 0 ? 'good' : 'muted'}">${e.mentioned}/${e.answered}</div>
            <small style="color:var(--muted)">${e.answered ? `${Math.round((e.mentioned/e.answered)*100)}% visibility` : 'No data'}</small>
          </div>
        `).join('')}
      </div>` : ''}

      ${data.geoVisibility.topQuestions.length ? `
      <table>
        <thead>
          <tr>
            <th>Tested Prompt Query</th>
            <th>Brand Mentioned?</th>
            <th>Position</th>
            <th>Sentiment</th>
          </tr>
        </thead>
        <tbody>
          ${data.geoVisibility.topQuestions.map((q) => `
            <tr>
              <td>"${escapeHtml(q.question)}"</td>
              <td><span class="tag ${q.mentioned ? 'good' : 'bad'}">${q.mentioned ? 'Cited ✓' : 'Not Cited'}</span></td>
              <td>${q.position ? `#${q.position}` : '—'}</td>
              <td>${q.sentiment ? `<span class="tag ${q.sentiment === 'positive' ? 'good' : 'muted'}">${escapeHtml(q.sentiment)}</span>` : '—'}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>` : '<p class="muted">Run the AI Visibility check to populate generative search benchmarks.</p>'}
    </div>

    <!-- Section 3: Organic Search Performance -->
    <div class="card">
      <h2>3. Organic Search Traffic & Top Queries</h2>
      <p style="color:var(--muted);font-size:13.5px;margin-top:0;">Performance data over the last 28 days via Google Search Console.</p>
      ${data.searchAnalytics.topQueries.length ? `
      <table>
        <thead>
          <tr>
            <th>Search Query</th>
            <th>Clicks</th>
            <th>Impressions</th>
            <th>CTR</th>
            <th>Avg Position</th>
          </tr>
        </thead>
        <tbody>
          ${data.searchAnalytics.topQueries.map((q) => `
            <tr>
              <td><strong>${escapeHtml(q.query)}</strong></td>
              <td>${q.clicks}</td>
              <td>${q.impressions.toLocaleString()}</td>
              <td>${q.ctr}%</td>
              <td>${q.position}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>` : '<p class="muted">Connect Google Search Console in Integrations to view query and click performance.</p>'}
    </div>

    <!-- Section 4: Content & Marketing Assets -->
    <div class="card">
      <h2>4. Published Content & Growth Assets</h2>
      <p style="color:var(--muted);font-size:13.5px;margin-top:0;">Total marketing output created and published across channels.</p>
      ${data.contentOutput.published.length ? `
      <table>
        <thead>
          <tr>
            <th>Title</th>
            <th>Channel / Agent</th>
            <th>Published Date</th>
            <th>Destination Link</th>
          </tr>
        </thead>
        <tbody>
          ${data.contentOutput.published.map((p) => `
            <tr>
              <td><strong>${escapeHtml(p.title)}</strong></td>
              <td><span class="tag muted">${escapeHtml(p.agent)}</span></td>
              <td>${escapeHtml(p.publishedAt.slice(0, 10))}</td>
              <td>${p.url ? `<a href="${escapeHtml(p.url)}" target="_blank" rel="noopener">View Live ↗</a>` : '<span class="muted">Live</span>'}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>` : '<p class="muted">No published content items recorded for this period yet.</p>'}
    </div>

    <div class="footer">
      Generated by <strong>${escapeHtml(data.settings.agencyName)}</strong> · Powered by Plume AI Marketing
    </div>
  </div>
</body>
</html>`;
}

export function renderReportMarkdown(data: ClientReportData): string {
  const lines: string[] = [
    `# Marketing & SEO Client Report: ${data.siteName}`,
    `**Website:** ${data.siteUrl || '(Not specified)'}`,
    `**Date:** ${data.generatedAt.slice(0, 10)}`,
    `**Prepared by:** ${data.settings.agencyName}${data.settings.preparedBy ? ` (${data.settings.preparedBy})` : ''}`,
    '',
    '## Executive Summary',
    `- **Overall Marketing Health Score:** ${data.executiveSummary.overallScore}/100`,
    `- **Technical SEO Score:** ${data.executiveSummary.seoScore !== null ? `${data.executiveSummary.seoScore}/100` : 'N/A'}`,
    `- **AI Engine (GEO) Visibility:** ${data.executiveSummary.geoScore !== null ? `${data.executiveSummary.geoScore}%` : 'N/A'}`,
    `- **Organic Search Clicks (28d):** ${data.executiveSummary.totalClicks}`,
    `- **Organic Impressions (28d):** ${data.executiveSummary.totalImpressions}`,
    `- **Published Content Items:** ${data.executiveSummary.publishedCount}`,
    '',
  ];

  if (data.notes) {
    lines.push('### Agency Notes', data.notes, '');
  }

  lines.push(
    '## 1. Technical & On-Page SEO Audit',
    `- Pages Checked: ${data.seoAudit.pagesChecked}`,
    `- Health Score: ${data.seoAudit.score !== null ? `${data.seoAudit.score}/100` : 'N/A'}`,
    `- Passed Checks: ${data.seoAudit.counts.passed} | Warnings: ${data.seoAudit.counts.warnings} | Critical Issues: ${data.seoAudit.counts.critical}`,
    '',
  );

  if (data.seoAudit.topIssues.length) {
    lines.push('### Key SEO Action Items');
    for (const issue of data.seoAudit.topIssues) {
      lines.push(`- **[${issue.severity.toUpperCase()}] ${issue.title}** (${issue.url})`);
      lines.push(`  - *Why:* ${issue.why}`);
      lines.push(`  - *Fix:* ${issue.steps[0] || 'Apply recommended fix'}`);
    }
    lines.push('');
  }

  lines.push(
    '## 2. AI Search (GEO) Visibility',
    `- AI Visibility Score: ${data.geoVisibility.score !== null ? `${data.geoVisibility.score}%` : 'N/A'}`,
    `- Mentioned in ${data.geoVisibility.mentioned} of ${data.geoVisibility.answered} tested answers`,
    '',
  );

  if (data.geoVisibility.topQuestions.length) {
    lines.push('### Sample AI Search Prompts');
    for (const q of data.geoVisibility.topQuestions) {
      lines.push(`- "${q.question}": **${q.mentioned ? 'Cited ✓' : 'Not Cited ✗'}** (Rank: ${q.position ? `#${q.position}` : 'N/A'})`);
    }
    lines.push('');
  }

  lines.push('## 3. Top Organic Search Queries (Last 28 Days)');
  if (data.searchAnalytics.topQueries.length) {
    for (const q of data.searchAnalytics.topQueries) {
      lines.push(`- **${q.query}**: ${q.clicks} clicks, ${q.impressions} impressions, Pos: ${q.position}`);
    }
  } else {
    lines.push('- No Search Console data available yet.');
  }
  lines.push('');

  lines.push('## 4. Published Growth Assets');
  if (data.contentOutput.published.length) {
    for (const p of data.contentOutput.published) {
      lines.push(`- **${p.title}** (${p.agent}) - ${p.publishedAt.slice(0, 10)}${p.url ? ` - ${p.url}` : ''}`);
    }
  } else {
    lines.push('- No published content pieces recorded.');
  }
  lines.push('');

  lines.push('---', `Report generated by ${data.settings.agencyName}`);
  return lines.join('\n');
}
