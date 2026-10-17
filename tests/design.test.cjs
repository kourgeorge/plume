require('ts-node/register/transpile-only');
const test = require('node:test');
const assert = require('node:assert');
const { readCss, readDesign, designSummary } = require('../src/research/design');

test('colours are counted once however they are written; black, white and see-through are left out', () => {
  const { colors, fonts } = readCss(`a{color:#2F6F5E} b{color:#2f6f5e;background:#fff} c{border-color:#000;box-shadow:0 0 0 rgba(0,0,0,0)} d{color:#abc;font-family:"Heebo", sans-serif} e{font-family:var(--x)} f{font-family:inherit}`);
  assert.equal(colors.get('#2f6f5e'), 2);
  assert.equal(colors.get('#aabbcc'), 1);
  assert.equal(colors.has('#ffffff'), false);
  assert.equal(colors.has('#000000'), false);
  assert.equal(colors.has('rgba(0,0,0,0)'), false);
  assert.deepEqual([...fonts.keys()], ['Heebo']);
});

test('reads inline styles and the site\'s own stylesheets, not other sites\'; never throws', async () => {
  const pages = {
    'https://acme.example/': `<html><head><meta name="theme-color" content="#123456">
      <link rel="stylesheet" href="/main.css"><link rel="stylesheet" href="https://cdn.other.example/lib.css">
      <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Open+Sans:wght@400;700">
      <style>h1{color:#ff6600}</style></head><body><header><img src="/img/logo.svg" alt="Acme"></header></body></html>`,
    'https://acme.example/main.css': 'body{color:#333333;font-family:Inter,sans-serif} .btn{background:#ff6600}',
    'https://cdn.other.example/lib.css': 'x{color:#999999}',
  };
  const seen = [];
  const fake = async (u) => (seen.push(String(u)), pages[String(u)] ? new Response(pages[String(u)]) : new Response('', { status: 404 }));
  const f = await readDesign('https://acme.example/', fake);
  assert.equal(f.colors[0].value, '#ff6600');
  assert.ok(f.colors.some((c) => c.value === '#333333'));
  assert.ok(!f.colors.some((c) => c.value === '#999999'), 'another site\'s CSS was read');
  assert.ok(!seen.includes('https://cdn.other.example/lib.css'));
  assert.deepEqual(f.fonts.map((x) => x.family).sort(), ['Inter', 'Open Sans']);
  assert.equal(f.themeColor, '#123456');
  assert.equal(f.logo, 'https://acme.example/img/logo.svg');
  assert.equal(f.stylesheets, 1);
  assert.match(designSummary(f), /#ff6600 \(2\)/);

  const down = await readDesign('https://down.example/', async () => { throw new Error('offline'); });
  assert.deepEqual(down.colors, []);
  assert.match(designSummary(down), /Nothing could be read/);
});
