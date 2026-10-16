import type { Publisher } from './index';

/**
 * Webflow Data API v2: adds an item to a CMS collection (your blog).
 * Field slugs differ per site, so the body/summary field names are settings.
 * Items are created as drafts unless WEBFLOW_LIVE=1.
 */
export const webflow: Publisher = {
  id: 'webflow',
  label: 'Webflow',
  needs: ['WEBFLOW_TOKEN', 'WEBFLOW_COLLECTION_ID'],
  configured: (env = process.env) => !!(env.WEBFLOW_TOKEN && env.WEBFLOW_COLLECTION_ID),
  async publish(draft, html, env = process.env) {
    const api = (env.WEBFLOW_API_URL ?? 'https://api.webflow.com').replace(/\/$/, '');
    const live = env.WEBFLOW_LIVE === '1';
    const fieldData: Record<string, string> = {
      name: draft.title,
      slug: draft.meta.slug ?? '',
      [env.WEBFLOW_BODY_FIELD ?? 'post-body']: html,
    };
    if (env.WEBFLOW_SUMMARY_FIELD) fieldData[env.WEBFLOW_SUMMARY_FIELD] = draft.meta.metaDescription ?? '';
    const res = await fetch(`${api}/v2/collections/${env.WEBFLOW_COLLECTION_ID}/items${live ? '/live' : ''}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${env.WEBFLOW_TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ isDraft: !live, isArchived: false, fieldData }),
    });
    const data: any = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`Webflow said ${res.status}: ${data.message ?? res.statusText}`);
    const url = env.WEBFLOW_SITE_URL && fieldData.slug ? `${env.WEBFLOW_SITE_URL.replace(/\/$/, '')}/${env.WEBFLOW_PATH ?? 'blog'}/${fieldData.slug}` : null;
    return { url, externalId: data.id ?? null, dryRun: false };
  },
};
