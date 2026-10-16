import { Marked } from 'marked';

/**
 * Markdown → HTML for showing documents and drafts in the dashboard. AI-written text is untrusted:
 * any raw HTML in it is shown as text, and only http(s)/mailto links survive.
 */
const md = new Marked({
  gfm: true,
  breaks: false,
  renderer: {
    html(token: any) {
      return escapeHtml(String(token.text ?? token.raw ?? ''));
    },
    link(token: any) {
      const href = String(token.href ?? '');
      const text = this.parser.parseInline(token.tokens ?? []);
      if (!/^(https?:|mailto:)/i.test(href)) return text;
      return `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${text}</a>`;
    },
    image(token: any) {
      return escapeHtml(`[image: ${token.text ?? ''}]`);
    },
  },
});

export function renderMarkdown(text: string): string {
  return md.parse(text ?? '', { async: false }) as string;
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
