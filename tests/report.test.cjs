require('ts-node/register/transpile-only');
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'plume-report-'));
process.env.PLUME_SITE = 'test.example';

const { getGlobalDb } = require('../src/db');
getGlobalDb().prepare(`INSERT OR REPLACE INTO sites (slug, url, name, created_at) VALUES ('test.example', 'https://acme.example', 'Acme Corp', 'now')`).run();

const {
  buildClientReportData,
  getReportSettings,
  renderReportHtml,
  renderReportMarkdown,
  saveReportSettings,
} = require('../src/report/clientReport');

test('client report: settings save and retrieve per site', () => {
  const initial = getReportSettings();
  assert.equal(initial.agencyName, 'Plume Marketing Intelligence');

  const updated = saveReportSettings({
    agencyName: 'Apex Growth Partners',
    agencyTagline: 'B2B SEO & Generative AI',
    preparedBy: 'Alex Smith',
    customNotes: 'Q4 strategy is on track with 25% traffic growth.',
  });

  assert.equal(updated.agencyName, 'Apex Growth Partners');
  assert.equal(updated.preparedBy, 'Alex Smith');

  const reloaded = getReportSettings();
  assert.equal(reloaded.agencyName, 'Apex Growth Partners');
  assert.equal(reloaded.customNotes, 'Q4 strategy is on track with 25% traffic growth.');
});

test('client report: builds structured data across SEO, GEO, analytics and output', () => {
  const data = buildClientReportData();
  assert.equal(data.siteName, 'Acme Corp');
  assert.equal(data.siteUrl, 'https://acme.example');
  const { overallScore, seoScore, geoScore } = data.executiveSummary;
  if (seoScore === null && geoScore === null) assert.equal(overallScore, null, 'no made-up score when nothing was measured');
  else assert.equal(typeof overallScore, 'number');
  assert.ok(data.searchAnalytics);
  assert.ok(data.seoAudit);
  assert.ok(data.geoVisibility);
  assert.ok(data.contentOutput);
});

test('client report: renders standalone HTML with print styles and white-label branding', () => {
  const data = buildClientReportData({
    agencyName: 'Apex Growth Partners',
    preparedBy: 'Alex',
    customNotes: 'Highlighting strong organic momentum.',
  });
  const html = renderReportHtml(data);

  assert.ok(html.includes('<!doctype html>'));
  assert.ok(html.includes('Apex Growth Partners'));
  assert.ok(html.includes('Acme Corp'));
  assert.ok(html.includes('Highlighting strong organic momentum.'));
  assert.ok(html.includes('@media print'));
  assert.ok(html.includes('Print / Save as PDF'));
});

test('client report: renders clean markdown document', () => {
  const data = buildClientReportData({
    agencyName: 'Apex Growth Partners',
  });
  const md = renderReportMarkdown(data);

  assert.ok(md.includes('# Marketing & SEO Client Report: Acme Corp'));
  assert.ok(md.includes('## Executive Summary'));
  assert.ok(md.includes('Apex Growth Partners'));
});
