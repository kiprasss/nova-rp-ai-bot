export type SourceKind = 'thread' | 'forum';

export interface ForumUrl {
  url: string;
  kind: SourceKind;
  id: number;
}

/**
 * Приводит ссылку форума XenForo к каноническому виду.
 * Поддерживает /threads/410706/, /threads/nazvanie.410706/page-2#post-1, /forums/1010/ и т.п.
 */
export function normalizeForumUrl(input: string, baseUrl: string): ForumUrl | null {
  let parsed: URL;
  let base: URL;
  try {
    base = new URL(baseUrl);
    parsed = new URL(input.trim(), base);
  } catch {
    return null;
  }
  const host = parsed.hostname.replace(/^www\./, '');
  // Старые ссылки forum.grand-rp.su (форум переехал, номера тем те же) принимаем как ссылки текущего форума.
  if (host !== base.hostname.replace(/^www\./, '') && host !== 'forum.grand-rp.su') return null;
  const m = parsed.pathname.match(/\/(threads|forums)\/(?:[^/]*?\.)?(\d+)(?:\/|$)/);
  if (!m) return null;
  const kind: SourceKind = m[1] === 'threads' ? 'thread' : 'forum';
  const id = Number(m[2]);
  return { url: `${base.origin}/${m[1]}/${id}/`, kind, id };
}

export function pageUrl(canonicalUrl: string, page: number): string {
  return page > 1 ? `${canonicalUrl}page-${page}` : canonicalUrl;
}
