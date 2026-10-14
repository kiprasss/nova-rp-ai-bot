import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { log } from '../util/logger.js';

/** Подробности ответа защиты форума — для логов и разбора с администрацией форума. */
export interface BlockDetails {
  at: string;
  url: string;
  status: number;
  length: number;
  contentType: string | null;
  server: string | null;
  /** Заголовок страницы-заглушки (<title>). */
  title: string | null;
  /** Начало текста страницы без HTML. */
  snippet: string;
  /** Интересные заголовки ответа (без значений cookie). */
  headers: Record<string, string>;
  /** Имена cookie, которые выставила защита (значения не сохраняются). */
  cookieNames: string[];
  userAgent: string;
  savedTo: string | null;
}

let debugDir: string | null = null;

/** Папка для logs/forum-block-latest.html и logs/forum.log (обычно рядом с базой: data/). */
export function setForumDebugDir(dir: string): void {
  debugDir = dir;
}

const INTERESTING = /^(server|content-type|content-length|date|retry-after|location|via|x-|cf-|ddg|react|rl-|www-authenticate)/i;

interface ResponseLike {
  status: number;
  headers: { forEach(cb: (value: string, key: string) => void): void };
}

export function collectBlockDetails(url: string, res: ResponseLike, body: string, userAgent: string): BlockDetails {
  const headers: Record<string, string> = {};
  const cookieNames: string[] = [];
  res.headers.forEach((value, key) => {
    if (key.toLowerCase() === 'set-cookie') {
      for (const part of value.split(/,(?=[^;]+=)/)) {
        const name = part.split('=')[0]?.trim();
        if (name) cookieNames.push(name);
      }
    } else if (INTERESTING.test(key)) {
      headers[key.toLowerCase()] = value.slice(0, 200);
    }
  });
  const title = body.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.replace(/\s+/g, ' ').trim() ?? null;
  const snippet = body
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300);

  let savedTo: string | null = null;
  if (debugDir) {
    try {
      const dir = join(debugDir, 'logs');
      mkdirSync(dir, { recursive: true });
      savedTo = join(dir, 'forum-block-latest.html');
      writeFileSync(savedTo, `<!-- ${new Date().toISOString()} ${url} HTTP ${res.status} -->\n${body}`);
    } catch {
      savedTo = null;
    }
  }

  return {
    at: new Date().toISOString(),
    url,
    status: res.status,
    length: body.length,
    contentType: headers['content-type'] ?? null,
    server: headers.server ?? null,
    title,
    snippet,
    headers,
    cookieNames,
    userAgent,
    savedTo,
  };
}

export function formatBlockDetails(d: BlockDetails): string {
  const headers = Object.entries(d.headers)
    .map(([k, v]) => `    ${k}: ${v}`)
    .join('\n');
  return [
    `Форум не пустил бота (защита от ботов):`,
    `  URL:            ${d.url}`,
    `  HTTP-статус:    ${d.status}${d.status === 401 ? ' (Unauthorized — запрос отклонён без проверки браузера)' : d.status === 403 ? ' (Forbidden)' : d.status === 200 ? ' (страница-заглушка «Проверка браузера»)' : ''}`,
    `  Размер ответа:  ${d.length} байт${d.contentType ? `, ${d.contentType}` : ''}`,
    `  Сервер:         ${d.server ?? '—'}`,
    `  Заголовок:      ${d.title ?? '—'}`,
    `  Текст:          ${d.snippet || '—'}`,
    `  Cookie защиты:  ${d.cookieNames.length ? d.cookieNames.join(', ') : '—'}`,
    `  User-Agent:     ${d.userAgent}`,
    headers ? `  Заголовки ответа:\n${headers}` : '  Заголовки ответа: —',
    d.savedTo ? `  Страница сохранена: ${d.savedTo}` : '',
    `  Что делать: передайте эти данные администрации форума и попросите добавить бота в белый список.`,
  ]
    .filter(Boolean)
    .join('\n');
}

const FULL_LOG_EVERY_MS = 10 * 60_000;
let lastFullAt = 0;
let suppressed = 0;

/** Подробный лог не чаще раза в 10 минут; между ними — короткие строки в debug и счётчик. */
export function logForumBlock(d: BlockDetails): void {
  const now = Date.now();
  if (now - lastFullAt >= FULL_LOG_EVERY_MS) {
    const repeats = suppressed ? `\n  (с прошлого подробного отчёта заблокировано ещё запросов: ${suppressed})` : '';
    log.warn(formatBlockDetails(d) + repeats);
    lastFullAt = now;
    suppressed = 0;
  } else {
    suppressed++;
    log.debug(`Форум: блокировка ${d.status} ${d.url}`);
  }
  if (debugDir) {
    try {
      const dir = join(debugDir, 'logs');
      mkdirSync(dir, { recursive: true });
      appendFileSync(join(dir, 'forum.log'), `${JSON.stringify(d)}\n`);
    } catch {
      // запись журнала необязательна
    }
  }
}
