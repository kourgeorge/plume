import type { Publisher } from './index';

/** Plain paragraphs as Sanity "portable text" blocks; headings keep their level. */
export function toBlocks(markdown: string): unknown[] {
  return markdown
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p, i) => {
      const h = p.match(/^(#{1,4})\s+(.*)$/s);
      return {
        _type: 'block',
        _key: `b${i}`,
        style: h ? `h${h[1].length}` : 'normal',
        markDefs: [],
        children: [{ _type: 'span', _key: `s${i}`, text: (h ? h[2] : p).replace(/\s*\n\s*/g, ' '), marks: [] }],
      };
    });
}

/** Sanity Mutations API. Creates a draft document ("drafts." id), so the editor still has to publish it in Studio. */
export const sanity: Publisher = {
  id: 'sanity',
  label: 'Sanity',
  needs: ['SANITY_PROJECT_ID', 'SANITY_DATASET', 'SANITY_TOKEN'],
  configured: (env = process.env) => !!(env.SANITY_PROJECT_ID && env.SANITY_DATASET && env.SANITY_TOKEN),
  async publish(draft, _html, env = process.env) {
    const api = (env.SANITY_API_URL ?? `https://${env.SANITY_PROJECT_ID}.api.sanity.io`).replace(/\/$/, '');
    const id = `drafts.plume-${draft.id}-${Date.now().toString(36)}`;
    const doc: Record<string, unknown> = {
      _id: id,
      _type: env.SANITY_TYPE || 'post',
      title: draft.title,
      slug: { _type: 'slug', current: draft.meta.slug ?? '' },
      [env.SANITY_BODY_FIELD || 'body']: toBlocks(draft.body.replace(/^\s*#\s+[^\n]*\n+/, '')),
    };
    if (env.SANITY_SUMMARY_FIELD) doc[env.SANITY_SUMMARY_FIELD] = draft.meta.metaDescription ?? '';
    const res = await fetch(`${api}/v2021-06-07/data/mutate/${env.SANITY_DATASET}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${env.SANITY_TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ mutations: [{ create: doc }] }),
    });
    const data: any = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`Sanity said ${res.status}: ${data.error?.description ?? data.message ?? res.statusText}`);
    return { url: null, externalId: data.results?.[0]?.id ?? id, dryRun: false };
  },
};
