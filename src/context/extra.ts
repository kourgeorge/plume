import { getDb, getSetting, setSetting } from '../db';

/** Everything the user adds by hand that isn't one of the research documents. */

// ---------------------------------------------------------------- competitors

export interface Competitor {
  id: number;
  name: string;
  url: string | null;
  notes: string;
  source: 'research' | 'user';
  watch: boolean;
  addedAt: string;
}

/** "rival.com/pricing?x" → "https://rival.com". Null for anything that isn't a web address. */
export function siteOrigin(raw: string | null | undefined): string | null {
  const t = (raw ?? '').trim();
  if (!t) return null;
  try {
    const u = new URL(/^https?:\/\//i.test(t) ? t : `https://${t}`);
    if (!u.hostname.includes('.')) return null;
    return `${u.protocol}//${u.hostname.toLowerCase()}`;
  } catch {
    return null;
  }
}

const host = (origin: string | null) => (origin ? new URL(origin).hostname.replace(/^www\./, '') : null);

function competitorRow(r: any): Competitor {
  return { id: r.id, name: r.name, url: r.url, notes: r.notes, source: r.source, watch: !!r.watch, addedAt: r.added_at };
}

export function listCompetitors(): Competitor[] {
  return getDb().prepare('SELECT * FROM competitors ORDER BY id').all().map(competitorRow);
}

export function getCompetitor(id: number): Competitor | undefined {
  const r = getDb().prepare('SELECT * FROM competitors WHERE id = ?').get(id);
  return r ? competitorRow(r) : undefined;
}

/** Add one, unless a competitor with the same website (or, without one, the same name) is already listed. */
export function addCompetitor(c: { name: string; url?: string | null; notes?: string; source?: 'research' | 'user'; watch?: boolean }): Competitor | null {
  const name = c.name.trim();
  if (!name) throw new Error('a competitor needs a name');
  const url = siteOrigin(c.url);
  if (c.url && !url) throw new Error(`"${c.url}" is not a web address`);
  const dup = listCompetitors().find((x) => (url && host(x.url) === host(url)) || (!url && !x.url && x.name.toLowerCase() === name.toLowerCase()));
  if (dup) return null;
  const r = getDb()
    .prepare('INSERT INTO competitors (name, url, notes, source, watch, added_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(name, url, (c.notes ?? '').trim(), c.source ?? 'user', c.watch ? 1 : 0, new Date().toISOString());
  return getCompetitor(Number(r.lastInsertRowid))!;
}

export function updateCompetitor(id: number, patch: Partial<Pick<Competitor, 'name' | 'url' | 'notes' | 'watch'>>): Competitor {
  const c = getCompetitor(id);
  if (!c) throw new Error(`no competitor ${id}`);
  const url = patch.url === undefined ? c.url : siteOrigin(patch.url);
  if (patch.url && !url) throw new Error(`"${patch.url}" is not a web address`);
  if ((patch.watch ?? c.watch) && !url) throw new Error('add their website first — watching needs a site to look at');
  getDb()
    .prepare('UPDATE competitors SET name = ?, url = ?, notes = ?, watch = ? WHERE id = ?')
    .run((patch.name ?? c.name).trim() || c.name, url, (patch.notes ?? c.notes).trim(), (patch.watch ?? c.watch) ? 1 : 0, id);
  return getCompetitor(id)!;
}

export function removeCompetitor(id: number): void {
  const db = getDb();
  db.transaction(() => {
    db.prepare('DELETE FROM competitor_changes WHERE competitor_id = ?').run(id);
    db.prepare('DELETE FROM competitor_snapshots WHERE competitor_id = ?').run(id);
    db.prepare('DELETE FROM competitor_scans WHERE competitor_id = ?').run(id);
    db.prepare('DELETE FROM competitors WHERE id = ?').run(id);
  })();
}

// ---------------------------------------------------------------- people

export interface Person {
  id: number;
  name: string;
  role: string;
  bio: string;
  xHandle: string;
  linkedinUrl: string;
}

/** "@Name", "x.com/Name", "https://twitter.com/Name/" → "Name". */
export function xHandle(raw: string | undefined): string {
  const t = (raw ?? '').trim();
  const m = t.match(/(?:x\.com|twitter\.com)\/@?([A-Za-z0-9_]{1,15})/i) ?? t.match(/^@?([A-Za-z0-9_]{1,15})$/);
  if (t && !m) throw new Error(`"${t}" is not an X handle`);
  return m?.[1] ?? '';
}

export function linkedinUrl(raw: string | undefined): string {
  const t = (raw ?? '').trim();
  if (!t) return '';
  const u = siteOrigin(t);
  if (!u || !/linkedin\.com$/.test(new URL(u).hostname)) throw new Error(`"${t}" is not a LinkedIn address`);
  const full = new URL(/^https?:\/\//i.test(t) ? t : `https://${t}`);
  return `https://www.linkedin.com${full.pathname.replace(/\/$/, '')}`;
}

function personRow(r: any): Person {
  return { id: r.id, name: r.name, role: r.role, bio: r.bio, xHandle: r.x_handle, linkedinUrl: r.linkedin_url };
}

export function listPeople(): Person[] {
  return getDb().prepare('SELECT * FROM people ORDER BY id').all().map(personRow);
}

export function savePerson(p: { id?: number; name: string; role?: string; bio?: string; xHandle?: string; linkedinUrl?: string }): Person {
  const name = (p.name ?? '').trim();
  if (!name) throw new Error('a person needs a name');
  const row = [name, (p.role ?? '').trim(), (p.bio ?? '').trim(), xHandle(p.xHandle), linkedinUrl(p.linkedinUrl)];
  const db = getDb();
  if (p.id) {
    if (!db.prepare('SELECT 1 FROM people WHERE id = ?').get(p.id)) throw new Error(`no person ${p.id}`);
    db.prepare('UPDATE people SET name = ?, role = ?, bio = ?, x_handle = ?, linkedin_url = ? WHERE id = ?').run(...row, p.id);
    return personRow(db.prepare('SELECT * FROM people WHERE id = ?').get(p.id));
  }
  const r = db.prepare('INSERT INTO people (name, role, bio, x_handle, linkedin_url, added_at) VALUES (?, ?, ?, ?, ?, ?)').run(...row, new Date().toISOString());
  return personRow(db.prepare('SELECT * FROM people WHERE id = ?').get(r.lastInsertRowid));
}

export function removePerson(id: number): void {
  getDb().prepare('DELETE FROM people WHERE id = ?').run(id);
}

// ---------------------------------------------------------------- brand profiles and notes

export interface BrandProfiles {
  x: string;
  linkedin: string;
}

export function brandProfiles(): BrandProfiles {
  return getSetting<BrandProfiles>('brandProfiles', { x: '', linkedin: '' });
}

export function setBrandProfiles(p: Partial<BrandProfiles>): BrandProfiles {
  const next = { ...brandProfiles(), ...(p.x !== undefined ? { x: xHandle(p.x) } : {}), ...(p.linkedin !== undefined ? { linkedin: linkedinUrl(p.linkedin) } : {}) };
  setSetting('brandProfiles', next);
  return next;
}

export function userNotes(): string {
  return getSetting<string>('userNotes', '');
}

export function setUserNotes(text: string): void {
  setSetting('userNotes', text);
}

// ---------------------------------------------------------------- for agents

/** The hand-added context as one block for agent prompts, or null when there is none. Full text, never shortened. */
export function extraContext(): string | null {
  const parts: string[] = [];
  const comps = listCompetitors();
  if (comps.length)
    parts.push(['Competitors (the current list — prefer it over the Competitors document when they disagree):', ...comps.map((c) => `- ${c.name}${c.url ? ` (${c.url})` : ''}${c.notes ? `: ${c.notes}` : ''}`)].join('\n'));
  const people = listPeople();
  if (people.length)
    parts.push(
      [
        'People behind the business (posts written "as" someone must sound like them and stay true to this):',
        ...people.map((p) => `- ${p.name}${p.role ? `, ${p.role}` : ''}${p.bio ? `. ${p.bio}` : ''}${p.xHandle ? ` X: @${p.xHandle}.` : ''}${p.linkedinUrl ? ` LinkedIn: ${p.linkedinUrl}.` : ''}`),
      ].join('\n'),
    );
  const b = brandProfiles();
  if (b.x || b.linkedin) parts.push(`The brand's own accounts:${b.x ? ` X @${b.x}.` : ''}${b.linkedin ? ` LinkedIn ${b.linkedin}.` : ''}`);
  const notes = userNotes().trim();
  if (notes) parts.push(`Notes from the owner (these override anything above that conflicts with them):\n${notes}`);
  return parts.length ? parts.join('\n\n') : null;
}
