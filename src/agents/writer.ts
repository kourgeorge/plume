import { MODELS } from '../config';
import { agentSystem } from '../context/profile';
import { askJson } from '../llm/client';
import { listDrafts } from '../queue';
import { writeArticle } from './seo';
import type { Agent, Opportunity } from './types';

const WRITER_ROLE = `You are the staff writer. You write long, genuinely useful articles — guides, comparisons, opinion pieces,
case-style explainers — that people bookmark and share. Concrete examples over generalities. Every section earns its place.
You sound like the brand voice document, not like a generic AI.`;

const TOPICS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['topics'],
  properties: {
    topics: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'angle', 'reason'],
        properties: {
          title: { type: 'string' },
          angle: { type: 'string', description: 'What makes this piece different from what is already out there.' },
          reason: { type: 'string', description: 'Which content-plan pillar it serves and why now.' },
        },
      },
    },
  },
};

export const writerAgent: Agent = {
  id: 'writer',
  label: 'Writer',
  description: 'Writes long-form articles from your content plan, in your brand voice.',
  async findOpportunities({ limit = 2, onProgress }) {
    onProgress?.('Picking topics from the content plan');
    const done = listDrafts().filter((d) => d.status !== 'rejected').map((d) => d.title);
    const res = await askJson<{ topics: { title: string; angle: string; reason: string }[] }>({
      purpose: 'writer:topics',
      model: MODELS.draft,
      system: agentSystem(WRITER_ROLE, undefined, undefined, 'writer'),
      schema: TOPICS_SCHEMA,
      prompt: `Pick the next ${limit} long-form articles from the content plan.\nAlready written or in review (don't repeat):\n${done.map((t) => `- ${t}`).join('\n') || '(none)'}`,
    });
    return res.topics.slice(0, limit).map<Opportunity>((t) => ({ title: t.title, keyword: t.title.toLowerCase(), reason: t.reason, angle: t.angle, kind: 'article' }));
  },
  draft: (opp) => writeArticle('writer', opp, WRITER_ROLE, `Angle: ${opp.angle}\nAim for 1,500–2,500 words with clear section headings.`),
};
