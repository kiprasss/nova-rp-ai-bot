import * as cheerio from 'cheerio';
import type { AnyNode } from 'domhandler';
import { normalizeForumUrl } from './url.js';

export interface ThreadField {
  label: string;
  value: string;
}

export interface ParsedPost {
  id: string;
  author: string | null;
  url: string;
  text: string;
}

export interface ParsedThread {
  title: string;
  prefix: string | null;
  breadcrumbs: string[];
  fields: ThreadField[];
  posts: ParsedPost[];
  totalPages: number;
}

export interface ThreadListItem {
  url: string;
  title: string;
  author: string | null;
  lastPostTs: number | null;
  sticky: boolean;
}

export interface ParsedForum {
  title: string;
  threads: ThreadListItem[];
  subforums: { url: string; title: string }[];
  totalPages: number;
}

const BLOCK_TAGS = 'p, div, li, ul, ol, h1, h2, h3, h4, h5, h6, tr, table, blockquote, pre, dl, dt, dd';

const INVISIBLE_RE = new RegExp([0x200b, 0x200c, 0x200d, 0xfeff].map((c) => String.fromCharCode(c)).join('|'), 'g');
const NBSP_RE = new RegExp(String.fromCharCode(0xa0), 'g');

function cleanText(text: string): string {
  return text
    .replace(INVISIBLE_RE, '')
    .replace(NBSP_RE, ' ')
    .split('\n')
    .map((l) => l.replace(/[ \t]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Превращает HTML-фрагмент XenForo в читаемый текст с переносами строк. */
export function htmlToText($: cheerio.CheerioAPI, el: cheerio.Cheerio<AnyNode>): string {
  const node = el.clone();
  node.find('script, style, noscript, .bbCodeBlock-expandLink, .bbCodeBlock-title, .js-unfurl-favicon').remove();
  node.find('img').each((_, img) => {
    const alt = $(img).attr('alt');
    $(img).replaceWith(alt && !/^[:;]/.test(alt) ? ` ${alt} ` : ' ');
  });
  node.find('br').replaceWith('\n');
  node.find(BLOCK_TAGS).each((_, b) => {
    $(b).prepend('\n').append('\n');
  });
  return cleanText(node.text());
}

function pageCount($: cheerio.CheerioAPI): number {
  let max = 1;
  $('.pageNav-page a, .pageNav-page').each((_, a) => {
    const n = Number($(a).text().trim());
    if (Number.isFinite(n) && n > max) max = n;
  });
  return max;
}

function titleOf($: cheerio.CheerioAPI): { title: string; prefix: string | null } {
  const h1 = $('h1.p-title-value').first().clone();
  const prefix = h1.find('.label').first().text().trim() || null;
  h1.find('.label, .label-append').remove();
  return { title: cleanText(h1.text()) || cleanText($('title').text()), prefix };
}

export function parseThread(html: string, threadUrl: string): ParsedThread {
  const $ = cheerio.load(html);
  const { title, prefix } = titleOf($);

  const breadcrumbs: string[] = [];
  $('.p-breadcrumbs li a').each((_, a) => {
    const t = cleanText($(a).text());
    if (t && !breadcrumbs.includes(t)) breadcrumbs.push(t);
  });

  const fields: ThreadField[] = [];
  const seen = new Set<string>();
  $('dl.pairs--customField').each((_, dl) => {
    const label = cleanText($(dl).find('dt').first().text());
    const value = htmlToText($, $(dl).find('dd').first());
    const key = `${label}\u0000${value}`;
    if (label && value && !seen.has(key)) {
      seen.add(key);
      fields.push({ label, value });
    }
  });

  const posts: ParsedPost[] = [];
  $('article.message--post').each((_, art) => {
    const a = $(art);
    const content = a.attr('data-content') ?? a.attr('id') ?? '';
    const id = content.match(/post-(\d+)/)?.[1] ?? String(posts.length + 1);
    const body = a.find('.message-body .bbWrapper').first();
    if (!body.length) return;
    posts.push({
      id,
      author: a.attr('data-author') ?? null,
      url: `${threadUrl}#post-${id}`,
      text: htmlToText($, body),
    });
  });

  return { title, prefix, breadcrumbs, fields, posts, totalPages: pageCount($) };
}

export function parseForum(html: string, baseUrl: string): ParsedForum {
  const $ = cheerio.load(html);
  const { title } = titleOf($);

  const threads: ThreadListItem[] = [];
  const seen = new Set<string>();
  $('.structItem--thread').each((_, item) => {
    const it = $(item);
    let link = it.find('.structItem-title a[data-tp-primary]').first();
    if (!link.length) link = it.find('.structItem-title a[href*="/threads/"]').last();
    const norm = normalizeForumUrl(link.attr('href') ?? '', baseUrl);
    if (!norm || norm.kind !== 'thread' || seen.has(norm.url)) return;
    seen.add(norm.url);
    const time = it.find('time.structItem-latestDate').first();
    const tsAttr = time.attr('data-timestamp') ?? time.attr('data-time') ?? '';
    const ts = /^\d+$/.test(tsAttr) ? Number(tsAttr) * 1000 : time.attr('datetime') ? Date.parse(time.attr('datetime')!) : NaN;
    threads.push({
      url: norm.url,
      title: cleanText(link.text()),
      author: it.attr('data-author') ?? null,
      lastPostTs: Number.isFinite(ts) ? ts : null,
      sticky: it.closest('.structItemContainer-group--sticky').length > 0 || it.find('.structItem-status--sticky').length > 0,
    });
  });

  const subforums: { url: string; title: string }[] = [];
  $('.node-title a').each((_, a) => {
    const norm = normalizeForumUrl($(a).attr('href') ?? '', baseUrl);
    if (norm?.kind === 'forum' && !subforums.some((s) => s.url === norm.url)) {
      subforums.push({ url: norm.url, title: cleanText($(a).text()) });
    }
  });

  return { title, threads, subforums, totalPages: pageCount($) };
}
