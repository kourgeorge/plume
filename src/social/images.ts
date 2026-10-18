import fs from 'fs';
import path from 'path';
import { siteDir } from '../site';

/**
 * Photos attached to a social post draft. They live next to the site's other files, one folder per draft,
 * numbered in the order they were added (that is the order they appear in the post).
 */

/** Which drafts can carry photos. Reddit posts and replies stay text. */
export const IMAGE_KINDS = ['social_post', 'x_post', 'x_thread', 'linkedin_post', 'facebook_post'];
/** X takes at most 4 photos per post; the others take more, but 4 keeps one draft fitting everywhere. */
export const MAX_IMAGES = 4;
/** X refuses photos over 5 MB, so that is the limit for all. */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

export type ImageType = 'jpg' | 'png' | 'gif';
export const IMAGE_MIME: Record<ImageType, string> = { jpg: 'image/jpeg', png: 'image/png', gif: 'image/gif' };
const NAME = /^(\d+)\.(jpg|png|gif)$/;

export interface PostImage {
  name: string;
  file: string;
  type: ImageType;
  bytes: number;
  at: string;
}

export function imageDir(draftId: number): string {
  return path.join(siteDir(), 'images', String(draftId));
}

/** What a file really is, from its first bytes — not from its name, which can say anything. */
export function sniffImage(head: Buffer): ImageType | null {
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'jpg';
  if (head.length >= 8 && head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (head.length >= 6 && /^GIF8[79]a$/.test(head.subarray(0, 6).toString('latin1'))) return 'gif';
  return null;
}

export function listImages(draftId: number): PostImage[] {
  const dir = imageDir(draftId);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .map((name) => ({ name, m: NAME.exec(name) }))
    .filter((x): x is { name: string; m: RegExpExecArray } => !!x.m)
    .sort((a, b) => Number(a.m[1]) - Number(b.m[1]))
    .map(({ name, m }) => {
      const file = path.join(dir, name);
      const st = fs.statSync(file);
      return { name, file, type: m[2] as ImageType, bytes: st.size, at: st.mtime.toISOString() };
    });
}

export function imageFile(draftId: number, name: string): PostImage | null {
  return listImages(draftId).find((i) => i.name === name) ?? null;
}

/** Check a just-uploaded file and give it its place in the post. Throws in plain words if it can't be used. */
export function addImage(draftId: number, uploaded: string): PostImage {
  try {
    const size = fs.statSync(uploaded).size;
    if (!size) throw new Error('the file was empty');
    if (size > MAX_IMAGE_BYTES) throw new Error(`the photo is ${(size / 1048576).toFixed(1)} MB; posts take photos up to 5 MB`);
    const head = Buffer.alloc(8);
    const fd = fs.openSync(uploaded, 'r');
    fs.readSync(fd, head, 0, 8, 0);
    fs.closeSync(fd);
    const type = sniffImage(head);
    if (!type) throw new Error('that is not a JPG, PNG or GIF photo');
    const have = listImages(draftId);
    if (have.length >= MAX_IMAGES) throw new Error(`a post can have at most ${MAX_IMAGES} photos — remove one first`);
    const next = have.reduce((n, i) => Math.max(n, Number(NAME.exec(i.name)![1])), 0) + 1;
    const name = `${next}.${type}`;
    fs.renameSync(uploaded, path.join(imageDir(draftId), name));
    return imageFile(draftId, name)!;
  } finally {
    fs.rmSync(uploaded, { force: true });
  }
}

export function removeImage(draftId: number, name: string): void {
  if (!NAME.test(name)) throw new Error('no such photo');
  fs.rmSync(path.join(imageDir(draftId), name), { force: true });
}
