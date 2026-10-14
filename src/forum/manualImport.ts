import * as cheerio from 'cheerio';
import { invalidateSearchIndex } from '../ai/search.js';
import { config } from '../config.js';
import { linkSourceDocs, upsertManualSource } from '../db/repo.js';
import { UserError } from '../util/errors.js';
import { htmlToText, parseThread, type ParsedThread } from './parser.js';
import { storeParsedThread, type StoreResult } from './refresh.js';
import { extractRules } from './rules.js';
import { normalizeForumUrl } from './url.js';

export type ImportFormat = 'text' | 'html' | 'md';

export interface ManualImportInput {
  /** ID сервера (или global). */
  scope: string;
  /** Ссылка на оригинал на форуме — AI показывает её как источник. */
  url: string;
  title?: string | null;
  content: string;
  format?: ImportFormat;
  userId: string;
}

export interface ManualImportResult extends StoreResult {
  /** Распознана сохранённая страница форума XenForo (с сообщениями, полями, крошками). */
  fromSavedPage: boolean;
}

export const IMPORT_EXTENSIONS: Record<string, ImportFormat> = {
  '.txt': 'text',
  '.html': 'html',
  '.htm': 'html',
  '.md': 'md',
};

export function formatFromFileName(name: string): ImportFormat | null {
  const ext = name.toLowerCase().match(/\.[a-z]+$/)?.[0] ?? '';
  return IMPORT_EXTENSIONS[ext] ?? null;
}

/** Ссылка на оригинал: тема форума (канонический вид) или любая http(s)-ссылка. Разделы форума не подходят. */
export function canonicalSourceUrl(raw: string): string {
  const norm = normalizeForumUrl(raw, config.forumBaseUrl);
  if (norm?.kind === 'forum') throw new UserError('Укажите ссылку на тему (/threads/…), а не на раздел форума.');
  if (norm) return norm.url;
  const t = raw.trim();
  if (!/^https?:\/\/\S+$/i.test(t)) throw new UserError('Укажите ссылку на оригинал (например, https://forum.grand-rp.su/threads/406242/).');
  return t;
}

/** Лёгкая очистка Markdown: заголовки, жирный/курсив, код, ссылки → обычный текст. */
export function markdownToText(md: string): string {
  return md
    .replace(/```[a-z]*\n?/gi, '')
    .replace(/^#{1,6}\s*/gm, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/(?<![*\w])\*([^*\n]+)\*(?!\w)/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, '$1 ($2)')
    .replace(/^\s*>\s?/gm, '')
    .trim();
}

/**
 * Ручной импорт знаний (когда форум недоступен боту): текст, .txt/.md или сохранённая страница .html.
 * Сохранённая страница XenForo разбирается так же, как при загрузке с форума.
 */
export function importManual(input: ManualImportInput): ManualImportResult {
  const url = canonicalSourceUrl(input.url);
  const raw = input.content.charCodeAt(0) === 0xfeff ? input.content.slice(1) : input.content; // без BOM
  const format: ImportFormat = input.format ?? (/^\s*</.test(raw) ? 'html' : 'text');

  let saved: ParsedThread | null = null;
  let text = '';
  if (format === 'html') {
    if (/message--post/.test(raw)) {
      const parsed = parseThread(raw, url);
      if (parsed.posts.length) saved = parsed;
    }
    if (!saved) {
      const $ = cheerio.load(raw);
      $('script, style, noscript, nav, header, footer').remove();
      text = htmlToText($, $('body').length ? $('body') : $.root());
    }
  } else {
    text = format === 'md' ? markdownToText(raw) : raw.trim();
  }

  const thread: ParsedThread = saved
    ? { ...saved, title: input.title?.trim() || saved.title }
    : {
        title: input.title?.trim() || text.split('\n').find((l) => l.trim())?.trim().slice(0, 120) || 'Импортированный текст',
        prefix: null,
        breadcrumbs: [],
        fields: [],
        posts: [{ id: 'manual', author: null, url, text }],
        totalPages: 1,
      };

  const totalText = thread.posts.map((p) => p.text).join('\n');
  if (totalText.replace(/\s/g, '').length < 20) throw new UserError('Текст пустой или слишком короткий — нечего импортировать.');

  // Если в тексте много пунктов «N.N …» — это правила, даже если в названии нет слова «правила».
  const ruleCount = thread.posts.reduce((n, p) => n + extractRules(p.text).length, 0);
  const stored = storeParsedThread(url, thread, { forceRules: ruleCount >= 3 });

  const src = upsertManualSource(input.scope, url, stored.title, input.userId);
  linkSourceDocs(src.id, [url]);
  invalidateSearchIndex();
  return { ...stored, fromSavedPage: !!saved };
}
