import fs from 'fs';
import path from 'path';
import type { FastifyInstance } from 'fastify';
import { ContactKind, STATUSES, addContact, getContact, listContacts, removeContact, summary, updateContact } from '../outreach/store';
import { discoverCreators, draftCreatorMessage } from '../outreach/creators';
import { discoverLinkPages, draftLinkRequest } from '../outreach/links';
import { emailDailyLimit, emailsSentToday } from '../outreach/email';
import { pipeline } from 'stream/promises';
import { SIZES, SizeId, footage, footagePath, previews, renderPreview, videoDir } from '../video/agent';
import { finishJob, runningJob, startJob, updateJob } from '../jobs';
import { siteEnv } from '../integrations';
import { editDraft, getDraft } from '../queue';
import { ARTICLE_KINDS, imageService, photoCredits, suggestPhoto } from '../social/photos';
import { IMAGE_KINDS, IMAGE_MIME, VIDEO_MIME, addImage, addVideo, imageDir, imageFile, listImages, postVideo, removeImage, removeVideo } from '../social/images';

/** Routes for outreach (creators, link prospects, email) and video previews. Registered from the main route file. */
export function registerOutreachRoutes(app: FastifyInstance): void {
  const bad = (reply: any, err: any, code = 400) => reply.code(code).send({ error: String(err?.message ?? err) });
  const isKind = (k: unknown): k is ContactKind => k === 'creator' || k === 'link';

  app.get<{ Querystring: { kind?: string } }>('/api/outreach', async (req, reply) => {
    const kind = req.query.kind ?? 'creator';
    if (!isKind(kind)) return reply.code(400).send({ error: 'kind must be creator or link' });
    const env = siteEnv();
    return {
      kind,
      contacts: listContacts(kind),
      steps: STATUSES[kind],
      counts: summary(kind),
      email: { connected: !!(env.SMTP_HOST && env.SMTP_USER && env.SMTP_PASSWORD && env.SMTP_FROM), sentToday: emailsSentToday(), dailyLimit: emailDailyLimit(env) },
      youtube: !!env.YOUTUBE_API_KEY,
      running: runningJob(`outreach:${kind}`)?.progress ?? null,
    };
  });

  app.post<{ Body: { kind?: string; name?: string; url?: string; email?: string; platform?: string; why?: string } }>('/api/outreach', async (req, reply) => {
    const b = req.body ?? {};
    if (!isKind(b.kind)) return reply.code(400).send({ error: 'kind must be creator or link' });
    try {
      // An address the owner types counts as checked: they vouch for it.
      const c = addContact({ kind: b.kind, name: b.name ?? '', url: b.url ?? '', email: b.email, emailVerified: !!b.email, emailSource: b.email ? 'typed by you' : '', platform: b.platform, why: b.why ?? 'Added by you.' });
      return c ?? reply.code(409).send({ error: 'already on the list' });
    } catch (err) {
      return bad(reply, err);
    }
  });

  app.put<{ Params: { id: string }; Body: Record<string, unknown> }>('/api/outreach/:id', async (req, reply) => {
    try {
      const b = req.body ?? {};
      return updateContact(Number(req.params.id), {
        status: b.status as string | undefined,
        email: b.email as string | undefined,
        rate: b.rate as string | undefined,
        deliverableUrl: b.deliverableUrl as string | undefined,
        paid: b.paid === undefined ? undefined : !!b.paid,
        notes: b.notes as string | undefined,
      });
    } catch (err) {
      return bad(reply, err);
    }
  });

  app.delete<{ Params: { id: string } }>('/api/outreach/:id', async (req) => (removeContact(Number(req.params.id)), { ok: true }));

  /** Find new creators or link pages in the background. Costs a little AI and search. */
  app.post<{ Body: { kind?: string } }>('/api/outreach/discover', async (req, reply) => {
    const kind = req.body?.kind;
    if (!isKind(kind)) return reply.code(400).send({ error: 'kind must be creator or link' });
    if (runningJob(`outreach:${kind}`)) return reply.code(409).send({ error: 'already looking — wait for it to finish' });
    const jobId = startJob(`outreach:${kind}`, 'Starting');
    const work =
      kind === 'creator'
        ? discoverCreators((m) => updateJob(jobId, m)).then((a) => `added ${a.length} creator(s)`)
        : discoverLinkPages((m) => updateJob(jobId, m)).then((r) => `checked ${r.checked} page(s), ${r.added.length} worth asking`);
    work
      .then((msg) => (updateJob(jobId, msg), finishJob(jobId)))
      .catch((err) => finishJob(jobId, String(err?.message ?? err)));
    return { jobId };
  });

  /** Write the first message for one contact now. It lands in Today for approval. */
  app.post<{ Params: { id: string } }>('/api/outreach/:id/draft', async (req, reply) => {
    const c = getContact(Number(req.params.id));
    if (!c) return reply.code(404).send({ error: 'no such contact' });
    if (c.status === 'declined') return reply.code(400).send({ error: `${c.name} said no — Plume won't write to them again` });
    try {
      const d = c.kind === 'creator' ? await draftCreatorMessage(c) : await draftLinkRequest(c);
      return { draftId: d.id };
    } catch (err) {
      return bad(reply, err);
    }
  });

  // ---- video previews ----
  app.get<{ Params: { id: string } }>('/api/video/:id', async (req, reply) => {
    const d = getDraft(Number(req.params.id));
    if (!d || d.kind !== 'video_script') return reply.code(404).send({ error: 'not a video script' });
    return { previews: previews(d.id), footage: footage(d.id), sizes: Object.fromEntries(Object.entries(SIZES).map(([k, v]) => [k, v.label])), running: runningJob(`video:${d.id}`)?.progress ?? null };
  });

  app.post<{ Params: { id: string }; Body: { sizes?: string[] } }>('/api/video/:id/render', async (req, reply) => {
    const id = Number(req.params.id);
    const d = getDraft(id);
    if (!d || d.kind !== 'video_script') return reply.code(404).send({ error: 'not a video script' });
    if (runningJob(`video:${id}`)) return reply.code(409).send({ error: 'a preview is already being made' });
    const sizes = (req.body?.sizes ?? ['vertical', 'square', 'wide']).filter((s): s is SizeId => s in SIZES);
    if (!sizes.length) return reply.code(400).send({ error: 'pick at least one size' });
    const jobId = startJob(`video:${id}`, 'Drawing the scenes');
    renderPreview(id, sizes)
      .then((files) => (updateJob(jobId, `made ${files.join(', ')}`), finishJob(jobId)))
      .catch((err) => finishJob(jobId, String(err?.message ?? err)));
    return { jobId };
  });

  // The owner's filmed video arrives as the raw request body, so a large file streams straight to disk.
  app.addContentTypeParser(['video/mp4', 'video/quicktime', 'application/octet-stream', 'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/heic'], { bodyLimit: 1024 * 1024 * 1024 }, (_req, payload, done) => done(null, payload));

  app.post<{ Params: { id: string } }>('/api/video/:id/footage', async (req, reply) => {
    const d = getDraft(Number(req.params.id));
    if (!d || d.kind !== 'video_script') return reply.code(404).send({ error: 'not a video script' });
    if (!req.body || typeof (req.body as any).pipe !== 'function') return reply.code(400).send({ error: 'send the video file itself (MP4 or MOV)' });
    fs.mkdirSync(videoDir(d.id), { recursive: true });
    // Written to a side file first, so a broken upload never replaces a good one.
    const part = `${footagePath(d.id)}.part`;
    try {
      await pipeline(req.body as NodeJS.ReadableStream, fs.createWriteStream(part));
      if (!fs.statSync(part).size) throw new Error('the file was empty');
      fs.renameSync(part, footagePath(d.id));
    } catch (err) {
      fs.rmSync(part, { force: true });
      return bad(reply, err);
    }
    return { footage: footage(d.id) };
  });

  app.delete<{ Params: { id: string } }>('/api/video/:id/footage', async (req, reply) => {
    const d = getDraft(Number(req.params.id));
    if (!d || d.kind !== 'video_script') return reply.code(404).send({ error: 'not a video script' });
    fs.rmSync(footagePath(d.id), { force: true });
    return { footage: null };
  });

  // ---- photos on social posts ----
  const postDraft = (id: string) => {
    const d = getDraft(Number(id));
    return d && (IMAGE_KINDS.includes(d.kind) || ARTICLE_KINDS.includes(d.kind)) ? d : null;
  };
  /** Social posts only: articles carry one picture, never a video. */
  const videoDraft = (id: string) => {
    const d = getDraft(Number(id));
    return d && IMAGE_KINDS.includes(d.kind) ? d : null;
  };
  const shown = (draftId: number) => listImages(draftId).map(({ name, type, bytes, at }) => ({ name, type, bytes, at }));
  const shownVideo = (draftId: number) => {
    const v = postVideo(draftId);
    return v ? { name: v.name, type: v.type, bytes: v.bytes, at: v.at } : null;
  };
  const media = (draftId: number) => {
    const d = getDraft(draftId);
    return { images: shown(draftId), video: shownVideo(draftId), credits: photoCredits(draftId), note: (d?.meta.photoNote as string | undefined) ?? null, canMake: !!imageService() };
  };
  const locked = (status: string) => status !== 'draft' && status !== 'failed';
  /** Save an upload to a side file, then let `take` check it and give it its place. */
  const receive = async (req: any, reply: any, draftId: number, take: (part: string) => void) => {
    if (!req.body || typeof req.body.pipe !== 'function') return reply.code(400).send({ error: 'send the file itself' });
    fs.mkdirSync(imageDir(draftId), { recursive: true });
    const part = path.join(imageDir(draftId), `upload-${Date.now()}.part`);
    try {
      await pipeline(req.body as NodeJS.ReadableStream, fs.createWriteStream(part));
      take(part);
    } catch (err) {
      fs.rmSync(part, { force: true });
      return bad(reply, err);
    }
    return media(draftId);
  };

  app.get<{ Params: { id: string } }>('/api/drafts/:id/images', async (req, reply) => {
    const d = postDraft(req.params.id);
    if (!d) return reply.code(404).send({ error: 'this draft cannot have photos' });
    return media(d.id);
  });

  app.post<{ Params: { id: string } }>('/api/drafts/:id/images', async (req, reply) => {
    const d = postDraft(req.params.id);
    if (!d) return reply.code(404).send({ error: 'this draft cannot have photos' });
    if (locked(d.status)) return reply.code(409).send({ error: 'this post is already approved — reopen it to change its photos' });
    return receive(req, reply, d.id, (part) => {
      if (ARTICLE_KINDS.includes(d.kind) && listImages(d.id).length) {
        fs.rmSync(part, { force: true });
        throw new Error('an article has one picture — remove it first to use another');
      }
      addImage(d.id, part);
    });
  });

  /** Let the photo editor find (or make) a picture for this draft. Takes up to a minute. */
  app.post<{ Params: { id: string } }>('/api/drafts/:id/images/suggest', async (req, reply) => {
    const d = postDraft(req.params.id);
    if (!d) return reply.code(404).send({ error: 'this draft cannot have photos' });
    if (locked(d.status)) return reply.code(409).send({ error: 'this post is already approved — reopen it to change its photos' });
    try {
      const r = await suggestPhoto(d.id);
      if (!r.attached) editDraft(d.id, { meta: { photoNote: r.note } });
    } catch (err) {
      return bad(reply, err);
    }
    return media(d.id);
  });

  app.post<{ Params: { id: string } }>('/api/drafts/:id/video', async (req, reply) => {
    const d = videoDraft(req.params.id);
    if (!d) return reply.code(404).send({ error: 'this draft cannot have a video' });
    if (locked(d.status)) return reply.code(409).send({ error: 'this post is already approved — reopen it to change its video' });
    return receive(req, reply, d.id, (part) => addVideo(d.id, part));
  });

  app.delete<{ Params: { id: string } }>('/api/drafts/:id/video', async (req, reply) => {
    const d = videoDraft(req.params.id);
    if (!d) return reply.code(404).send({ error: 'this draft cannot have a video' });
    if (locked(d.status)) return reply.code(409).send({ error: 'this post is already approved — reopen it to change its video' });
    removeVideo(d.id);
    return media(d.id);
  });

  app.get<{ Params: { id: string } }>('/api/drafts/:id/video', async (req, reply) => {
    const id = Number(req.params.id);
    const v = Number.isInteger(id) ? postVideo(id) : null;
    if (!v) return reply.code(404).send({ error: 'no video' });
    return sendRanged(req, reply, v.file, VIDEO_MIME[v.type]);
  });

  app.delete<{ Params: { id: string; name: string } }>('/api/drafts/:id/images/:name', async (req, reply) => {
    const d = postDraft(req.params.id);
    if (!d) return reply.code(404).send({ error: 'this draft cannot have photos' });
    if (locked(d.status)) return reply.code(409).send({ error: 'this post is already approved — reopen it to change its photos' });
    try {
      removeImage(d.id, req.params.name);
    } catch (err) {
      return bad(reply, err, 404);
    }
    return media(d.id);
  });

  app.get<{ Params: { id: string; name: string } }>('/api/drafts/:id/images/:name', async (req, reply) => {
    const id = Number(req.params.id);
    const img = Number.isInteger(id) ? imageFile(id, req.params.name) : null;
    if (!img) return reply.code(404).send({ error: 'no such photo' });
    return reply.type(IMAGE_MIME[img.type]).header('cache-control', 'no-store').send(fs.createReadStream(img.file));
  });

  /** Serve a finished preview or the uploaded video. Only known file names, from that draft's own folder. */
  app.get<{ Params: { id: string; file: string } }>('/api/video/:id/:file', async (req, reply) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || !/^(vertical|square|wide|footage)\.mp4$/.test(req.params.file)) return reply.code(404).send({ error: 'no such file' });
    const file = path.join(videoDir(id), req.params.file);
    if (!fs.existsSync(file)) return reply.code(404).send({ error: 'no such file' });
    return sendRanged(req, reply, file, 'video/mp4');
  });
}

/** Send a video file, answering byte-range requests: Safari only plays video from a server that does. */
function sendRanged(req: any, reply: any, file: string, type: string) {
  const size = fs.statSync(file).size;
  reply.type(type).header('cache-control', 'no-store').header('accept-ranges', 'bytes');
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? ''));
  if (!m || (!m[1] && !m[2])) return reply.header('content-length', size).send(fs.createReadStream(file));
  const start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2]));
  const end = m[1] && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
  if (start > end || start >= size) return reply.code(416).header('content-range', `bytes */${size}`).send();
  return reply
    .code(206)
    .header('content-range', `bytes ${start}-${end}/${size}`)
    .header('content-length', end - start + 1)
    .send(fs.createReadStream(file, { start, end }));
}
