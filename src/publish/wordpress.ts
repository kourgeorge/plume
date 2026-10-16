import type { Publisher } from './index';

/**
 * WordPress REST API with an application password (Users → Profile → Application Passwords).
 * Posts go in as drafts unless WP_POST_STATUS=publish, so nothing goes live by surprise.
 */
export const wordpress: Publisher = {
  id: 'wordpress',
  label: 'WordPress',
  needs: ['WP_URL', 'WP_USER', 'WP_APP_PASSWORD'],
  configured: (env = process.env) => !!(env.WP_URL && env.WP_USER && env.WP_APP_PASSWORD),
  async publish(draft, html, env = process.env) {
    const base = env.WP_URL!.replace(/\/$/, '');
    const auth = Buffer.from(`${env.WP_USER}:${env.WP_APP_PASSWORD!.replace(/\s/g, '')}`).toString('base64');
    const status = env.WP_POST_STATUS === 'publish' ? 'publish' : 'draft';
    const res = await fetch(`${base}/wp-json/wp/v2/${draft.kind === 'landing_page' ? 'pages' : 'posts'}`, {
      method: 'POST',
      headers: { authorization: `Basic ${auth}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        title: draft.title,
        content: html,
        slug: draft.meta.slug,
        excerpt: draft.meta.metaDescription ?? '',
        status,
      }),
    });
    const data: any = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`WordPress said ${res.status}: ${data.message ?? res.statusText}`);
    return { url: data.link ?? null, externalId: String(data.id), dryRun: false };
  },
};
