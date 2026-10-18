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

test('profileComplete needs the five core docs; design guide and content strategy never block agents', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plume-prof-'));
  for (const id of ['product', 'strategy', 'competitors', 'voice']) writeDoc(id, '# x', dir);
  assert.equal(profileComplete(dir), false);
  writeDoc('content-plan', '# x', dir);
  assert.equal(profileComplete(dir), true, 'a site researched before the new documents existed must keep working');
  assert.deepEqual(PROFILE_DOCS.filter((d) => !d.core).map((d) => d.id), ['design', 'content-strategy']);
  assert.ok(PROFILE_DOCS.findIndex((d) => d.id === 'content-strategy') < PROFILE_DOCS.findIndex((d) => d.id === 'content-plan'), 'the plan builds on the strategy');
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

test('site languages: wrong <html lang> loses to the text, several languages are kept, strays are not', () => {
  const { detectLanguages, pageLanguageOf, languageRule } = require('../src/context/language');
  // Builders that stamp "en" on every page: the Hebrew text wins.
  assert.equal(pageLanguageOf({ lang: 'en-US', text: 'קורס תאוריה לנהיגה עם סרטונים ומבחנים' }), 'he');
  assert.equal(pageLanguageOf({ lang: '', text: 'Cours complet', url: 'https://x.fr/fr/cours' }), 'fr');
  const he = (n) => Array.from({ length: n }, () => ({ lang: 'he', text: 'קורס תאוריה לנהיגה' }));
  const en = (n) => Array.from({ length: n }, () => ({ lang: 'en', text: 'Theory course' }));
  assert.deepEqual(detectLanguages([...he(8), ...en(4)]), { main: 'he', all: ['he', 'en'] });
  assert.deepEqual(detectLanguages([...he(30), ...en(1)]), { main: 'he', all: ['he'] }, 'one stray English page');
  assert.deepEqual(detectLanguages([]), { main: 'en', all: ['en'] });
  const rule = languageRule('he', ['he', 'en']);
  assert.match(rule, /in Hebrew/);
  assert.match(rule, /also published in English/);
  assert.equal(languageRule('en', ['en']), 'Write all customer-facing content in English.');
});

test('a language set by the owner survives a new crawl', () => {
  const { setContentLanguages, contentLanguages, languageSetByOwner } = require('../src/context/language');
  setContentLanguages({ main: 'ar', all: ['ar', 'he'] }, true);
  assert.equal(languageSetByOwner(), true);
  assert.deepEqual(contentLanguages(), ['ar', 'he']);
});
