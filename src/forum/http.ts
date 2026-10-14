import { fetch as httpFetch, ProxyAgent } from 'undici';
import { log } from '../util/logger.js';
import { markForumBlocked, markForumOk } from './access.js';
import { collectBlockDetails, logForumBlock, type BlockDetails } from './blockDiagnostics.js';

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    url: string,
  ) {
    super(`HTTP ${status} для ${url}`);
  }
}

/** Форум не пускает бота (защита от ботов, 403/429/503) — данные получить нельзя, обходить защиту бот не будет. */
export class ForumBlockedError extends Error {
  /** Подробности ответа защиты (статус, заголовки, текст страницы). */
  public details: BlockDetails | null = null;

  constructor(
    details?: BlockDetails,
    public readonly reason: string = 'защита от ботов',
  ) {
    super(
      `Форум ограничил доступ боту (${reason}). База знаний сохранена, бот продолжит отвечать по ней и по импортированным данным. ` +
        'Повторные попытки — реже (до раза в 6 часов). Чтобы обновления снова работали, форум должен добавить бота в белый список.',
    );
    this.name = 'ForumBlockedError';
    this.details = details ?? null;
  }
}

/**
 * Причина блокировки или null, если ответ похож на обычную страницу форума:
 * страница проверки браузера/captcha, пустой 401, а также 403, 429 и 503.
 */
export function classifyBlock(status: number, body: string): string | null {
  if (status === 401 && body.trim() === '{"ok":false}') return 'HTTP 401, запрос отклонён защитой';
  if (body.length < 20_000 && /Checking your browser|Проверка браузера|Automated protection|cf-challenge|ddos-guard|Just a moment|captcha/i.test(body)) {
    return status === 200 ? 'страница «Проверка браузера» вместо форума' : `HTTP ${status}, страница проверки/captcha`;
  }
  if (status === 403) return 'HTTP 403 Forbidden';
  if (status === 429) return 'HTTP 429 Too Many Requests';
  if (status === 503) return 'HTTP 503 Service Unavailable';
  return null;
}

/** Совместимость: true, если ответ — блокировка. */
export function isBotChallenge(status: number, body: string): boolean {
  return classifyBlock(status, body) !== null;
}

/** «X-Bot-Key: abc» → ['X-Bot-Key', 'abc'] (ключ/заголовок, выданный администрацией форума для белого списка). */
export function parseExtraHeader(raw: string | null | undefined): [string, string] | null {
  const m = raw?.match(/^\s*([A-Za-z0-9-]+)\s*:\s*(.+?)\s*$/);
  return m ? [m[1], m[2]] : null;
}

export interface FetcherOptions {
  userAgent: string;
  delayMs: number;
  timeoutMs?: number;
  retries?: number;
  /** Прокси с IP, который администрация форума добавила в белый список. */
  proxyUrl?: string | null;
  /** Дополнительный заголовок для белого списка, например «X-Bot-Key: …». */
  extraHeader?: string | null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Вежливый загрузчик: один запрос за раз, пауза между запросами, повтор при 429/5xx. */
export class PoliteFetcher {
  private queue: Promise<unknown> = Promise.resolve();
  private lastRequestAt = 0;
  private readonly dispatcher?: ProxyAgent;
  private readonly headers: Record<string, string>;

  constructor(private readonly opts: FetcherOptions) {
    this.dispatcher = opts.proxyUrl ? new ProxyAgent(opts.proxyUrl) : undefined;
    this.headers = {
      'User-Agent': opts.userAgent,
      Accept: 'text/html,application/xhtml+xml',
      'Accept-Language': 'ru-RU,ru;q=0.9',
    };
    const extra = parseExtraHeader(opts.extraHeader);
    if (extra) this.headers[extra[0]] = extra[1];
  }

  get(url: string): Promise<string> {
    const task = this.queue.then(() => this.doGet(url));
    this.queue = task.catch(() => undefined);
    return task;
  }

  private async doGet(url: string): Promise<string> {
    const retries = this.opts.retries ?? 2;
    for (let attempt = 0; ; attempt++) {
      const wait = this.lastRequestAt + this.opts.delayMs - Date.now();
      if (wait > 0) await sleep(wait);
      this.lastRequestAt = Date.now();
      log.debug(`GET ${url}`);
      let res: Response;
      try {
        res = await httpFetch(url, {
          headers: this.headers,
          redirect: 'follow',
          signal: AbortSignal.timeout(this.opts.timeoutMs ?? 20_000),
          dispatcher: this.dispatcher,
        });
      } catch (err) {
        if (attempt < retries) {
          await sleep(this.opts.delayMs * (attempt + 2));
          continue;
        }
        throw err;
      }
      // 500/502/504 — повторяем; 429/503 могут быть ограничением доступа — один повтор, потом считаем блокировкой.
      const retryable = res.status >= 500 && res.status !== 503 ? attempt < retries : (res.status === 429 || res.status === 503) && attempt < 1;
      if (retryable) {
        const retryAfter = Number(res.headers.get('retry-after'));
        await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter, 120) * 1000 : this.opts.delayMs * (attempt + 2) * 2);
        continue;
      }
      const body = await res.text();
      const reason = classifyBlock(res.status, body);
      if (reason) {
        const details = collectBlockDetails(url, res, body, this.opts.userAgent);
        logForumBlock(details);
        markForumBlocked(reason);
        throw new ForumBlockedError(details, reason);
      }
      if (!res.ok) throw new HttpError(res.status, url);
      markForumOk();
      return body;
    }
  }
}
