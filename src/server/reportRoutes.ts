import type { FastifyInstance } from 'fastify';
import {
  buildClientReportData, getReportSettings, renderReportHtml, renderReportMarkdown,
  saveReportSettings,
} from '../report/clientReport';

export function registerReportRoutes(app: FastifyInstance): void {
  app.get('/api/report/settings', async () => getReportSettings());

  app.post<{ Body: Record<string, unknown> }>('/api/report/settings', async (req, reply) => {
    try {
      return saveReportSettings(req.body ?? {});
    } catch (err: any) {
      return reply.code(400).send({ error: String(err?.message ?? err) });
    }
  });

  app.get('/api/report', async () => buildClientReportData());

  app.get<{ Querystring: { agency?: string; by?: string; for?: string; notes?: string } }>('/api/report/html', async (req, reply) => {
    const q = req.query ?? {};
    const custom = {
      ...(q.agency ? { agencyName: q.agency } : {}),
      ...(q.by ? { preparedBy: q.by } : {}),
      ...(q.for ? { preparedFor: q.for } : {}),
      ...(q.notes ? { customNotes: q.notes } : {}),
    };
    const data = buildClientReportData(custom);
    const html = renderReportHtml(data);
    return reply.type('text/html; charset=utf-8').send(html);
  });

  app.get<{ Querystring: { agency?: string; by?: string; for?: string; notes?: string } }>('/api/report/markdown', async (req, reply) => {
    const q = req.query ?? {};
    const custom = {
      ...(q.agency ? { agencyName: q.agency } : {}),
      ...(q.by ? { preparedBy: q.by } : {}),
      ...(q.for ? { preparedFor: q.for } : {}),
      ...(q.notes ? { customNotes: q.notes } : {}),
    };
    const data = buildClientReportData(custom);
    const md = renderReportMarkdown(data);
    const filename = `${data.siteName.replace(/[^a-zA-Z0-9_-]/g, '_')}-report.md`;
    return reply
      .header('Content-Disposition', `attachment; filename="${filename}"`)
      .type('text/markdown; charset=utf-8')
      .send(md);
  });
}
