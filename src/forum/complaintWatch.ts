import { config } from '../config.js';
import {
  addComplaintEvent,
  countComplaintThreads,
  getComplaintThread,
  saveComplaintThread,
} from '../db/repo.js';
import { log } from '../util/logger.js';
import { ForumBlockedError } from './http.js';
import { parseForum, parseThread, type ThreadField } from './parser.js';
import { forumFetcher } from './refresh.js';

/** Сколько новых/изменённых тем жалоб скачивать за один проход (вежливость к форуму). */
const MAX_THREADS_PER_RUN = 20;
/** Новые жалобы старше этого не объявляем (например, при первом запуске). */
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

let running = false;

/**
 * Проверяет первую страницу разделов жалоб: новые темы и смену статуса (метки) у известных.
 * При самом первом запуске только запоминает текущие темы — без уведомлений.
 * Возвращает число новых событий.
 */
export async function watchComplaints(): Promise<number> {
  if (running) return 0;
  running = true;
  let events = 0;
  try {
    const baseline = countComplaintThreads() === 0;
    let fetched = 0;
    for (const forumUrl of config.complaintWatchUrls) {
      let listing;
      try {
        listing = parseForum(await forumFetcher.get(forumUrl), config.forumBaseUrl);
      } catch (err) {
        if (err instanceof ForumBlockedError) {
          log.warn(`Жалобы не проверены: ${err.message}`);
          return 0;
        }
        log.warn(`Не удалось проверить жалобы: ${forumUrl}`, err);
        continue;
      }
      for (const t of listing.threads) {
        if (t.sticky) continue; // закреплённые — правила раздела, не жалобы
        const known = getComplaintThread(t.url);
        if (known && known.last_post_ts === t.lastPostTs) continue;
        if (fetched >= MAX_THREADS_PER_RUN) break;
        fetched++;
        let parsed;
        try {
          parsed = parseThread(await forumFetcher.get(t.url), t.url);
        } catch (err) {
          if (err instanceof ForumBlockedError) return events;
          log.warn(`Не удалось открыть жалобу ${t.url}`, err);
          continue;
        }
        const offender = extractOffenderId(parsed.fields, parsed.title);
        saveComplaintThread({ url: t.url, offender_id: offender, title: parsed.title, prefix: parsed.prefix, last_post_ts: t.lastPostTs });
        if (baseline || !offender) continue;
        if (!known) {
          const fresh = t.lastPostTs === null || Date.now() - t.lastPostTs < NEW_COMPLAINT_MAX_AGE;
          if (fresh) {
            addComplaintEvent({ url: t.url, offender_id: offender, title: parsed.title, prefix: parsed.prefix, kind: 'new' });
            events++;
          }
        } else if (parsed.prefix && parsed.prefix !== known.prefix) {
          addComplaintEvent({ url: t.url, offender_id: offender, title: parsed.title, prefix: parsed.prefix, kind: 'status' });
          events++;
        }
      }
    }
    if (baseline) log.info('Жалобы: первый проход — темы запомнены без уведомлений');
    else if (events) log.info(`Жалобы: новых событий ${events}`);
  } finally {
    running = false;
  }
  return events;
}
