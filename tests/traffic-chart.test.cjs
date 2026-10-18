const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require.resolve('../web/app.js'), 'utf8');
const chart = source.slice(source.indexOf('function drawChart('), source.indexOf("for (const b of $('details-tabs')", source.indexOf('function drawChart(')));

test('traffic chart scales for previous peaks, draws dashed comparisons, and leaves gaps for missing data', () => {
  const context = vm.createContext({ esc: String, fmtDay: String, n: String });
  vm.runInContext(chart, context);
  const box = { clientWidth: 600 };
  const points = [1, 2, 3].map((y, i) => ({ x: `2026-10-${10 + i}`, y }));
  context.drawChart(box, 'Traffic', points, null, {
    previous: [{ label: 'Visits, previous 7 days', points: [{ y: 100 }, { y: null }, { y: 50 }] }],
  });
  assert.match(box.innerHTML, />100<\/text>/, 'previous peak shares the chart scale');
  assert.match(box.innerHTML, /d="M36\.0,18\.0M592\.0,108\.0" class="line previous"/, 'missing day breaks the path');
  assert.match(box.innerHTML, /Visits, previous 7 days/);
  assert.doesNotMatch(box.innerHTML, /NaN|undefined/);
});
