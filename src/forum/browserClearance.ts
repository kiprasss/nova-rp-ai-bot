import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { log } from '../util/logger.js';

/**
 * Проверка браузера на форуме (L7-защита) проходится только с включённым JavaScript.
 * Открываем страницу в настоящем headless Chromium с тем же честным User-Agent бота,
 * ждём, пока защита пропустит, и забираем cookie — дальше обычные запросы идут с ними.
 * Никакой маскировки: User-Agent не подменяется, частота запросов не меняется.
 */

const CHALLENGE_TITLE = /Проверка браузера|Checking your browser/i;

/** Chromium из `npx playwright install --only-shell chromium`, если путь не задан явно. */
function findHeadlessShell(): string | undefined {
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH || join(homedir(), '.cache', 'ms-playwright');
  try {
    const dirs = readdirSync(root)
      .filter((d) => d.startsWith('chromium_headless_shell-'))
      .sort()
      .reverse();
    for (const d of dirs) {
      const bin = join(root, d, 'chrome-linux', 'headless_shell');
      if (existsSync(bin)) return bin;
    }
  } catch {
    // папки нет — пусть Playwright ищет сам
  }
  return undefined;
}

/** Возвращает заголовок Cookie после прохождения проверки или null, если не получилось. */
export async function obtainClearance(url: string, userAgent: string, executablePath?: string): Promise<string | null> {
  let chromium: typeof import('playwright-core').chromium;
  try {
    ({ chromium } = await import('playwright-core'));
  } catch {
    log.warn('playwright-core не установлен — пройти проверку браузера нельзя (npm i playwright-core).');
    return null;
  }

  let browser: import('playwright-core').Browser | undefined;
  try {
    browser = await chromium.launch({ executablePath: executablePath || findHeadlessShell() });
    const ctx = await browser.newContext({ userAgent, locale: 'ru-RU' });
    const page = await ctx.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    // Ждём снаружи: CSP форума запрещает eval, поэтому waitForFunction со строкой не работает.
    const deadline = Date.now() + 30_000;
    while (CHALLENGE_TITLE.test(await page.title().catch(() => 'Проверка браузера'))) {
      if (Date.now() > deadline) throw new Error('проверка не закончилась за 30 с');
      await page.waitForTimeout(500);
    }
    const cookies = await ctx.cookies(url);
    log.info(`Проверка браузера пройдена, cookie: ${cookies.map((c) => c.name).join(', ') || '—'}`);
    return cookies.map((c) => `${c.name}=${c.value}`).join('; ') || null;
  } catch (err) {
    log.warn(`Не удалось пройти проверку браузера: ${err instanceof Error ? err.message.split('\n')[0] : err}`);
    return null;
  } finally {
    await browser?.close().catch(() => undefined);
  }
}
