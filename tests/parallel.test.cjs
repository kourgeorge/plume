require('ts-node/register/transpile-only');
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'plume-test-'));
process.env.PLUME_SITE = 'test.example';
const { chromeFetch, closeBrowser, shutdownBrowser, setBrowserForTests } = require('../src/research/fetchPage');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A fake Chrome: counts launches and closes, and each page read takes `ms`. */
function fakeChrome(ms) {
  const stats = { launched: 0, closed: 0, readsWhileClosed: 0 };
  let open = false;
  setBrowserForTests(async () => {
    stats.launched++;
    open = true;
    return {
      close: async () => ((open = false), stats.closed++),
      newContext: async () => ({
        close: async () => {},
        newPage: async () => ({
          goto: async () => {
            await sleep(ms);
            if (!open) stats.readsWhileClosed++;
            return { status: () => 200 };
          },
          waitForLoadState: async () => {},
          content: async () => '<html><body>ok</body></html>',
          url: () => 'https://a.test/',
        }),
      }),
    };
  });
  return stats;
}

test('one job finishing does not close Chrome while another job is still reading', async () => {
  const stats = fakeChrome(60);
  const slow = chromeFetch('https://a.test/slow');
  await sleep(10);
  await closeBrowser(); // the other job is done with Chrome
  const r = await slow;
  assert.equal(r.status, 200);
  assert.equal(stats.readsWhileClosed, 0);
  assert.equal(stats.closed, 0, 'still open right after the read');
  await sleep(60);
  assert.equal(stats.closed, 1, 'closed once nothing was reading');
  await shutdownBrowser();
});

test('parallel reads share one Chrome', async () => {
  const stats = fakeChrome(30);
  await Promise.all([1, 2, 3, 4].map((i) => chromeFetch(`https://a.test/${i}`)));
  assert.equal(stats.launched, 1);
  await shutdownBrowser();
});

test('a read that starts right after a close keeps Chrome open', async () => {
  const stats = fakeChrome(10);
  await chromeFetch('https://a.test/1');
  await closeBrowser();
  await chromeFetch('https://a.test/2'); // the next job, before the close delay is up
  await sleep(5);
  assert.equal(stats.launched, 1);
  assert.equal(stats.closed, 0);
  await shutdownBrowser();
});

test('different agents run side by side; the same agent twice gives back the run already going', async () => {
  const { writeDoc, PROFILE_DOCS } = require('../src/context/profile');
  for (const d of PROFILE_DOCS) writeDoc(d.id, `# ${d.title}\n\nTest.`);
  const agents = require('../src/agents');
  const { getJob } = require('../src/jobs');
  // Two slow fake agents, so both are still working when we look.
  const seen = { a: 0, b: 0 };
  const fake = (id) => ({ id, label: id, description: '', findOpportunities: async () => (seen[id]++, await sleep(80), []), draft: async () => true });
  agents.AGENTS.push(fake('a'), fake('b'));
  try {
    const started = agents.startAgentRuns(['a', 'b']);
    assert.equal(started.length, 2);
    assert.notEqual(started[0].jobId, started[1].jobId);
    await sleep(20);
    assert.deepEqual(seen, { a: 1, b: 1 }, 'both started at once, not one after the other');
    assert.equal(agents.startAgentRun('a'), started[0].jobId, 'no second run of the same agent');
    await sleep(120);
    assert.equal(getJob(started[0].jobId).status, 'done');
    assert.equal(getJob(started[1].jobId).status, 'done');
    assert.equal(seen.a, 1);
  } finally {
    agents.AGENTS.splice(-2, 2);
  }
});
