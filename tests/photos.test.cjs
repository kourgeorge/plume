require('ts-node/register/transpile-only');
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

// One fake server plays the AI gateway (/llm), Openverse (/ov), Pexels (/px), the image service (/img) and photo files (/files).
const seen = [];
const llmScript = [];
const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 1)]);

/** One streamed Anthropic reply: either plain text, or one tool call. */
const sse = (step) => {
  const block = step.tool ? { type: 'tool_use', id: `tu_${seen.length}`, name: step.tool, input: {} } : { type: 'text', text: '' };
  const delta = step.tool ? { type: 'input_json_delta', partial_json: JSON.stringify(step.input) } : { type: 'text_delta', text: JSON.stringify(step) };
  return [
    ['message_start', { message: { id: 'm', type: 'message', role: 'assistant', model: 'claude-sonnet-5-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } } }],
    ['content_block_start', { index: 0, content_block: block }],
    ['content_block_delta', { index: 0, delta }],
    ['content_block_stop', { index: 0 }],
    ['message_delta', { delta: { stop_reason: step.tool ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } }],
    ['message_stop', {}],
  ]
    .map(([type, data]) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`)
    .join('');
};

let base;
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const u = new URL(req.url, 'http://x');
    seen.push({ method: req.method, path: u.pathname, query: u.searchParams, headers: req.headers, body });
    if (u.pathname === '/llm/v1/messages') return res.writeHead(200, { 'content-type': 'text/event-stream' }).end(sse(llmScript.shift()));
    if (u.pathname === '/ov/v1/images/')
      return res.writeHead(200, { 'content-type': 'application/json' }).end(
        JSON.stringify({ results: [{ id: 'abc', title: 'Bakery counter with fresh bread', tags: [{ name: 'bread' }], width: 1600, height: 1000, license: 'by', license_version: '4.0', attribution: '"Bakery counter" by Ana, CC BY 4.0', foreign_landing_url: 'https://example.org/abc', url: `${base}/files/bread.jpg` }] }),
      );
    if (u.pathname === '/px/v1/search') return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ photos: [] }));
    if (u.pathname === '/files/bread.jpg') return res.writeHead(200, { 'content-type': 'image/jpeg' }).end(JPG);
    if (u.pathname === '/files/not-a-photo') return res.writeHead(200, { 'content-type': 'text/html' }).end('<html>hi</html>');
    if (u.pathname === '/img/images/generations') return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data: [{ b64_json: JPG.toString('base64') }] }));
    res.writeHead(404).end('{}');
  });
});

let q, photos, images;
test.before(() => new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
  base = `http://127.0.0.1:${server.address().port}`;
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'plume-photos-'));
  process.env.PLUME_SITE = 'test.example';
  process.env.LLM_BASE_URL = `${base}/llm`;
  process.env.LLM_API_KEY = 'k';
  process.env.PLUME_SEARCH = 'off';
  for (const k of ['OPENAI_API_KEY', 'IMAGE_API_KEY', 'IMAGE_API_URL', 'IMAGE_MODEL', 'PEXELS_API_KEY', 'PLUME_IMAGES']) delete process.env[k];
  q = require('../src/queue');
  images = require('../src/social/images');
  photos = require('../src/social/photos');
  photos.allowLocalPhotosForTests();
  Object.assign(photos.PHOTO_API, { openverse: `${base}/ov`, pexels: `${base}/px` });
  require('../src/db').getGlobalDb().prepare(`INSERT OR REPLACE INTO sites (slug, url, name, created_at) VALUES ('test.example', 'https://acme.example', 'Acme', 'now')`).run();
  resolve();
})));
test.after(() => server.close());

const post = () => q.createDraft({ agent: 'social', kind: 'linkedin_post', title: 'Fresh bread', body: 'We bake at 5am every day.', meta: {} });

test('search: Openverse asks only for photos businesses may use; Pexels joins when there is a key', async () => {
  const hits = await photos.searchPhotos('bakery bread', 'wide', { PEXELS_API_KEY: 'pk' });
  assert.equal(hits[0].id, 'openverse:abc');
  assert.equal(hits[0].license, 'BY 4.0');
  const ov = seen.filter((s) => s.path === '/ov/v1/images/').pop();
  assert.equal(ov.query.get('license_type'), 'commercial');
  assert.equal(ov.query.get('aspect_ratio'), 'wide');
  const px = seen.filter((s) => s.path === '/px/v1/search').pop();
  assert.equal(px.headers.authorization, 'pk');
  assert.equal(px.query.get('orientation'), 'landscape');
});

test('the photo editor searches, picks a found photo, and it is attached with its credit', async () => {
  const d = post();
  llmScript.push(
    { tool: 'search_photos', input: { query: 'bakery bread', orientation: 'wide' } },
    { choice: 'found', photo_id: 'openverse:abc', image_prompt: '', shape: 'wide', why: 'Shows the bread the post talks about.' },
  );
  const r = await photos.suggestPhoto(d.id, { canMake: false });
  assert.equal(r.attached.name, '1.jpg');
  assert.match(r.note, /Ana, CC BY 4.0/);
  assert.equal(images.listImages(d.id).length, 1);
  const [credit] = photos.photoCredits(d.id);
  assert.equal(credit.how, 'found');
  assert.equal(credit.page, 'https://example.org/abc');
  // The model saw the search results as a tool result, and making was not offered.
  const second = JSON.parse(seen.filter((s) => s.path === '/llm/v1/messages').pop().body);
  const result = second.messages.at(-1).content[0];
  assert.equal(result.type, 'tool_result');
  assert.match(result.content, /Bakery counter/);
  assert.deepEqual(second.output_config.format.schema.properties.choice.enum, ['found', 'none']);
  // A removed photo takes its credit with it.
  images.removeImage(d.id, '1.jpg');
  assert.deepEqual(photos.photoCredits(d.id), []);
});

test('with an image service, the editor can make a picture instead; its cost counts toward the budget', async () => {
  process.env.IMAGE_API_KEY = 'ik';
  process.env.IMAGE_API_URL = `${base}/img`;
  try {
    const d = post();
    llmScript.push({ choice: 'make', photo_id: '', image_prompt: 'A baker pulling loaves from an oven at dawn, natural light', shape: 'wide', why: 'Nothing found showed an early bake.' });
    const r = await photos.suggestPhoto(d.id);
    assert.ok(r.attached);
    const sent = JSON.parse(seen.filter((s) => s.path === '/img/images/generations').pop().body);
    assert.equal(sent.model, 'gpt-image-1');
    assert.equal(sent.size, '1536x1024');
    assert.equal(photos.photoCredits(d.id)[0].how, 'made');
    const row = require('../src/db').getGlobalDb().prepare(`SELECT cost_usd FROM llm_calls WHERE purpose = 'photo:make'`).get();
    assert.equal(row.cost_usd, photos.IMAGE_COST_USD);
  } finally {
    delete process.env.IMAGE_API_KEY;
    delete process.env.IMAGE_API_URL;
  }
});

test('no photo is not an error: a made-up id, a file that is not a photo, or "none" come back as a note', async () => {
  const d = post();
  llmScript.push({ choice: 'found', photo_id: 'openverse:nope', image_prompt: '', shape: 'square', why: 'x' });
  assert.match((await photos.suggestPhoto(d.id, { canMake: false })).note, /not in the search results/);
  await assert.rejects(photos.attachFromUrl(d.id, `${base}/files/not-a-photo`), /not a JPG, PNG or GIF/);
  llmScript.push({ choice: 'none', photo_id: '', image_prompt: '', shape: 'square', why: 'A plain text post reads better here.' });
  const r = await photos.suggestPhoto(d.id, { canMake: false });
  assert.equal(r.attached, null);
  assert.equal(r.note, 'A plain text post reads better here.');
  assert.equal(images.listImages(d.id).length, 0);
});

test('downloads refuse this computer and the local network', async () => {
  // The test switch is on in this file, so check the rule through a fresh copy of the module.
  delete require.cache[require.resolve('../src/social/photos')];
  const fresh = require('../src/social/photos');
  for (const url of ['http://example.com/a.jpg', 'https://127.0.0.1/a.jpg', 'https://192.168.1.4/a.jpg', 'https://localhost/a.jpg']) await assert.rejects(fresh.attachFromUrl(1, url), /https|local addresses/);
});
