require('ts-node/register/transpile-only');
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'plume-test-'));
process.env.PLUME_SITE = 'test.example';
const t = require('../src/research/techSignals');
const { renderMarkdown } = require('../src/render');

const page = `<html><head><meta name="generator" content="WordPress 6.6"><script src="https://www.googletagmanager.com/gtag/js?id=G-ABC"></script>
<link href="https://fonts.googleapis.com/css2?family=Inter" rel="stylesheet"></head><body>
<a href="https://wa.me/972500000000?text=hi">WhatsApp</a>
<a href="https://www.youtube.com/@SomeChannel">YouTube</a>
<a href="https://www.facebook.com/sharer/sharer.php?u=x">share</a>
<a href="https://www.facebook.com/somebrand/">Facebook</a>
<a href="https://school.teachable.com/p/course">Buy</a>
<a href="https://x.com/intent/tweet?text=x">tweet</a>
<iframe src="https://www.youtube.com/embed/abc"></iframe></body></html>`;

test('detects builder, analytics, contact, video and social links, ignoring share buttons', () => {
  const found = t.detectTech(page, 'https://site.example/');
  const names = found.map((s) => s.name);
  for (const n of ['WordPress', 'Google Analytics', 'Google Fonts', 'WhatsApp', 'YouTube', 'Facebook', 'Teachable']) assert.ok(names.includes(n), n);
  assert.ok(!names.includes('X (Twitter)'), 'a tweet-intent link is not a profile');
  assert.equal(found.find((s) => s.name === 'Facebook').detail, 'https://www.facebook.com/somebrand', 'share link must not be taken as the profile');
  assert.equal(found.find((s) => s.name === 'WhatsApp').detail, 'https://wa.me/972500000000');
  assert.equal(found.find((s) => s.name === 'YouTube').detail, 'https://www.youtube.com/@SomeChannel');
});

test('a plain page has no signals; merging keeps first sighting and fills in details', () => {
  assert.deepEqual(t.detectTech('<html><body><p>Hello</p></body></html>', 'https://a/'), []);
  const merged = t.mergeSignals([
    [{ name: 'YouTube', kind: 'video', seenOn: 'https://a/' }],
    [{ name: 'YouTube', kind: 'video', seenOn: 'https://a/b', detail: 'https://youtube.com/@x' }, { name: 'Wix', kind: 'builder', seenOn: 'https://a/b' }],
  ]);
  assert.deepEqual(merged.map((s) => s.name), ['Wix', 'YouTube'], 'builders sort first');
  assert.equal(merged[1].seenOn, 'https://a/');
  assert.equal(merged[1].detail, 'https://youtube.com/@x');
});

test('summary groups by kind for the research prompt', () => {
  t.saveTechSignals(t.mergeSignals([t.detectTech(page, 'https://site.example/')]));
  const s = t.techSummary();
  assert.match(s, /^- Built with: WordPress/m);
  assert.match(s, /^- Contact: WhatsApp \(https:\/\/wa\.me\/972500000000\)/m);
});

test('Next.js marker is dropped when a real builder is also present', () => {
  const html = '<html><head><meta name="generator" content="Wix.com Website Builder"></head><body><script src="/_next/static/x.js"></script></body></html>';
  assert.deepEqual(t.detectTech(html, 'https://a/').map((s) => s.name), ['Wix']);
});

test('rendering AI-written documents never lets HTML or scripts through', () => {
  const evil = '# Title\n\n<script>alert(1)</script>\n\n<img src=x onerror=alert(2)>\n\n[click](javascript:alert(3)) and [ok](https://example.com)\n\n![pic](https://x/y.png)\n\ninline <b onclick=x>bold</b> text';
  const html = renderMarkdown(evil);
  assert.match(html, /<h1>Title<\/h1>/);
  // Escaped text like "&lt;img onerror=…&gt;" is harmless; what must never appear is a real tag or attribute.
  assert.doesNotMatch(html, /<script|<img|<iframe|href="javascript/i);
  assert.doesNotMatch(html.replace(/&lt;[^]*?&gt;/g, ''), /\son\w+=/i, 'an event handler attribute got through');
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /<a href="https:\/\/example\.com" target="_blank" rel="noopener noreferrer">ok<\/a>/);
  assert.match(html, /click/, 'unsafe link keeps its text');
  assert.match(html, /&lt;b onclick=x&gt;bold/, 'inline HTML is shown as text');
  assert.match(renderMarkdown('**Pricing:** 10-day access: ₪139.\n\n- one\n- two'), /<strong>Pricing:<\/strong>[\s\S]*<li>one<\/li>/);
});
