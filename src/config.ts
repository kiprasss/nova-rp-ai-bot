import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ProviderId } from './ai/providers.js';

/** Корень проекта (config.js лежит в dist/src/). */
export const PROJECT_ROOT = resolve(fileURLToPath(new URL('../../', import.meta.url)));

/**
 * Ищем файл с настройками: .env, а также частые ошибки при загрузке через файловый менеджер
 * хостинга или Windows (.env.txt, env, env.txt). Сначала в рабочей папке, затем в корне проекта.
 */
const ENV_NAMES = ['.env', '.env.txt', 'env', 'env.txt'];
export const loadedEnvFile: string | null = (() => {
  for (const dir of [process.cwd(), PROJECT_ROOT]) {
    for (const name of ENV_NAMES) {
      const p = join(dir, name);
      if (existsSync(p)) {
        process.loadEnvFile(p);
        return p;
      }
    }
  }
  return null;
})();

function str(name: string, fallback = ''): string {
  const v = process.env[name];
  return v === undefined || v.trim() === '' ? fallback : v.trim();
}

function int(name: string, fallback: number): number {
  const n = Number.parseInt(str(name), 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function bool(name: string, fallback: boolean): boolean {
  const v = str(name).toLowerCase();
  if (v === '') return fallback;
  return v === 'true' || v === '1' || v === 'yes';
}

export const config = {
  discordToken: str('DISCORD_TOKEN'),
  clientId: str('DISCORD_CLIENT_ID'),
  devGuildId: str('DEV_GUILD_ID') || null,
  encryptionKey: str('ENCRYPTION_KEY'),
  databasePath: str('DATABASE_PATH', './data/bot.db'),

  forumBaseUrl: str('FORUM_BASE_URL', 'https://forum.nova-rp.com').replace(/\/+$/, ''),
  userAgent: str('SCRAPER_USER_AGENT', 'NovaRP-AI-Bot/1.0 (Discord bot; polite scraper)'),
  scrapeDelayMs: int('SCRAPE_DELAY_MS', 2500),
  scrapeMaxThreadsPerSource: int('SCRAPE_MAX_THREADS_PER_SOURCE', 60),
  scrapeForumPages: Math.max(1, int('SCRAPE_FORUM_PAGES', 2)),
  scrapeMaxPagesPerThread: Math.max(1, int('SCRAPE_MAX_PAGES_PER_THREAD', 3)),
  scrapeCacheMinutes: int('SCRAPE_CACHE_MINUTES', 30),
  defaultRefreshHours: Math.max(1, int('DEFAULT_REFRESH_HOURS', 12)),
  seedGlobalSources: bool('SEED_GLOBAL_SOURCES', true),
  /** Проходить проверку браузера на форуме через headless Chromium (нужен playwright-core и браузер). */
  forumBrowserClearance: bool('FORUM_BROWSER_CLEARANCE', true),
  forumBrowserPath: str('FORUM_BROWSER_PATH') || undefined,

  /** Разделы жалоб, которые бот проверяет на жалобы против привязанных игровых ID. */
  // Сервер Mirage: новые жалобы (899) и проверенные — со статусом (945).
  complaintWatchUrls: str(
    'COMPLAINT_WATCH_URLS',
    ['899', '945'].map((id) => `${str('FORUM_BASE_URL', 'https://forum.nova-rp.com').replace(/\/+$/, '')}/forums/${id}/`).join(','),
  )
    .split(',')
    .map((u) => u.trim())
    .filter(Boolean),
  complaintCheckMinutes: Math.max(3, int('COMPLAINT_CHECK_MINUTES', 10)),
  /** Сколько страниц раздела жалоб просматривать при первом (глубоком) проходе. */
  complaintScanPages: Math.min(10, Math.max(1, int('COMPLAINT_SCAN_PAGES', 3))),

  guildHourlyLimit: int('GUILD_HOURLY_LIMIT', 300),
  defaultUserHourlyLimit: int('DEFAULT_USER_HOURLY_LIMIT', 10),
  dmHourlyLimit: int('DM_HOURLY_LIMIT', 20),
  cooldownSeconds: int('COOLDOWN_SECONDS', 5),

  /** Сервер, чей AI-токен берут все остальные серверы без своего токена (ЛС не затрагивает). */
  sharedAiGuildId: str('SHARED_AI_GUILD_ID') || null,

  fallbackAi: {
    provider: (str('DEFAULT_AI_PROVIDER') || null) as ProviderId | null,
    token: str('DEFAULT_AI_TOKEN') || null,
    model: str('DEFAULT_AI_MODEL') || null,
  },

  logLevel: str('LOG_LEVEL', 'info'),
};

/** Источники, которые добавляются по умолчанию при /setup и в глобальную базу для ЛС. */
export const DEFAULT_SOURCES: string[] = [
  `${config.forumBaseUrl}/forums/893/`, // Правила проекта (все подразделы: общие, госструктуры, криминал, мероприятия…)
  `${config.forumBaseUrl}/threads/403338/`, // Правила подачи жалоб на игроков
  // Сервер Mirage (биографии не берём — это анкеты, а не знания).
  `${config.forumBaseUrl}/forums/899/`, // Жалобы на игроков (+ проверенные)
  `${config.forumBaseUrl}/forums/900/`, // Жалобы на лидеров фракций
  `${config.forumBaseUrl}/forums/898/`, // Жалобы на администраторов и помощников
  `${config.forumBaseUrl}/forums/1357/`, // Обжалование наказаний
  `${config.forumBaseUrl}/forums/1232/`, // Заявления на амнистию
  `${config.forumBaseUrl}/forums/980/`, // Заявления
  `${config.forumBaseUrl}/forums/905/`, // Правительство (суд, прокуратура, адвокатура…)
  `${config.forumBaseUrl}/forums/929/`, // Законодательство
  `${config.forumBaseUrl}/forums/1105/`, // Конгресс
  `${config.forumBaseUrl}/forums/906/`, // Центральная полиция
  `${config.forumBaseUrl}/forums/907/`, // Дорожная полиция
  `${config.forumBaseUrl}/forums/908/`, // Национальная гвардия
  `${config.forumBaseUrl}/forums/909/`, // EMS
  `${config.forumBaseUrl}/forums/911/`, // ФРБ (+ CID)
  `${config.forumBaseUrl}/forums/903/`, // Нелегальные организации (банды)
  `${config.forumBaseUrl}/forums/910/`, // Радиостанция LifeInvader
  `${config.forumBaseUrl}/forums/981/`, // Глобальные мероприятия
];

export const COMPLAINTS_FORUM_URL = `${config.forumBaseUrl}/forums/899/`;

export function assertRuntimeConfig(): void {
  const missing: string[] = [];
  if (!config.discordToken) missing.push('DISCORD_TOKEN');
  if (!config.clientId) missing.push('DISCORD_CLIENT_ID');
  if (!config.encryptionKey) missing.push('ENCRYPTION_KEY');
  if (missing.length) {
    const where = loadedEnvFile
      ? `Файл настроек найден (${loadedEnvFile}), но в нём нет этих значений — проверьте названия и что после «=» есть значение.`
      : `Файл .env не найден в ${process.cwd()}${process.cwd() === PROJECT_ROOT ? '' : ` и ${PROJECT_ROOT}`}. ` +
        'Загрузите .env в корень проекта (рядом с package.json) или задайте переменные в панели хостинга.';
    throw new Error(`Не заданы переменные окружения: ${missing.join(', ')}. ${where}`);
  }
}
