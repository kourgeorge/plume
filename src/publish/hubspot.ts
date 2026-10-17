import type { Publisher } from './index';

/** HubSpot CMS Blog Posts API (private app token with the "content" scope). Posts are created as drafts. */
export const hubspot: Publisher = {
  id: 'hubspot',
  label: 'HubSpot',
  needs: ['HUBSPOT_TOKEN', 'HUBSPOT_BLOG_ID'],
  configured: (env = process.env) => !!(env.HUBSPOT_TOKEN && env.HUBSPOT_BLOG_ID),
  async publish(draft, html, env = process.env) {
    const api = (env.HUBSPOT_API_URL ?? 'https://api.hubapi.com').replace(/\/$/, '');
    const res = await fetch(`${api}/cms/v3/blogs/posts`, {
      method: 'POST',
      headers: { authorization: `Bearer ${env.HUBSPOT_TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        name: draft.title,
        htmlTitle: draft.title,
        contentGroupId: env.HUBSPOT_BLOG_ID,
        postBody: html,
        slug: draft.meta.slug,
        metaDescription: draft.meta.metaDescription ?? '',
        state: 'DRAFT',
      }),
    });
    const data: any = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`HubSpot said ${res.status}: ${data.message ?? res.statusText}`);
    return { url: data.url ?? null, externalId: data.id ? String(data.id) : null, dryRun: false };
  },
};
