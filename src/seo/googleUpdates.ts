/**
 * Google's ranking updates, for explaining sudden moves: a drop in the week of a core update is often Google
 * re-weighing every site, not something wrong with the page. Only core and spam updates are listed, because
 * those are the ones that move rankings. Each entry links to Google's own announcement.
 * Taken from claude-seo's data/google-updates.json (MIT, verified 2026-09-28); add new ones at the end.
 */

export interface GoogleUpdate {
  date: string;
  name: string;
  kind: 'core' | 'spam';
  source: string;
}

export const GOOGLE_UPDATES: GoogleUpdate[] = [
  { date: '2024-03-05', name: "March 2024 Core Update + spam updates", kind: 'core', source: 'https://developers.google.com/search/blog/2024/03/core-update-spam-policies' },
  { date: '2024-06-20', name: "June 2024 Spam Update", kind: 'spam', source: 'https://status.search.google.com/products/rGHU1u87FJnkP6W2GwMi/history' },
  { date: '2024-08-15', name: "August 2024 Core Update", kind: 'core', source: 'https://developers.google.com/search/blog/2024/08/august-2024-core-update' },
  { date: '2024-11-11', name: "November 2024 Core Update", kind: 'core', source: 'https://status.search.google.com/products/rGHU1u87FJnkP6W2GwMi/history' },
  { date: '2024-12-12', name: "December 2024 Core Update", kind: 'core', source: 'https://status.search.google.com/products/rGHU1u87FJnkP6W2GwMi/history' },
  { date: '2024-12-19', name: "December 2024 Spam Update", kind: 'spam', source: 'https://status.search.google.com/incidents/UUq2WSouY7PhSm8zvtD1' },
  { date: '2025-03-13', name: "March 2025 Core Update", kind: 'core', source: 'https://status.search.google.com/products/rGHU1u87FJnkP6W2GwMi/history' },
  { date: '2025-06-30', name: "June 2025 Core Update", kind: 'core', source: 'https://status.search.google.com/products/rGHU1u87FJnkP6W2GwMi/history' },
  { date: '2025-08-26', name: "August 2025 Spam Update", kind: 'spam', source: 'https://status.search.google.com/incidents/a7Aainy6E9rZsmfq82xt' },
  { date: '2025-12-11', name: "December 2025 Core Update", kind: 'core', source: 'https://status.search.google.com/products/rGHU1u87FJnkP6W2GwMi/history' },
  { date: '2026-03-24', name: "March 2026 Spam Update", kind: 'spam', source: 'https://status.search.google.com/products/rGHU1u87FJnkP6W2GwMi/history' },
  { date: '2026-03-27', name: "March 2026 Core Update", kind: 'core', source: 'https://status.search.google.com/products/rGHU1u87FJnkP6W2GwMi/history' },
  { date: '2026-05-21', name: "May 2026 Core Update", kind: 'core', source: 'https://status.search.google.com/incidents/wdAXJk6LRRihEjpzEeWE' },
  { date: '2026-06-24', name: "June 2026 Spam Update", kind: 'spam', source: 'https://status.search.google.com/products/rGHU1u87FJnkP6W2GwMi/history' },
  { date: '2026-08-18', name: "August 2026 Spam Update", kind: 'spam', source: 'https://status.search.google.com/incidents/LEubPCm2octf2uMqCFKE' },
  { date: '2026-09-24', name: "September 2026 Spam Update", kind: 'spam', source: 'https://status.search.google.com/incidents/XhUDXP7A67iHCD2kmbVu' },
];

const DAY = 86400e3;

/** Updates announced between `from` and `to` (YYYY-MM-DD, both included), oldest first. */
export function updatesBetween(from: string, to: string): GoogleUpdate[] {
  return GOOGLE_UPDATES.filter((u) => u.date >= from && u.date <= to);
}

/**
 * Updates that could explain a move seen in the week starting `weekStart`. Core updates take about two weeks to
 * roll out, so one announced up to `daysBefore` days earlier still counts.
 */
export function updatesNear(weekStart: string, daysBefore = 14): GoogleUpdate[] {
  const start = new Date(`${weekStart}T00:00:00Z`).getTime();
  const iso = (t: number) => new Date(t).toISOString().slice(0, 10);
  return updatesBetween(iso(start - daysBefore * DAY), iso(start + 6 * DAY));
}
