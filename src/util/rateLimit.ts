/** Скользящее окно в памяти: хранит отметки времени обращений по ключу. */
export class SlidingWindowLimiter {
  private hits = new Map<string, number[]>();

  constructor(private readonly windowMs: number) {}

  private prune(key: string, now: number): number[] {
    const list = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (list.length) this.hits.set(key, list);
    else this.hits.delete(key);
    return list;
  }

  /** Проверяет, можно ли выполнить ещё одно действие. limit <= 0 — без ограничений. */
  check(key: string, limit: number, now = Date.now()): { ok: boolean; retryAfterMs: number } {
    if (limit <= 0) return { ok: true, retryAfterMs: 0 };
    const list = this.prune(key, now);
    if (list.length < limit) return { ok: true, retryAfterMs: 0 };
    return { ok: false, retryAfterMs: this.windowMs - (now - list[0]) };
  }

  record(key: string, now = Date.now()): void {
    const list = this.prune(key, now);
    list.push(now);
    this.hits.set(key, list);
  }

  count(key: string, now = Date.now()): number {
    return this.prune(key, now).length;
  }
}

export interface RateDecision {
  ok: boolean;
  reason?: 'cooldown' | 'user' | 'guild';
  retryAfterMs: number;
}

const HOUR = 60 * 60 * 1000;

/** Лимиты: кулдаун между вопросами, лимит пользователя в час и лимит сервера в час. */
export class QuestionRateLimiter {
  private readonly hourly = new SlidingWindowLimiter(HOUR);
  private readonly lastAsk = new Map<string, number>();

  constructor(
    private readonly cooldownMs: number,
    private readonly guildHourlyLimit: number,
  ) {}

  take(scope: string, userId: string, userHourlyLimit: number, now = Date.now()): RateDecision {
    const userKey = `${scope}:${userId}`;
    const last = this.lastAsk.get(userKey);
    if (this.cooldownMs > 0 && last !== undefined && now - last < this.cooldownMs) {
      return { ok: false, reason: 'cooldown', retryAfterMs: this.cooldownMs - (now - last) };
    }
    const u = this.hourly.check(`u:${userKey}`, userHourlyLimit, now);
    if (!u.ok) return { ok: false, reason: 'user', retryAfterMs: u.retryAfterMs };
    if (scope !== 'dm') {
      const g = this.hourly.check(`g:${scope}`, this.guildHourlyLimit, now);
      if (!g.ok) return { ok: false, reason: 'guild', retryAfterMs: g.retryAfterMs };
      this.hourly.record(`g:${scope}`, now);
    }
    this.hourly.record(`u:${userKey}`, now);
    this.lastAsk.set(userKey, now);
    return { ok: true, retryAfterMs: 0 };
  }
}
