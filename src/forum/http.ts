import { log } from '../util/logger.js';
import { collectBlockDetails, logForumBlock, type BlockDetails } from './blockDiagnostics.js';
import { obtainClearance } from './browserClearance.js';

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    url: string,
  ) {
    super(`HTTP ${status} для ${url}`);
  }
}

/** Форум включил защиту от ботов, и пройти проверку браузера не удалось — данные получить нельзя. */
export class ForumBlockedError extends Error {
  /** Подробности ответа защиты (статус, заголовки, текст страницы). */
  public details: BlockDetails | null = null;

  constructor(details?: BlockDetails) {
    super(
      'Форум включил защиту от ботов (проверка браузера) и не отдаёт страницы. База знаний сохранена, бот продолжит отвечать по ней. ' +
        'Чтобы обновления снова работали, попросите администрацию форума добавить бота в белый список (User-Agent из .env).',
    );
    this.name = 'ForumBlockedError';
    this.details = details ?? null;
  }
}

/** Страница-заглушка антибот-защиты вместо содержимого форума. */
export function isBotChallenge(status: number, body: string): boolean {
  if (status === 401 && body.trim() === '{"ok":false}') return true;
  return body.length < 20_000 && /Checking your browser|Проверка браузера|Automated protection|cf-challenge|ddos-guard/i.test(body);
}

export interface FetcherOptions {
  userAgent: string;
  delayMs: number;
  timeoutMs?: number;
  retries?: number;
  /** Проходить проверку браузера через headless Chromium (честный User-Agent, cookie переиспользуются). */
  browserClearance?: boolean;
  browserPath?: string;
}

/** Не запускать браузер чаще, чем раз в 5 минут, если проверка не проходится. */
const CLEARANCE_RETRY_MS = 5 * 60_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Вежливый загрузчик: один запрос за раз, пауза между запросами, повтор при 429/5xx. */
export class PoliteFetcher {
  private queue: Promise<unknown> = Promise.resolve();
  private lastRequestAt = 0;
  private cookie: string | null = null;
  private lastClearanceAt = 0;

  constructor(private readonly opts: FetcherOptions) {}

  get(url: string): Promise<string> {
    const task = this.queue.then(() => this.doGet(url));
    this.queue = task.catch(() => undefined);
    return task;
  }

  private async doGet(url: string): Promise<string> {
    const retries = this.opts.retries ?? 2;
    let clearanceTried = false;
    for (let attempt = 0; ; attempt++) {
      const wait = this.lastRequestAt + this.opts.delayMs - Date.now();
      if (wait > 0) await sleep(wait);
      this.lastRequestAt = Date.now();
      log.debug(`GET ${url}`);
      let res: Response;
      try {
        res = await fetch(url, {
          headers: {
            'User-Agent': this.opts.userAgent,
            Accept: 'text/html,application/xhtml+xml',
            'Accept-Language': 'ru-RU,ru;q=0.9',
            ...(this.cookie ? { Cookie: this.cookie } : {}),
          },
          redirect: 'follow',
          signal: AbortSignal.timeout(this.opts.timeoutMs ?? 20_000),
        });
      } catch (err) {
        if (attempt < retries) {
          await sleep(this.opts.delayMs * (attempt + 2));
          continue;
        }
        throw err;
      }
      if ((res.status === 429 || res.status >= 500) && attempt < retries) {
        const retryAfter = Number(res.headers.get('retry-after'));
        await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : this.opts.delayMs * (attempt + 2) * 2);
        continue;
      }
      const body = await res.text();
      if (isBotChallenge(res.status, body)) {
        this.cookie = null;
        if (this.opts.browserClearance && !clearanceTried && Date.now() - this.lastClearanceAt >= CLEARANCE_RETRY_MS) {
          clearanceTried = true;
          this.lastClearanceAt = Date.now();
          this.cookie = await obtainClearance(url, this.opts.userAgent, this.opts.browserPath);
          if (this.cookie) {
            this.lastClearanceAt = 0;
            attempt--;
            continue;
          }
        }
        const details = collectBlockDetails(url, res, body, this.opts.userAgent);
        logForumBlock(details);
        throw new ForumBlockedError(details);
      }
      if (!res.ok) throw new HttpError(res.status, url);
      return body;
    }
  }
}
