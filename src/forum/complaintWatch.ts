import { config } from '../config.js';
import {
  addComplaintEvent,
  countComplaintThreads,
  getComplaintThread,
  recentComplaintsFor,
  saveComplaintThread,
} from '../db/repo.js';
import { log } from '../util/logger.js';
import { ForumBlockedError } from './http.js';
import { parseForum, parseThread, type ThreadField, type ThreadListItem } from './parser.js';
import { forumFetcher } from './refresh.js';
import { pageUrl } from './url.js';

/** Сколько новых/изменённых тем жалоб скачивать за один обычный проход (вежливость к форуму). */
const MAX_THREADS_PER_RUN = 20;
/** При первом (глубоком) проходе — больше, чтобы собрать уже существующие жалобы. */
const MAX_THREADS_DEEP = 80;
/** Новые жалобы старше этого не объявляем как «новые». */
const NEW_COMPLAINT_MAX_AGE = 72 * 3600_000;

/**
 * ID нарушителя из полей темы (форма «Жалобы на игроков»: «ID нарушителя»),
 * иначе из заголовка («6.2 ОП / ID 74687», «5.4 ОП I 54321»).
 */
export function extractOffenderId(fields: ThreadField[], title: string): string | null {
  const field =
    fields.find((f) => /\bid\b|айди/i.test(f.label) && /наруш|игрок|подозр|обвин/i.test(f.label)) ??
    fields.find((f) => /^\s*(static\s*)?id\b/i.test(f.label));
  const fromField = field?.value.match(/\d{1,7}/)?.[0];
  if (fromField) return fromField;
  const byLabel = title.match(/(?:\bid\b|айди)\s*[:#№-]?\s*(\d{1,7})/i);
  if (byLabel) return byLabel[1];
  const trailing = title.match(/(?<![\d.])(\d{3,7})\s*$/);
  return trailing?.[1] ?? null;
}

/** Ник из поля «Ник игрока» / «Ник нарушителя». */
export function extractOffenderNick(fields: ThreadField[]): string | null {
  const f = fields.find((x) => /ник/i.test(x.label) && !/ваш/i.test(x.label));
  return f?.value.trim().slice(0, 64) || null;
}

export interface WatchResult {
  events: number;
  scanned: number;
  blocked: boolean;
}

let current: Promise<WatchResult> | null = null;
let lastRunAt = 0;

export function lastComplaintCheckAt(): number {
  return lastRunAt;
}

/**
 * Проверяет разделы жалоб: новые темы и смену статуса у известных.
 * Первый проход (или deep) просматривает несколько страниц и только запоминает жалобы —
 * без уведомлений; уже существующие жалобы на ID показываются при его привязке.
 * Если проверка уже идёт, возвращает её результат, а не запускает вторую.
 */
export function watchComplaints(opts: { deep?: boolean } = {}): Promise<WatchResult> {
  current ??= runWatch(opts).finally(() => {
    current = null;
  });
  return current;
}

async function runWatch(opts: { deep?: boolean }): Promise<WatchResult> {
  const result: WatchResult = { events: 0, scanned: 0, blocked: false };
  try {
    const baseline = countComplaintThreads() === 0;
    const deep = baseline || !!opts.deep;
    const pages = deep ? config.complaintScanPages : 1;
    const limit = deep ? MAX_THREADS_DEEP : MAX_THREADS_PER_RUN;
    let fetched = 0;

    for (const forumUrl of config.complaintWatchUrls) {
      const threads: ThreadListItem[] = [];
      for (let p = 1; p <= pages; p++) {
        try {
          const listing = parseForum(await forumFetcher.get(pageUrl(forumUrl, p), { urgent: true }), config.forumBaseUrl);
          threads.push(...listing.threads);
          if (p >= listing.totalPages) break;
        } catch (err) {
          if (err instanceof ForumBlockedError) {
            log.warn(`Жалобы не проверены: ${err.message}`);
            result.blocked = true;
            return result;
          }
          log.warn(`Не удалось проверить жалобы: ${pageUrl(forumUrl, p)}`, err);
          break;
        }
      }

      for (const t of threads) {
        if (t.sticky) continue; // закреплённые — правила раздела, не жалобы
        const known = getComplaintThread(t.url);
        if (known && known.last_post_ts === t.lastPostTs) continue;
        if (fetched >= limit) break;
        fetched++;
        let parsed;
        try {
          parsed = parseThread(await forumFetcher.get(t.url, { urgent: true }), t.url);
        } catch (err) {
          if (err instanceof ForumBlockedError) {
            result.blocked = true;
            return result;
          }
          log.warn(`Не удалось открыть жалобу ${t.url}`, err);
          continue;
        }
        result.scanned++;
        const offender = extractOffenderId(parsed.fields, parsed.title);
        saveComplaintThread({
          url: t.url,
          offender_id: offender,
          offender_nick: extractOffenderNick(parsed.fields),
          author: parsed.posts[0]?.author ?? t.author,
          title: parsed.title,
          prefix: parsed.prefix,
          last_post_ts: t.lastPostTs,
        });
        if (baseline || !offender) continue;
        if (!known) {
          const fresh = t.lastPostTs === null || Date.now() - t.lastPostTs < NEW_COMPLAINT_MAX_AGE;
          if (fresh || !deep) {
            addComplaintEvent({ url: t.url, offender_id: offender, title: parsed.title, prefix: parsed.prefix, kind: 'new' });
            result.events++;
          }
        } else if (parsed.prefix && parsed.prefix !== known.prefix) {
          addComplaintEvent({ url: t.url, offender_id: offender, title: parsed.title, prefix: parsed.prefix, kind: 'status' });
          result.events++;
        }
      }
    }
    if (baseline) log.info(`Жалобы: первый проход — запомнено тем ${result.scanned}, без уведомлений`);
    else if (result.events) log.info(`Жалобы: новых событий ${result.events}`);
  } finally {
    lastRunAt = Date.now();
  }
  return result;
}

/**
 * Уже существующие жалобы на этот ID (из просмотренных тем) → события «existing»,
 * чтобы владелец сразу увидел их в #ai-жалобы и в ЛС. Возвращает число найденных.
 */
export function queueExistingComplaints(gameId: string, limit = 5): number {
  const found = recentComplaintsFor(gameId, limit);
  for (const c of found) {
    addComplaintEvent({ url: c.url, offender_id: gameId, title: c.title, prefix: c.prefix, kind: 'existing' });
  }
  return found.length;
}
