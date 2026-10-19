# Code review issues (2026-10-19)

Found by a full review of the code. Type check and all 270 tests passed before this review.
Status: `[ ]` open, `[x]` fixed.

## High

- [x] **H1. The same post can be published twice.** Approve (web and Telegram) calls `publishOne` directly while the draft is still `approved`; the every-minute `publishDue` picks it up too. Slow publishes (videos, SMTP, WordPress) make it likely. `src/publish/runner.ts`, `src/server/index.ts:355-357`, `src/phone/telegram.ts:211-213`.
- [x] **H2. Daily email and Reddit limits are skipped on Approve.** Limits are only checked in `publishDue`, so "Approve & send" on 30 emails sends all 30. `src/publish/runner.ts`.
- [x] **H3. Outreach emails can go to the wrong person.** `findEmail` takes the first address on a page, including directory / "best of" pages that list competitors, and marks it verified. `src/outreach/links.ts:150-162`, `src/outreach/creators.ts:36-68`.
- [x] **H4. Client report invents an "85/100" health score** when there is no audit and no AI-visibility run. `src/report/clientReport.ts:183`, shown by `web/report.js:69`.
- [x] **H5. A web page the AI reads could redirect it into Plume itself** (e.g. `/api/telegram` → leak the link code → take over the Telegram bot). `readPage` checked only the first address, then followed redirects. `src/llm/search.ts:61-64`.

## Medium

- [ ] **M1. Slug can write files outside the intended folder** (`..` in slug) on GitHub (overwrite README.md etc.) and on disk. Slug comes from the AI. `src/publish/github.ts:13-21`, `src/publish/index.ts:85-87`.
- [ ] **M2. Raw HTML / `javascript:` links reach the CMS.** `toHtml` uses plain `marked`; the preview uses the safe renderer, so what's approved differs from what goes live. `src/publish/index.ts:32-34`.
- [ ] **M3. Retrying a failed X thread re-posts it from the start**; Reddit uses `resubmit: 'true'`. Error messages say "will be retried later" but nothing retries. `src/social/publishers.ts:181-190, 606`.
- [ ] **M4. One hung CMS request stops scheduled publishing for every site** (no fetch timeout; `busy` is global). `src/publish/wordpress.ts`, `webflow.ts`, `hubspot.ts`, `sanity.ts`.
- [ ] **M5. Crawl has no real limit when pages fail** (failures don't count; sitemap fully queued; no body size cap). `src/research/crawl.ts:181-201`.
- [x] **M6. SSRF in link discovery / email finding** — AI-supplied URLs can point at localhost / internal addresses, redirects followed. `src/outreach/links.ts:132-139`, `src/outreach/creators.ts:49-63`, `src/research/fetchPage.ts:70`.
- [ ] **M7. Adding a site doesn't call `reschedule()`** — its scheduled posts and daily pulls don't run until restart. `src/server/index.ts:119-126`.
- [ ] **M8. Deleting a site during a running job recreates its folder** and breaks the job. `src/sites.ts:92-97`, `src/db/index.ts`.
- [ ] **M9. Run button accepts any draft count** (`limit` unchecked; timetable allows 1–10) → large AI bill. `src/server/index.ts:266-268`.
- [ ] **M10. Paid rankings routes have no "already running" check** — double click pays twice. `src/server/index.ts:671-687`.
- [ ] **M11. Report lists dry runs / file exports as "Live" published content.** `src/report/clientReport.ts:171-179, 504`.
- [ ] **M12. Competitor-gap keywords dropped if they contain the first part of our hostname** (`shop.brand.com` → drops everything with "shop"). `src/seo/keywordData.ts:261`.
- [ ] **M13. Search-data drafts never get their higher Dashboard priority** — `opp.source` isn't saved to `meta`. `src/today.ts:86-93`, `src/agents/seo.ts:119`.
- [ ] **M14. Report shows already-fixed issues as "Action Required".** `src/report/clientReport.ts:107-111`.
- [ ] **M15. Humanizer uses paid AI but Tools page says "no AI"; button not disabled while running.** `web/tools.js:10, 162`.

## Low

- [ ] L1. Double-click "open" on a code fix opens two PRs. `src/geo/codefix.ts:504-543`.
- [ ] L2. Reopening a draft during a slow publish loses track of the live post (moveDraft throws twice). `src/publish/runner.ts:18-25`.
- [ ] L3. Email recipient checks skipped when draft has no contact. `src/outreach/email.ts:60-62`.
- [ ] L4. Logs routes crash on `?limit=abc` (NaN LIMIT). `src/server/index.ts:494, 497`.
- [ ] L5. Uploads fully written to disk (up to 1 GB) before size check; footage has no type check. `src/server/outreachRoutes.ts:140-199`.
- [ ] L6. Google sign-in can be cancelled by any GET to the callback; two sites overwrite each other. `src/server/index.ts:393-399`, `src/analytics/google.ts:55-78`.
- [ ] L7. `?by=toString` passes the live breakdown check. `src/server/index.ts:474`.
- [ ] L8. Report HTML page has no Content-Security-Policy (everything is escaped, so no live XSS). `src/server/reportRoutes.ts:20-31`.
- [ ] L9. "Active now" shows the whole last hour; panel shows same number twice; any error treated as "not 360". `src/analytics/live.ts:59, 74-75`, `web/app.js:1352, 1371`.
- [ ] L10. Competitor refresh overwrites saved intent / CPC with NULL. `src/seo/keywordData.ts:216-219`.
- [ ] L11. Keywords with double spaces cached as "no data" for 30 days. `src/seo/keywordData.ts:103, 118-123`.
- [ ] L12. Ranking change of 0 becomes null. `src/report/clientReport.ts:164`.
- [ ] L13. AI-visibility shows 0% when nothing was answered. `src/report/clientReport.ts:118`.
- [ ] L14. Markdown download link drops custom report settings. `src/report/clientReport.ts:343`.
- [ ] L15. `javascript:` URLs not blocked in report / rankings links. `src/report/clientReport.ts:504`, `web/report.js:160`, `web/rankings.js:594`.
- [ ] L16. Dashboard "today" uses UTC midnight, not local. `src/today.ts:23-25`.
- [ ] L17. Rankings tab errors fail silently (unhandled rejection). `web/app.js` ~1400, ~1492.
- [ ] L18. Saving report settings can pull you back to the Report view. `web/report.js` ~190.
- [ ] L19. Report keeps showing old error text while reloading. `web/report.js:44, 174`.
- [ ] L20. "Check competitors" button re-enabled when it should stay off. `web/rankings.js:97, ~222`.

### Medium (AI, chat, tools, Telegram, scheduler)

- [ ] **M16. Untrusted web content can trigger paid actions with no approval** (`run_agent`, `scan_competitors` with news, `add_competitor`); only the system prompt stops it. `src/chat.ts:229-235, 417-456`.
- [ ] **M17. Haiku is sent `web_search_20260209`, which the API lists only for Opus/Sonnet** → weekly competitor-news likely fails with 400. `src/llm/client.ts:106, 151`, `src/watch.ts:326-330`. (From docs, not tested.)
- [ ] **M18. A paused web search (`pause_turn`) is returned as the final answer** on the single-call path. `src/llm/client.ts:109-113`.
- [ ] **M19. Humanizer can return cut-off text silently** (`stopReason` not checked; thinking uses the token budget). `src/tools/index.ts:351-357`.
- [ ] **M20. A DB error at the wrong moment jams a task forever or crashes Plume** (`running.add` before `try`; no `unhandledRejection` handler; Telegram loop). `src/scheduler.ts:229-234, 270`, `src/phone/telegram.ts:379`, `src/chat.ts:564-568`.
- [ ] **M21. Long chats grow more expensive each turn and eventually break** (full history resent, no cap on page reads, no compaction). `src/chat.ts:587-605`.

### Low (AI, chat, tools, Telegram, scheduler)

- [ ] L21. A correct `/start <code>` from any chat silently replaces the linked phone; old chat isn't told. Group chats: every member can approve. `src/phone/telegram.ts:55-61, 187-191`.
- [ ] L22. DataForSEO spending isn't counted in the monthly budget; failed/retried AI calls aren't counted. `src/scheduler.ts:157-170`, `src/llm/client.ts:275`.
- [ ] L23. (Follow-up to H5/M6) The address check uses its own DNS lookup, so a hostile DNS server could answer differently for the real request ("DNS rebinding"). Closing it fully needs a custom connection agent that pins the checked IP. `src/research/safeUrl.ts`.

## What was changed for the high issues

- **H1 + H2** `src/publish/runner.ts`: `publishOne` keeps a list of drafts being published and refuses a second start; it also checks the email/Reddit daily limits itself, so Approve (web and Telegram) obeys them. Over the limit, the draft stays approved and the timer sends it another day. The timer re-reads each draft before sending and skips ones that changed. `web/app.js`: an approved draft with no time now says "goes out as soon as today's limit allows" instead of "Scheduled for —".
- **H3** `src/outreach/creators.ts`, `links.ts`: for link pages, only an address on the page's own domain is used.
- **H4** `src/report/clientReport.ts`, `web/report.js`: no score is shown ("—") when nothing was measured.
- **H5 + M6** new `src/research/safeUrl.ts`: refuses localhost / local-network addresses (by name and by DNS) and re-checks every redirect. Used by the AI page reader, link discovery, email finder, competitor briefs and competitor snapshots. The owner's own site (crawl, code fixes) can still be on localhost.
- Tests added in `tests/outreach.test.cjs`, `tests/llm.test.cjs`, `tests/report.test.cjs`. All 285 tests pass.
