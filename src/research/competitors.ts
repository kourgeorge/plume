import { MODELS } from '../config';
import { askJson } from '../llm/client';
import { readDoc } from '../context/profile';
import { addCompetitor, Competitor } from '../context/extra';

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['competitors'],
  properties: {
    competitors: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'website', 'note'],
        properties: {
          name: { type: 'string' },
          website: { type: 'string', description: 'Their main site, e.g. rival.com. Empty string if the document gives none.' },
          note: { type: 'string', description: 'One sentence: how they position themselves and where we can beat them.' },
        },
      },
    },
  },
};

/**
 * Turn the Competitors document into the editable list. Only names the document actually mentions —
 * the list is a copy of research, not new research. Already-listed competitors are left alone.
 */
export async function extractCompetitors(): Promise<Competitor[]> {
  const doc = readDoc('competitors');
  if (!doc) return [];
  const res = await askJson<{ competitors: { name: string; website: string; note: string }[] }>({
    purpose: 'research:competitor-list',
    model: MODELS.score,
    effort: 'low',
    maxTokens: 4000,
    system: 'You copy facts out of a document into a list. Never add anything the document does not say.',
    schema: SCHEMA,
    prompt: `List every competitor this document names, up to 12, most important first.\n\n<document>\n${doc}\n</document>`,
  });
  const added: Competitor[] = [];
  for (const c of res.competitors) {
    try {
      const row = addCompetitor({ name: c.name, url: c.website || null, notes: c.note, source: 'research' });
      if (row) added.push(row);
    } catch {
      // A malformed website from the model: keep the competitor, drop the address.
      const row = addCompetitor({ name: c.name, url: null, notes: c.note, source: 'research' });
      if (row) added.push(row);
    }
  }
  return added;
}
