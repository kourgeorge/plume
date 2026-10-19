import type { FastifyInstance } from 'fastify';
import {
  analyzeAiMarkers, buildRobots, buildSchema, buildSitemap, buildUtm, checkMetaUrl,
  humanizeText, sitemapPages, toolDefaults,
} from '../tools';

/** Tools & growth utilities. Registered from the main route file. */
export function registerToolsRoutes(app: FastifyInstance): void {
  const tool = (fn: (b: any) => unknown) => async (req: any, reply: any) => {
    try {
      return await fn(req.body ?? {});
    } catch (err: any) {
      return reply.code(400).send({ error: String(err?.message ?? err) });
    }
  };
  app.get('/api/tools', async () => toolDefaults());
  app.post('/api/tools/meta', tool((b) => checkMetaUrl(String(b.url ?? ''))));
  app.post('/api/tools/robots', tool((b) => ({ text: buildRobots({ aiSearch: b.aiSearch !== false, aiTraining: !!b.aiTraining, disallow: Array.isArray(b.disallow) ? b.disallow.map(String) : [], sitemap: String(b.sitemap ?? '') }) })));
  app.post('/api/tools/sitemap', tool(() => {
    const pages = sitemapPages();
    if (!pages.length) throw new Error('Plume has not read any pages of this site yet — run the site check first');
    return { text: buildSitemap(pages), count: pages.length };
  }));
  app.post('/api/tools/utm', tool((b) => ({ text: buildUtm(b) })));
  app.post('/api/tools/schema', tool((b) => ({ text: buildSchema(b) })));
  app.post('/api/tools/humanize-check', tool((b) => analyzeAiMarkers(String(b.text ?? ''))));
  app.post('/api/tools/humanize', tool((b) => humanizeText({ text: String(b.text ?? ''), tone: b.tone, level: b.level })));
}
