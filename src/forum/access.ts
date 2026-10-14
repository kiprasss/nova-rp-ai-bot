import { getMeta, setMeta } from '../db/repo.js';

/**
 * Общее состояние доступа к форуму. Если форум закрыт (защита от ботов, 403/429/503),
 * бот НЕ обходит защиту, а реже повторяет попытки: 15 мин → 30 мин → 1 ч → … → максимум 6 ч.
 * Как только форум откроет доступ (например, добавит бота в белый список), всё возвращается в норму само.
 */
export interface ForumAccessState {
  blocked: boolean;
  failures: number;
  blockedSince: number | null;
  nextTryAt: number;
  lastOkAt: number | null;
  reason: string | null;
}

const KEY = 'forum_access';
const BASE_MS = 15 * 60_000;
const MAX_MS = 6 * 3600_000;

const DEFAULT: ForumAccessState = { blocked: false, failures: 0, blockedSince: null, nextTryAt: 0, lastOkAt: null, reason: null };

/** Пауза перед следующей попыткой после n-й неудачи подряд. */
export function backoffMs(failures: number): number {
  if (failures <= 0) return 0;
  return Math.min(BASE_MS * 2 ** (failures - 1), MAX_MS);
}

export function getForumAccess(): ForumAccessState {
  try {
    const raw = getMeta(KEY);
    return raw ? { ...DEFAULT, ...(JSON.parse(raw) as Partial<ForumAccessState>) } : { ...DEFAULT };
  } catch {
    return { ...DEFAULT };
  }
}

/** Можно ли сейчас обращаться к форуму. force — ручное «Обновить базу знаний» (одна попытка вне очереди). */
export function canTryForum(force = false, now = Date.now()): boolean {
  const s = getForumAccess();
  return !s.blocked || force || now >= s.nextTryAt;
}

export function markForumBlocked(reason: string, now = Date.now()): ForumAccessState {
  const prev = getForumAccess();
  const failures = prev.failures + 1;
  const next: ForumAccessState = {
    blocked: true,
    failures,
    blockedSince: prev.blockedSince ?? now,
    nextTryAt: now + backoffMs(failures),
    lastOkAt: prev.lastOkAt,
    reason,
  };
  setMeta(KEY, JSON.stringify(next));
  return next;
}

export function markForumOk(now = Date.now()): void {
  const prev = getForumAccess();
  if (!prev.blocked && prev.lastOkAt && now - prev.lastOkAt < 60_000) return; // не пишем в БД на каждый запрос
  setMeta(KEY, JSON.stringify({ ...DEFAULT, lastOkAt: now }));
}

/** «Доступ ограничен с 14.10 13:15, следующая попытка через 2 ч». */
export function describeForumAccess(s = getForumAccess(), now = Date.now()): string {
  if (!s.blocked) return s.lastOkAt ? `✅ Доступен (последний успешный запрос <t:${Math.floor(s.lastOkAt / 1000)}:R>)` : '✅ Доступен';
  const since = s.blockedSince ? `<t:${Math.floor(s.blockedSince / 1000)}:f>` : '—';
  const next = s.nextTryAt > now ? `<t:${Math.floor(s.nextTryAt / 1000)}:R>` : 'при следующей проверке';
  return `⛔ Доступ ограничен с ${since} (${s.reason ?? 'защита форума'}). Попыток подряд: ${s.failures}, следующая — ${next}.`;
}
