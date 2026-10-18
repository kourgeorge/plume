import type Database from 'better-sqlite3';
import { getDb } from '../db';

/**
 * People Plume may contact on the owner's behalf: creators (influencer outreach) and sites that could link
 * to the business (link building). One row per person or page, with where they are in the conversation.
 * Created by the feature itself, so the shared schema file stays untouched.
 */
const TABLES = `
CREATE TABLE IF NOT EXISTS outreach_contacts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,              -- creator | link
  name TEXT NOT NULL,
  url TEXT NOT NULL,               -- creator profile, or the page that could link to us
  platform TEXT NOT NULL DEFAULT '',
  audience TEXT NOT NULL DEFAULT '',  -- as stated on the page ("12k subscribers"); never estimated
  email TEXT NOT NULL DEFAULT '',
  email_source TEXT NOT NULL DEFAULT '', -- the page the address was read from
  email_verified INTEGER NOT NULL DEFAULT 0, -- 1 = Plume saw the address on that page, or the owner typed it
  why TEXT NOT NULL DEFAULT '',
  opportunity TEXT NOT NULL DEFAULT '', -- link prospects: unlinked-mention | lists-competitors
  status TEXT NOT NULL DEFAULT 'found',
  rate TEXT NOT NULL DEFAULT '',
  deliverable_url TEXT NOT NULL DEFAULT '',
  paid INTEGER NOT NULL DEFAULT 0,
  notes TEXT NOT NULL DEFAULT '',
  last_emailed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (kind, url)
);
CREATE TABLE IF NOT EXISTS link_evidence (
  contact_id INTEGER PRIMARY KEY,
  evidence TEXT NOT NULL,
  checked_at TEXT NOT NULL,
  verification TEXT,
  verified_url TEXT,
  verification_at TEXT,
  verification_note TEXT
);
CREATE TABLE IF NOT EXISTS link_discovery_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  result TEXT,
  error TEXT
);
CREATE INDEX IF NOT EXISTS outreach_by_status ON outreach_contacts (kind, status);
`;
const ready = new WeakSet<Database.Database>();
export function odb(): Database.Database {
  const d = getDb();
  if (!ready.has(d)) {
    d.exec(TABLES);
    ready.add(d);
  }
  return d;
}

export type ContactKind = 'creator' | 'link';
export const STATUSES: Record<ContactKind, string[]> = {
  creator: ['found', 'drafted', 'contacted', 'replied', 'agreed', 'posted', 'paid', 'declined'],
  link: ['found', 'drafted', 'contacted', 'replied', 'linked', 'declined'],
};

export interface Contact {
  id: number;
  kind: ContactKind;
  name: string;
  url: string;
  platform: string;
  audience: string;
  email: string;
  emailSource: string;
  emailVerified: boolean;
  why: string;
  opportunity: string;
  status: string;
  rate: string;
  deliverableUrl: string;
  paid: boolean;
  notes: string;
  lastEmailedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

function row(r: any): Contact {
  return {
    id: r.id, kind: r.kind, name: r.name, url: r.url, platform: r.platform, audience: r.audience, email: r.email,
    emailSource: r.email_source, emailVerified: !!r.email_verified, why: r.why, opportunity: r.opportunity, status: r.status,
    rate: r.rate, deliverableUrl: r.deliverable_url, paid: !!r.paid, notes: r.notes, lastEmailedAt: r.last_emailed_at,
    createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

const EMAIL_RE = /^[^\s@<>()"',;]+@[^\s@<>()"',;]+\.[a-z]{2,}$/i;
export function isEmail(s: string): boolean {
  return EMAIL_RE.test(s.trim());
}

/** An address as typed or found, made absolute ("site.com" → "https://site.com"). Use this to read the page. */
export function absUrl(raw: string): string {
  return new URL(/^https?:\/\//i.test(raw.trim()) ? raw.trim() : `https://${raw.trim()}`).toString();
}

/**
 * "http://www.YouTube.com/@Name/?utm_x=1" → "https://youtube.com/@Name". The key used to avoid duplicates —
 * not for fetching: a site that only answers on http, or only on www., would not load from it.
 */
export function cleanUrl(raw: string): string {
  const u = new URL(absUrl(raw));
  u.hash = '';
  for (const k of [...u.searchParams.keys()]) if (/^(utm_|fbclid|gclid|ref$|si$)/.test(k)) u.searchParams.delete(k);
  // www. and http/https point at the same place for every site worth contacting; keep one spelling.
  u.protocol = 'https:';
  u.hostname = u.hostname.toLowerCase().replace(/^www\./, '');
  return u.toString().replace(/\/$/, '');
}

export function listContacts(kind?: ContactKind): Contact[] {
  const rows = kind
    ? odb().prepare('SELECT * FROM outreach_contacts WHERE kind = ? ORDER BY id DESC').all(kind)
    : odb().prepare('SELECT * FROM outreach_contacts ORDER BY id DESC').all();
  return rows.map(row);
}

export function getContact(id: number): Contact | undefined {
  const r = odb().prepare('SELECT * FROM outreach_contacts WHERE id = ?').get(id);
  return r ? row(r) : undefined;
}

export interface NewContact {
  kind: ContactKind;
  name: string;
  url: string;
  platform?: string;
  audience?: string;
  email?: string;
  emailSource?: string;
  emailVerified?: boolean;
  why?: string;
  opportunity?: string;
}

/** Add someone, unless they're already on the list (same kind and address). Returns null for a duplicate. */
export function addContact(c: NewContact): Contact | null {
  const name = String(c.name ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);
  if (!name) throw new Error('a contact needs a name');
  let url: string;
  try {
    url = cleanUrl(c.url);
  } catch {
    throw new Error(`"${c.url}" is not a web address`);
  }
  const email = String(c.email ?? '').trim().toLowerCase();
  if (email && !isEmail(email)) throw new Error(`"${email}" is not an email address`);
  const now = new Date().toISOString();
  const r = odb()
    .prepare(
      `INSERT OR IGNORE INTO outreach_contacts (kind, name, url, platform, audience, email, email_source, email_verified, why, opportunity, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(c.kind, name, url, c.platform ?? '', c.audience ?? '', email, c.emailSource ?? '', email && c.emailVerified ? 1 : 0, c.why ?? '', c.opportunity ?? '', now, now);
  return r.changes ? getContact(Number(r.lastInsertRowid))! : null;
}

export interface ContactPatch {
  status?: string;
  email?: string;
  rate?: string;
  deliverableUrl?: string;
  paid?: boolean;
  notes?: string;
  name?: string;
}

export function updateContact(id: number, patch: ContactPatch): Contact {
  const c = getContact(id);
  if (!c) throw new Error(`no contact ${id}`);
  if (patch.status !== undefined && !STATUSES[c.kind].includes(patch.status)) throw new Error(`"${patch.status}" is not a step for this contact`);
  let email = c.email;
  let verified = c.emailVerified;
  let source = c.emailSource;
  if (patch.email !== undefined) {
    email = patch.email.trim().toLowerCase();
    if (email && !isEmail(email)) throw new Error(`"${email}" is not an email address`);
    // An address the owner types is theirs to vouch for.
    verified = !!email;
    source = email ? 'typed by you' : '';
  }
  if (patch.deliverableUrl) {
    try {
      cleanUrl(patch.deliverableUrl);
    } catch {
      throw new Error(`"${patch.deliverableUrl}" is not a web address`);
    }
  }
  odb()
    .prepare(
      `UPDATE outreach_contacts SET name = ?, status = ?, email = ?, email_verified = ?, email_source = ?, rate = ?, deliverable_url = ?, paid = ?, notes = ?, updated_at = ? WHERE id = ?`,
    )
    .run(
      (patch.name ?? c.name).trim() || c.name,
      patch.status ?? c.status,
      email,
      verified ? 1 : 0,
      source,
      (patch.rate ?? c.rate).trim().slice(0, 100),
      (patch.deliverableUrl ?? c.deliverableUrl).trim(),
      (patch.paid ?? c.paid) ? 1 : 0,
      (patch.notes ?? c.notes).slice(0, 4000),
      new Date().toISOString(),
      id,
    );
  return getContact(id)!;
}

export function markEmailed(id: number, at = new Date()): void {
  odb().prepare(`UPDATE outreach_contacts SET status = CASE WHEN status IN ('found','drafted') THEN 'contacted' ELSE status END, last_emailed_at = ?, updated_at = ? WHERE id = ?`).run(at.toISOString(), at.toISOString(), id);
}

export function removeContact(id: number): void {
  odb().prepare('DELETE FROM outreach_contacts WHERE id = ?').run(id);
}

/** Addresses never to write to: anyone who declined, under any kind. */
export function declinedEmails(): Set<string> {
  return new Set((odb().prepare(`SELECT email FROM outreach_contacts WHERE status = 'declined' AND email != ''`).all() as { email: string }[]).map((r) => r.email));
}

/** Contacts ready for a first message: found, not declined, and not written to in the last 30 days. */
export function readyToDraft(kind: ContactKind, limit: number): Contact[] {
  const cutoff = new Date(Date.now() - 30 * 86400e3).toISOString();
  return listContacts(kind)
    .filter((c) => c.status === 'found' && (!c.lastEmailedAt || c.lastEmailedAt < cutoff))
    .sort((a, b) => Number(b.emailVerified) - Number(a.emailVerified) || a.id - b.id)
    .slice(0, limit);
}

export function summary(kind: ContactKind): Record<string, number> {
  const out: Record<string, number> = {};
  for (const s of STATUSES[kind]) out[s] = 0;
  for (const r of odb().prepare('SELECT status, COUNT(*) n FROM outreach_contacts WHERE kind = ? GROUP BY status').all(kind) as { status: string; n: number }[]) out[r.status] = r.n;
  return out;
}

export function linkEvidence(id: number): any {
  return odb().prepare('SELECT * FROM link_evidence WHERE contact_id = ?').get(id) ?? null;
}
export function saveLinkEvidence(id: number, evidence: string): void {
  odb().prepare(`INSERT INTO link_evidence (contact_id, evidence, checked_at) VALUES (?, ?, ?)
    ON CONFLICT(contact_id) DO UPDATE SET evidence = excluded.evidence, checked_at = excluded.checked_at`)
    .run(id, evidence, new Date().toISOString());
}
export function saveVerification(id: number, state: string, url: string, note: string): void {
  odb().prepare(`INSERT INTO link_evidence (contact_id, evidence, checked_at, verification, verified_url, verification_at, verification_note)
    VALUES (?, '', ?, ?, ?, ?, ?) ON CONFLICT(contact_id) DO UPDATE SET verification = excluded.verification,
    verified_url = excluded.verified_url, verification_at = excluded.verification_at, verification_note = excluded.verification_note`)
    .run(id, new Date().toISOString(), state, url, new Date().toISOString(), note);
}
export function latestLinkDiscovery(): any {
  const row = odb().prepare('SELECT * FROM link_discovery_runs ORDER BY id DESC LIMIT 1').get() as any;
  return row ? { ...row, result: row.result ? JSON.parse(row.result) : null } : null;
}
