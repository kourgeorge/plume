/**
 * Which AI services may read the site, from its robots.txt.
 * Search crawlers decide whether the site can appear in AI answers; training-only crawlers don't,
 * so blocking those is a free choice and is never reported as a problem.
 */
export interface AiCrawler {
  agent: string;
  owner: string;
  /** search = fetches pages for live answers; training = collects text for future models only. */
  kind: 'search' | 'training';
  what: string;
}

export const AI_CRAWLERS: AiCrawler[] = [
  { agent: 'OAI-SearchBot', owner: 'OpenAI', kind: 'search', what: 'ChatGPT search results' },
  { agent: 'ChatGPT-User', owner: 'OpenAI', kind: 'search', what: 'pages ChatGPT opens when someone asks about you' },
  { agent: 'GPTBot', owner: 'OpenAI', kind: 'search', what: 'ChatGPT (also used for training)' },
  { agent: 'ClaudeBot', owner: 'Anthropic', kind: 'search', what: 'Claude' },
  { agent: 'Claude-SearchBot', owner: 'Anthropic', kind: 'search', what: 'Claude search results' },
  { agent: 'Claude-User', owner: 'Anthropic', kind: 'search', what: 'pages Claude opens when someone asks about you' },
  { agent: 'PerplexityBot', owner: 'Perplexity', kind: 'search', what: 'Perplexity answers' },
  { agent: 'Google-Extended', owner: 'Google', kind: 'search', what: 'Gemini (does not affect normal Google results)' },
  { agent: 'Applebot-Extended', owner: 'Apple', kind: 'search', what: 'Apple Intelligence (does not affect Siri or Spotlight)' },
  { agent: 'CCBot', owner: 'Common Crawl', kind: 'training', what: 'a public archive many AI models are trained on' },
  { agent: 'anthropic-ai', owner: 'Anthropic', kind: 'training', what: 'Claude training only' },
  { agent: 'Bytespider', owner: 'ByteDance', kind: 'training', what: 'ByteDance model training' },
  { agent: 'cohere-ai', owner: 'Cohere', kind: 'training', what: 'Cohere model training' },
];

interface Group {
  agents: string[];
  rules: { allow: boolean; path: string }[];
}

/** robots.txt as groups of user-agents sharing rules. Consecutive User-agent lines form one group. */
export function parseRobotsGroups(body: string): Group[] {
  const groups: Group[] = [];
  let cur: Group | null = null;
  let lastWasAgent = false;
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.split('#')[0].trim();
    const i = line.indexOf(':');
    if (i < 0) continue;
    const key = line.slice(0, i).trim().toLowerCase();
    const value = line.slice(i + 1).trim();
    if (key === 'user-agent') {
      if (!cur || !lastWasAgent) groups.push((cur = { agents: [], rules: [] }));
      cur.agents.push(value.toLowerCase());
      lastWasAgent = true;
    } else {
      lastWasAgent = false;
      if (cur && (key === 'allow' || key === 'disallow')) {
        // "Disallow:" with nothing after it means "allow everything".
        if (key === 'disallow' && !value) continue;
        cur.rules.push({ allow: key === 'allow', path: value });
      }
    }
  }
  return groups;
}

/** Turn a robots.txt path pattern ("/a*", "/b$") into a test. */
function matches(pattern: string, path: string): boolean {
  const re = new RegExp('^' + pattern.replace(/[.+?^${}()|[\]\\]/g, (c) => (c === '$' ? c : `\\${c}`)).replace(/\*/g, '.*'));
  return re.test(path);
}

/**
 * Can this crawler read this path? Follows the standard (RFC 9309): a crawler obeys only the group that names it,
 * falling back to "*"; within it the longest matching rule wins, and Allow wins a tie.
 */
export function canRead(groups: Group[], agent: string, path = '/'): boolean {
  const a = agent.toLowerCase();
  const own = groups.filter((g) => g.agents.includes(a));
  const use = own.length ? own : groups.filter((g) => g.agents.includes('*'));
  let best: { allow: boolean; len: number } | null = null;
  for (const r of use.flatMap((g) => g.rules)) {
    if (!matches(r.path, path)) continue;
    const len = r.path.length;
    if (!best || len > best.len || (len === best.len && r.allow)) best = { allow: r.allow, len };
  }
  return best ? best.allow : true;
}

export interface CrawlerAccess extends AiCrawler {
  allowed: boolean;
  /** Named in robots.txt by name, rather than covered by the "*" rules. */
  named: boolean;
}

export function aiAccess(robots: string | null): CrawlerAccess[] {
  const groups = parseRobotsGroups(robots ?? '');
  return AI_CRAWLERS.map((c) => ({
    ...c,
    allowed: canRead(groups, c.agent, '/'),
    named: groups.some((g) => g.agents.includes(c.agent.toLowerCase())),
  }));
}

/**
 * The lines to add so the blocked search crawlers can read the site. Each crawler obeys only the group that
 * names it, so a group naming it with "Allow: /" overrides a "*" block without touching other crawlers.
 * If a crawler already has its own group that blocks it, that group has to be edited by hand.
 */
export function unblockSnippet(blocked: CrawlerAccess[]): string {
  return blocked.map((c) => `User-agent: ${c.agent}`).join('\n') + '\nAllow: /';
}
