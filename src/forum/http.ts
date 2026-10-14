import { log } from '../util/logger.js';

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    url: string,
  ) {
    super(`HTTP ${status} для ${url}`);
  }
}

/** Форум включил защиту от ботов (проверка браузера) — данные получить нельзя, обходить её бот не будет. */
export class ForumBlockedError extends Error {
  constructor() {
    super(
      'Форум включил защиту от ботов (проверка браузера) и не отдаёт страницы. База знаний сохранена, бот продолжит отвечать по ней. ' +
        'Чтобы обновления снова работали, попросите администрацию форума добавить бота в белый список (User-Agent из .env).',
    );
    this.name = 'ForumBlockedError';
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
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Вежливый загрузчик: один запрос за раз, пауза между запросами, повтор при 429/5xx. */
export class PoliteFetcher {
  private queue: Promise<unknown> = Promise.resolve();
  private lastRequestAt = 0;

  constructor(private readonly opts: FetcherOptions) {}

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
        res = await fetch(url, {
          headers: {
            'User-Agent': this.opts.userAgent,
            Accept: 'text/html,application/xhtml+xml',
            'Accept-Language': 'ru-RU,ru;q=0.9',
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
      if (isBotChallenge(res.status, body)) throw new ForumBlockedError();
      if (!res.ok) throw new HttpError(res.status, url);
      return body;
    }
  }
}
