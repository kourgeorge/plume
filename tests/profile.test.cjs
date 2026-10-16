require('ts-node/register/transpile-only');
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'plume-test-'));
process.env.PLUME_SITE = 'test.example';
const { PROFILE_DOCS, agentSystem, writeDoc, profileComplete, isProfileDocId } = require('../src/context/profile');

test('agentSystem includes every doc in full, in fixed order, cached', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plume-prof-'));
  const long = 'x'.repeat(50000);
  writeDoc('voice', long, dir);
  const [docs, role] = agentSystem('You write tweets.', dir);
  assert.ok(docs.text.includes(long), 'voice doc was shortened');
  assert.deepEqual(docs.cache_control, { type: 'ephemeral' });
  const order = PROFILE_DOCS.map((d) => docs.text.indexOf(`<doc id="${d.id}"`));
  assert.deepEqual([...order].sort((a, b) => a - b), order);
  assert.ok(docs.text.includes('(not written yet)'));
  assert.match(role.text, /^You write tweets.\n\nWrite all customer-facing content/);
});

test('profileComplete needs all five docs', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plume-prof-'));
  for (const d of PROFILE_DOCS.slice(0, 4)) writeDoc(d.id, '# x', dir);
  assert.equal(profileComplete(dir), false);
  writeDoc('content-plan', '# x', dir);
  assert.equal(profileComplete(dir), true);
});

test('isProfileDocId rejects path tricks', () => {
  assert.equal(isProfileDocId('../etc/passwd'), false);
  assert.equal(isProfileDocId('voice'), true);
});

test('site language: html lang wins, script detection is the fallback, rule names the language', () => {
  const { detectLanguage, languageRule } = require('../src/context/language');
  assert.equal(detectLanguage([{ lang: 'he-IL', text: '' }, { lang: 'he', text: '' }, { lang: 'en', text: '' }]), 'he');
  assert.equal(detectLanguage([{ lang: '', text: 'קורס תאוריה לנהיגה עם סרטונים ומבחנים' }]), 'he');
  assert.equal(detectLanguage([{ lang: '', text: 'Plain English text' }]), 'en');
  assert.match(languageRule('he'), /in Hebrew/);
  assert.match(languageRule('he'), /Slugs stay in lowercase Latin/);
});
