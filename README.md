# Plume

Plume is a local AI marketing team that runs on your own computer. You add one or more websites. For each one, Plume reads the site, writes a business profile, and runs agents that find opportunities and write drafts: articles, social posts, outreach emails and site fixes. Nothing goes out until you approve it. It is built for small business owners, and for people who look after several sites (there is a client report for each site).

## Features

- **Several websites.** Each site has its own folder, database, connections and timetable. The start page (`/`) lists your sites; each site opens at `/s/<site>/`.
- **Business profile.** Markdown documents that every agent works from: product, marketing strategy, competitors, brand voice, content plan, plus an optional design guide and content strategy. Agents won't run until the core documents are done.
- **Agents.** SEO, Writer, Social, Reddit, Influencers, Links (link building), Short videos and Compliance. Each one finds opportunities and writes drafts. Agents write in the site's own language(s). The Social and Writer agents can pick a photo for each draft.
- **Drafts and approvals.** Every draft waits on the Dashboard. You can edit it, approve it (now or at a set time), reject it, or delete it. Approved drafts are published once, and the email and Reddit daily limits still apply. When you reject a draft, Plume keeps your reason; when you approve one, it keeps your edits. Agents use both next time.
- **Publishing.** WordPress, Webflow, Wix, Sanity, HubSpot, GitHub (Markdown files), X, LinkedIn, Facebook, Instagram, Reddit and email (SMTP). "Save as files" writes HTML and Markdown you can download. If a destination isn't connected, publishing to it is a dry run and nothing leaves your computer.
- **Dashboard.** One overview with drill-down, showing drafts, site fixes, speed problems, competitor changes, ranking moves (with Google update dates nearby), changes on your own pages and AI-visibility gaps. Items stay until you deal with them. Problems can be marked "Won't fix".
- **Ask Plume (chat).** A chat per thread that can read the site's data, propose changes to the profile, write drafts (they go to the Dashboard for approval) and start agent runs when you ask. Every Dashboard card has an "Ask Plume" button that opens a chat about that item.
- **Site check and fixes.** Crawls the site and runs an SEO audit. If GitHub is connected, Plume can prepare a fix, show you the file and the change, open a pull request (it never merges), and re-check the live page after the merge.
- **Compliance check.** Visits the site like a new visitor and checks privacy (cookie consent, trackers) and accessibility (using axe-core) against the laws likely to apply. It works out those laws from where visitors come from, the site's language and the phone number on the home page. It covers the EU, UK, US, California, Israel, Brazil, Canada, Switzerland and Australia. It can check every page, and drafts an accessibility statement and the missing parts of the privacy policy, leaving `[FILL IN: …]` placeholders where facts are missing.
- **Plume-Red (security).** Security scanning that only turns on once the site has a Google connection. With Analytics, it does read-only checks of headers, TLS and version numbers. With Search Console (proof that you own the domain), it also checks for files that should never be public. With a linked GitHub repo, it scans the repo too. Active tests run only after you tick "OK" for that scan.
- **Analytics and rankings.** Google Analytics and Search Console data (one-click Google sign-in), live visitors, page speed (PageSpeed Insights), tracked keywords, and who outranks you. Keyword data comes from DataForSEO and is optional.
- **AI visibility.** Asks Claude, GPT and Gemini the questions a customer would ask, and records whether they name your business and who they name instead.
- **Competitors.** Watches competitor pages for changes, and can search news and LinkedIn/X posts about them.
- **Outreach.** Link opportunities and creators (YouTube), with emails addressed to the page owner.
- **Client report.** A per-site report. When nothing was measured, it shows no score rather than a made-up one.
- **Tools.** Meta tag checker, robots.txt, sitemap, UTM links, structured data, llms.txt, and an AI humanizer.
- **Timetable.** Scheduled jobs per site: publishing, site check, Google data, speed, competitor watch, rankings, AI visibility, keyword data and compliance. Jobs that cost money start switched off.
- **Telegram.** Approve drafts from your phone through a Telegram bot. It uses long polling, so it needs no public address.
- **Any AI provider.** Anthropic, OpenAI, Gemini, Groq, Mistral, DeepSeek, xAI, OpenRouter, Together, Fireworks, Cerebras, Perplexity, Ollama, LM Studio, a LiteLLM-style gateway, or any OpenAI-compatible service. A monthly AI budget is shared by all sites.

## Requirements

- Node.js and npm. No version is pinned in `package.json`. `better-sqlite3` is a native module and gets built or downloaded when you run `npm install`.
- Google Chrome installed on the computer. Plume uses it (through `playwright-core`, with no separate browser download) to read pages that need JavaScript.
- An AI provider key, or a local model (Ollama, LM Studio). Without AI, the features that don't need it still work.

## Setup

```sh
npm install
cp .env.example .env   # then edit .env
```

Most connections can be set up in the app instead of `.env`:

- **AI connection**: the "AI connection" panel on the site list (saved in `data/tokens/llm.json`).
- **Publishing, social, email, Telegram, Google, YouTube**: the site's Settings (saved per site in that site's `integrations.json`). Anything not set there falls back to `.env`.
- **DataForSEO**: under Rankings (saved in `data/tokens/dataforseo.json`).

### Environment variables

All of these are optional. Put them in `.env` (loaded with `dotenv`). Don't commit real values.

**Core**

| Variable | What it does |
| --- | --- |
| `DATA_DIR` | Where the databases, profile docs and tokens live. Default `./data`. |
| `PORT` | Web server port. Default `4410`. The server only listens on `127.0.0.1`. |
| `PLUME_MONTHLY_BUDGET_USD` | Default monthly AI spending limit. Default `50`. |

**AI**

| Variable | What it does |
| --- | --- |
| `LLM_PROVIDER` | `anthropic`, `openai`, `gemini`, `groq`, `mistral`, `deepseek`, `xai`, `openrouter`, `together`, `fireworks`, `cerebras`, `perplexity`, `ollama`, `lmstudio`, `gateway` or `custom`. |
| `LLM_BASE_URL` | Address for a gateway, a custom service, or Ollama/LM Studio running elsewhere. |
| `LLM_API_KEY` | Key for the chosen provider. |
| `LLM_HEADERS` | Extra request headers, one `Name: value` per line. |
| `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, `GROQ_API_KEY`, `MISTRAL_API_KEY`, `DEEPSEEK_API_KEY`, `XAI_API_KEY`, `OPENROUTER_API_KEY`, `TOGETHER_API_KEY`, `FIREWORKS_API_KEY`, `CEREBRAS_API_KEY`, `PERPLEXITY_API_KEY` | A provider's own key. Used instead of `LLM_API_KEY` for that provider. |
| `PLUME_MODEL_RESEARCH`, `PLUME_MODEL_DRAFT`, `PLUME_MODEL_SCORE` | Override which model does each kind of work. |
| `PLUME_FALLBACKS` | `1` or `0` to turn model fallbacks on or off. |
| `PLUME_SEARCH` | Force web search mode: `server`, `local` or `off`. |
| `TAVILY_API_KEY` | Web search for every provider except Anthropic directly. |

`ANTHROPIC_BASE_URL` and `ANTHROPIC_AUTH_TOKEN` are deliberately ignored.

**Data sources**

| Variable | What it does |
| --- | --- |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Google OAuth client for Analytics and Search Console. |
| `PAGESPEED_API_KEY` | PageSpeed Insights key. Without it, you share Google's small daily limit. |
| `DATAFORSEO_LOGIN`, `DATAFORSEO_PASSWORD` | Rankings and keyword data. |
| `YOUTUBE_API_KEY` | Finding creators for outreach. |

**Photos and images**

| Variable | What it does |
| --- | --- |
| `PEXELS_API_KEY` | Adds Pexels to photo search. Openverse needs no key. |
| `IMAGE_API_URL`, `IMAGE_API_KEY`, `IMAGE_MODEL` | Image generation through an OpenAI-style images API. `OPENAI_API_KEY` alone is also enough. Default model `gpt-image-1`. |
| `PLUME_IMAGES=off` | Never generate pictures, only find them. |
| `PLUME_AGENT_PHOTOS=0` | Agents don't add photos on their own. |

**Publishing and social** (usually set per site in Settings)

- WordPress: `WP_URL`, `WP_USER`, `WP_APP_PASSWORD`, `WP_POST_STATUS`
- Webflow: `WEBFLOW_TOKEN`, `WEBFLOW_COLLECTION_ID`, `WEBFLOW_BODY_FIELD`, `WEBFLOW_SUMMARY_FIELD`, `WEBFLOW_SITE_URL`, `WEBFLOW_PATH`, `WEBFLOW_LIVE`, `WEBFLOW_API_URL`
- Wix: `WIX_API_KEY`, `WIX_SITE_ID`, `WIX_MEMBER_ID`, `WIX_LIVE`, `WIX_API_URL`
- Sanity: `SANITY_PROJECT_ID`, `SANITY_DATASET`, `SANITY_TOKEN`, `SANITY_TYPE`, `SANITY_BODY_FIELD`, `SANITY_SUMMARY_FIELD`, `SANITY_API_URL`
- HubSpot: `HUBSPOT_TOKEN`, `HUBSPOT_BLOG_ID`, `HUBSPOT_API_URL`
- GitHub (publishing and code fixes): `GITHUB_TOKEN`, `GITHUB_REPO`, `GITHUB_BRANCH`, `GITHUB_PATH`, `GITHUB_API_URL`
- X: `X_API_KEY`, `X_API_SECRET`, `X_ACCESS_TOKEN`, `X_ACCESS_SECRET`
- LinkedIn: `LINKEDIN_TOKEN`, `LINKEDIN_AUTHOR`, `LINKEDIN_VERSION`
- Facebook / Instagram: `FACEBOOK_PAGE_ID`, `FACEBOOK_PAGE_TOKEN`, `FACEBOOK_GRAPH_VERSION`, `INSTAGRAM_ACCOUNT_ID`
- Reddit: `REDDIT_CLIENT_ID`, `REDDIT_CLIENT_SECRET`, `REDDIT_USERNAME`, `REDDIT_PASSWORD`, `REDDIT_DAILY_LIMIT`
- Email: `SMTP_HOST`, `SMTP_PORT` (default 587), `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_FROM`, `SMTP_REPLY_TO`, `SMTP_DAILY_LIMIT`
- Telegram: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_API_URL`

`PLUME_SITE` picks a default site when no request or job has chosen one. The tests use it.

## Running

Development (runs the TypeScript directly with `ts-node`):

```sh
npm run dev
```

Then open `http://127.0.0.1:4410` (or your `PORT`).

Production: build to `dist/`, then run the compiled entry point.

```sh
npm run build
node dist/main.js
```

There is no `start` script in `package.json`. The `web/` folder is served from the repo, so run it from a full checkout.

Other scripts:

```sh
npm run typecheck   # tsc --noEmit
npm run demo        # adds a made-up site, acme-widgets.example, to try Plume without a real website
```

On shutdown (Ctrl+C), Plume closes the shared Chrome. On start, it marks jobs that a restart cut off as stopped.

## Tests

```sh
npm test
```

This runs `node --test tests/*.test.cjs`. Each test file loads the TypeScript source through `ts-node` and uses its own temporary `DATA_DIR`, so your real data isn't touched. The tests swap in fake browsers and fake HTTP servers, so Chrome and network keys aren't needed. Test pages are in `tests/fixtures/site/`.

## Database and upgrades

Plume uses SQLite (`better-sqlite3`, WAL mode), with two kinds of database:

- `data/plume.db`: shared. Holds the site list, AI usage (one budget for all sites), logs and app-wide settings.
- `data/sites/<site>/site.db`: one per site. Holds pages, drafts, jobs, analytics, competitors, chat, rankings, outreach, code fixes and so on.

Every table is defined in `src/db/schema.ts` as numbered steps: `SITE_MIGRATIONS` and `GLOBAL_MIGRATIONS`. Each database stores its version in SQLite's `user_version`. When a database is opened (`src/db/index.ts`), every step newer than that version runs in order, and each step either fully succeeds or changes nothing. Upgrades happen automatically; there is no separate command.

To change a table, add a new step at the end with the next version number. Never edit a step that has already shipped. `tests/schema.test.cjs` checks that versions start at 1 and go up by one.

## Project layout

```
src/
  main.ts          entry point: opens the DB, starts the server, scheduler and Telegram
  config.ts        DATA_DIR, PORT, model roles, prices
  server/          Fastify routes (JSON API under /api, pages at / and /s/<site>/)
  db/              schema.ts (all tables, numbered steps) and index.ts (opening and upgrading)
  agents/          agent list, SEO agent, Writer, SEO audit, shared instructions
  social/ outreach/ video/ compliance/   the other agents and their helpers
  publish/         publishers (WordPress, Webflow, Wix, Sanity, HubSpot, GitHub, files) and the runner
  llm/             AI providers, client, web search, budget, settings
  analytics/       Google Analytics / Search Console, live visitors, PageSpeed
  research/        crawling, page reading (with Chrome), safe-URL checks, profile building
  seo/ geo/        rankings, keyword data, briefs, AI visibility, code-fix pull requests
  red/             Plume-Red security scanning
  report/          client report
  tools/           free tools (meta tags, robots.txt, UTM, humanizer, ...)
  phone/           Telegram bot
  scheduler.ts     the Timetable (node-cron)
  chat.ts          Ask Plume
  today.ts         Dashboard feed
  scripts/seedDemo.ts   the demo site
web/               the browser app (plain HTML, CSS and JS)
tests/             node:test files (*.test.cjs) and fixtures
data/              created at run time (ignored by git)
ISSUES.md          known issues from the latest code review, with open/fixed status
```
