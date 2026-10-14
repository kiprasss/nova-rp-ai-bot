import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { describe, it } from 'node:test';
import { matchFaq } from '../src/ai/faq.js';
import { buildPrompt, citedNumbers } from '../src/ai/prompt.js';
import { PROVIDERS, isReasoningModel, promptStyleFor, rankModels, stripReasoning } from '../src/ai/providers.js';
import { diffRules } from '../src/forum/ruleDiff.js';
import { isDeletableBotMessage, parseMessageRef } from '../src/commands/clean.js';
import { recommendedUserLimit } from '../src/discord/wizard.js';
import { Bm25Index, expandSlang, mergeHits, stem, tokenize } from '../src/ai/search.js';
import { buildComplaint, parseDateTime } from '../src/complaint.js';
import { decryptSecret, deriveKey, encryptSecret, maskSecret } from '../src/crypto.js';
import type { ChunkRow, FaqRow } from '../src/db/repo.js';
import { QuestionRateLimiter, SlidingWindowLimiter } from '../src/util/rateLimit.js';
import { normalizeRulePoint, plural } from '../src/util/text.js';

describe('crypto', () => {
  const key = deriveKey(randomBytes(32).toString('hex'));
  it('шифрует и расшифровывает (AES-256-GCM)', () => {
    const enc = encryptSecret('sk-test-123456789', key);
    assert.ok(enc.startsWith('v1:'));
    assert.ok(!enc.includes('sk-test'));
    assert.equal(decryptSecret(enc, key), 'sk-test-123456789');
  });
  it('обнаруживает подмену и чужой ключ', () => {
    const enc = encryptSecret('secret-value-1', key);
    const parts = enc.split(':');
    parts[3] = Buffer.from('tampered').toString('base64');
    assert.throws(() => decryptSecret(parts.join(':'), key));
    assert.throws(() => decryptSecret(enc, deriveKey(randomBytes(32).toString('hex'))));
  });
  it('маскирует токены', () => {
    assert.equal(maskSecret('sk-proj-abcdefghijklmnopa1b2'), 'sk-...a1b2');
    assert.equal(maskSecret('AIzaSyAbCdEfGhIjKlMnOp9z8y'), 'AIz...9z8y');
    assert.equal(maskSecret('short'), '••••');
  });
  it('требует достаточно длинный ключ', () => {
    assert.throws(() => deriveKey('123'));
    assert.equal(deriveKey('a'.repeat(20)).length, 32);
  });
});

describe('search', () => {
  it('стеммер и токенизация', () => {
    assert.equal(stem('наказания'), stem('наказание'));
    assert.deepEqual(tokenize('Что будет за пункт 5.4?'), ['пункт', '5.4']);
  });

  const chunk = (id: number, title: string, text: string, isRules = 1): ChunkRow => ({
    id,
    doc_url: `https://f/threads/${id}/`,
    idx: 0,
    post_url: `https://f/threads/${id}/#post-${id}`,
    text,
    title,
    is_rules: isRules,
  });

  it('BM25 находит релевантный фрагмент', () => {
    const idx = new Bm25Index();
    idx.build([
      chunk(1, 'Общие правила проекта', '5.4 Запрещено провоцирование сотрудников государственных структур на погони. | JAIL'),
      chunk(2, 'Правила зелёных зон', 'В зелёной зоне запрещено стрелять и наносить урон.'),
      chunk(3, 'Курилка', 'Обсуждаем погоду и музыку', 0),
    ]);
    const hits = idx.search('за что дают jail за провоцирование на погони?', 3);
    assert.equal(hits[0].chunk.id, 1);
    assert.equal(idx.search('зелёная зона стрельба', 3)[0].chunk.id, 2);
    assert.equal(idx.search('квантовая физика', 3).length, 0);
  });

  it('понимает опечатки и сленг', () => {
    assert.ok(tokenize('провоцироват').includes('~провоц'));
    assert.ok(tokenize('провоцирование').includes('~провоц'));
    assert.match(expandSlang('можна ли провоцироват гос сотрудника?'), /государственных структур/);
    assert.match(expandSlang('дм в зз'), /DM убийство/);
    assert.match(expandSlang('дм в зз'), /зелёная зона/);
    assert.equal(expandSlang('просто вопрос'), 'просто вопрос');

    const idx = new Bm25Index();
    idx.build([
      chunk(1, 'Общие правила проекта', '5.4 Запрещено любое намеренное провоцирование сотрудников государственных структур (в том числе и EMS) на погони и задержания. | JAIL от 120 до 180 минут'),
      chunk(2, 'Общие правила проекта', '2.1 Запрещено иметь более 1 дополнительного аккаунта. | BAN'),
      chunk(3, 'Правила зелёных зон', 'В зелёной зоне запрещено наносить урон.'),
    ]);
    assert.equal(idx.search(expandSlang('можна ли провоцироват гос сотрудника?'), 3)[0].chunk.id, 1);
  });

  it('объединяет результаты нескольких поисков', () => {
    const a = chunk(1, 'А', 'x');
    const b = chunk(2, 'Б', 'y');
    const merged = mergeHits(
      [
        [{ chunk: a, score: 2 }],
        [
          { chunk: b, score: 5 },
          { chunk: a, score: 3 },
        ],
      ],
      6,
      1,
    );
    assert.deepEqual(
      merged.map((h) => [h.chunk.id, h.score]),
      [
        [2, 5],
        [1, 3],
      ],
    );
  });

  it('фильтр по области поиска', () => {
    const idx = new Bm25Index();
    idx.build([chunk(1, 'А', 'правила погони'), chunk(2, 'Б', 'правила погони')]);
    const hits = idx.search('погони', 5, (c) => c.id === 2);
    assert.deepEqual(
      hits.map((h) => h.chunk.id),
      [2],
    );
  });
});

describe('prompt', () => {
  const frags = [{ n: 1, title: 'Общие правила', url: 'u', text: '5.4 Запрещено… | JAIL' }];
  it('у каждого стиля промпт на русском с ограничениями', () => {
    for (const style of ['standard', 'claude', 'gemini', 'compact'] as const) {
      const p = buildPrompt(style, 'short', 'что за 5.4?', frags);
      assert.match(p.system, /NOVA RP/, style);
      assert.match(p.system, /русск/i, style);
      assert.match(p.system, /ник/i, style);
      assert.match(p.user, /что за 5\.4\?/, style);
      assert.match(p.user, /JAIL/, style);
    }
  });
  it('Claude получает XML-структуру, открытые модели — напоминание в конце', () => {
    assert.match(buildPrompt('claude', 'short', 'q', frags).user, /<fragment n="1"/);
    assert.match(buildPrompt('compact', 'short', 'q', frags).user, /Ответь на русском/);
    assert.match(buildPrompt('gemini', 'short', 'q', frags).system, /Не используй заголовки/);
    for (const style of ['standard', 'claude', 'gemini', 'compact'] as const) {
      assert.match(buildPrompt(style, 'short', 'q', frags).system, /\*\*Нет\*\*/, `пример Да/Нет: ${style}`);
    }
  });
  it('стиль подбирается по провайдеру и модели', () => {
    assert.equal(promptStyleFor('groq', 'llama-3.3-70b-versatile'), 'compact');
    assert.equal(promptStyleFor('anthropic', 'claude-haiku-5-5'), 'claude');
    assert.equal(promptStyleFor('gemini', 'gemini-2.5-flash'), 'gemini');
    assert.equal(promptStyleFor('openrouter', 'anthropic/claude-sonnet-4'), 'claude');
    assert.equal(promptStyleFor('openrouter', 'meta-llama/llama-3.3-70b-instruct'), 'compact');
    assert.equal(promptStyleFor('openai', 'gpt-4.1-mini'), 'standard');
  });
  it('провайдеры и «думающие» модели', () => {
    for (const p of Object.values(PROVIDERS)) {
      assert.ok(p.models.includes(p.defaultModel), p.id);
      assert.ok(p.models.length <= 24, p.id);
    }
    assert.equal(isReasoningModel('deepseek-reasoner'), true);
    assert.equal(isReasoningModel('openai/gpt-oss-120b'), true);
    assert.equal(isReasoningModel('o4-mini'), true);
    assert.equal(isReasoningModel('gpt-4o-mini'), false);
    assert.equal(isReasoningModel('llama-3.3-70b-versatile'), false);
    assert.equal(stripReasoning('<think>хм</think>\nОтвет [1]'), 'Ответ [1]');
  });
  it('список моделей от провайдера: без не-чат моделей, известные — первыми', () => {
    const ranked = rankModels('groq', [
      'whisper-large-v3',
      'playai-tts',
      'meta-llama/llama-guard-4-12b',
      'qwen/qwen3-32b',
      'llama-3.3-70b-versatile',
      'some-new-model',
    ]);
    assert.deepEqual(ranked, ['llama-3.3-70b-versatile', 'qwen/qwen3-32b', 'some-new-model']);
    assert.ok(!PROVIDERS.groq.models.includes('llama-3.1-8b-instant'));
  });
  it('находит ссылки на фрагменты', () => {
    assert.deepEqual(citedNumbers('Ответ [2] и ещё [1][2].'), [1, 2]);
  });
});

describe('faq', () => {
  const faqs: FaqRow[] = [
    { id: 1, guild_id: 'g', question: 'Как подать жалобу на игрока?', answer: 'Через форум', keywords: null, created_by: null, created_at: 0 },
    { id: 2, guild_id: 'g', question: 'Когда сбор?', answer: 'В 20:00', keywords: 'сбор фракции, во сколько сбор', created_by: null, created_at: 0 },
  ];
  it('совпадение по словам', () => {
    assert.equal(matchFaq('как подать жалобу на игрока', faqs)?.id, 1);
  });
  it('совпадение по ключевой фразе', () => {
    assert.equal(matchFaq('Подскажите, во сколько сбор сегодня?', faqs)?.id, 2);
  });
  it('нет совпадения', () => {
    assert.equal(matchFaq('какой штраф за превышение скорости', faqs), null);
  });
});

describe('complaint', () => {
  const now = Date.UTC(2026, 9, 13, 12, 0); // 13.10.2026 15:00 МСК
  const findRule = (p: string) =>
    p === '5.4' ? { point: '5.4', text: 'Запрещено провоцирование', punishment: 'JAIL от 120 до 180 минут', url: 'https://f/t/1/' } : null;

  it('разбирает дату и время по МСК', () => {
    assert.deepEqual(parseDateTime('13.10.2026 0,05'), { date: '13.10.2026', time: '00:05', utcMs: Date.UTC(2026, 9, 12, 21, 5) });
    assert.equal(parseDateTime('31.02.2026 10:00'), null);
    assert.equal(parseDateTime('вчера'), null);
  });

  it('собирает корректную жалобу', () => {
    const d = buildComplaint(
      { nick: 'John Doe', offenderId: '54321', dateTime: '13.10.2026 00:05', evidence: 'https://youtu.be/abc', rulePoint: 'п. 5.4' },
      findRule,
      now,
    );
    assert.deepEqual(d.errors, []);
    assert.equal(d.title, '5.4 / ID 54321');
    assert.match(d.body, /Время нарушения: 00:05/);
    assert.match(d.body, /Наказание по правилам: JAIL/);
  });

  it('находит ошибки', () => {
    const d = buildComplaint({ nick: 'X', offenderId: 'abc', dateTime: '2026', evidence: 'видео есть', rulePoint: '9.9' }, findRule, now);
    assert.equal(d.errors.length, 5);
  });

  it('предупреждает о сроке и хостинге', () => {
    const d = buildComplaint(
      { nick: 'Ryan_Rice', offenderId: '1', dateTime: '01.10.2026 10:00', evidence: 'https://example.com/v.mp4', rulePoint: '5.4' },
      findRule,
      now,
    );
    assert.equal(d.errors.length, 0);
    assert.ok(d.warnings.some((w) => w.includes('48 часов')));
    assert.ok(d.warnings.some((w) => w.includes('разрешённых ресурсов')));
  });
});

describe('rate limit', () => {
  it('скользящее окно', () => {
    const l = new SlidingWindowLimiter(1000);
    assert.equal(l.check('a', 2, 0).ok, true);
    l.record('a', 0);
    l.record('a', 100);
    const r = l.check('a', 2, 500);
    assert.equal(r.ok, false);
    assert.equal(r.retryAfterMs, 500);
    assert.equal(l.check('a', 2, 1001).ok, true);
    assert.equal(l.check('a', 0, 0).ok, true);
  });
  it('кулдаун, лимит пользователя и сервера', () => {
    const q = new QuestionRateLimiter(5000, 3);
    assert.equal(q.take('g', 'u1', 2, 0).ok, true);
    assert.equal(q.take('g', 'u1', 2, 1000).reason, 'cooldown');
    assert.equal(q.take('g', 'u1', 2, 6000).ok, true);
    assert.equal(q.take('g', 'u1', 2, 12000).reason, 'user');
    assert.equal(q.take('g', 'u2', 0, 12000).ok, true);
    assert.equal(q.take('g', 'u3', 0, 12000).reason, 'guild');
    assert.equal(q.take('dm', 'u3', 1, 12000).ok, true);
  });
});

describe('diffRules', () => {
  const before = [
    { point: '1.1', text: 'Текст один', punishment: null },
    { point: '5.4', text: 'Запрещено провоцирование', punishment: 'JAIL 120 минут' },
    { point: '6.1', text: 'Удаляемый пункт', punishment: 'WARN' },
  ];
  it('находит новые, изменённые и удалённые пункты', () => {
    const d = diffRules(before, [
      { point: '1.1', text: 'Текст  один.', punishment: null }, // только пробелы/точка — не изменение
      { point: '5.4', text: 'Запрещено провоцирование', punishment: 'JAIL 180 минут' },
      { point: '7.1', text: 'Новый пункт', punishment: 'BAN' },
    ]);
    assert.deepEqual(
      d.added.map((r) => r.point),
      ['7.1'],
    );
    assert.deepEqual(
      d.changed.map((c) => [c.point, c.before.punishment, c.after.punishment]),
      [['5.4', 'JAIL 120 минут', 'JAIL 180 минут']],
    );
    assert.deepEqual(
      d.removed.map((r) => r.point),
      ['6.1'],
    );
  });
  it('без изменений — пусто', () => {
    const d = diffRules(before, before);
    assert.equal(d.added.length + d.changed.length + d.removed.length, 0);
  });
});

describe('/clean — что можно удалять', () => {
  const msg = (o: { author?: string; pinned?: boolean; components?: number; title?: string; id?: string }) =>
    ({
      id: o.id ?? 'm1',
      author: { id: o.author ?? 'bot' },
      pinned: o.pinned ?? false,
      components: Array.from({ length: o.components ?? 0 }),
      embeds: o.title ? [{ title: o.title }] : [],
    }) as unknown as Parameters<typeof isDeletableBotMessage>[0];

  it('понимает ID и ссылку на сообщение', () => {
    assert.deepEqual(parseMessageRef('1427912345678901234'), { channelId: null, messageId: '1427912345678901234' });
    assert.deepEqual(parseMessageRef('https://discord.com/channels/1559578821055877245/1559600000000000001/1559600000000000002'), {
      channelId: '1559600000000000001',
      messageId: '1559600000000000002',
    });
    assert.equal(parseMessageRef('https://discord.com/channels/@me/1559600000000000001/1559600000000000002')?.channelId, '1559600000000000001');
    assert.equal(parseMessageRef('привет'), null);
  });

  it('удаляет обычные ответы бота', () => {
    assert.equal(isDeletableBotMessage(msg({}), 'bot', new Set()), true);
  });
  it('не трогает чужие сообщения, меню, закреплённые и служебные', () => {
    assert.equal(isDeletableBotMessage(msg({ author: 'user' }), 'bot', new Set()), false);
    assert.equal(isDeletableBotMessage(msg({ components: 1 }), 'bot', new Set()), false);
    assert.equal(isDeletableBotMessage(msg({ pinned: true }), 'bot', new Set()), false);
    assert.equal(isDeletableBotMessage(msg({ id: 'menu' }), 'bot', new Set(['menu'])), false);
    assert.equal(isDeletableBotMessage(msg({ title: '📜 Обновление правил: Общие' }), 'bot', new Set()), false);
    assert.equal(isDeletableBotMessage(msg({ title: '⚙️ Панель управления NOVA RP AI' }), 'bot', new Set()), false);
  });
});

describe('мастер настройки', () => {
  it('лимит вопросов зависит от размера сервера', () => {
    assert.equal(recommendedUserLimit(3), 20);
    assert.equal(recommendedUserLimit(400), 10);
    assert.equal(recommendedUserLimit(5000), 5);
  });
  it('инструкции сервера добавляются в промпт, но после основных правил', () => {
    const p = buildPrompt('standard', 'short', 'q', [], 'Обращайся на «вы»');
    assert.ok(p.system.indexOf('Обращайся на «вы»') > p.system.indexOf('Строгие правила'));
    assert.match(buildPrompt('claude', 'short', 'q', [], 'X').system, /<server_instructions>\nX\n<\/server_instructions>/);
  });
});

describe('text utils', () => {
  it('нормализует номер пункта', () => {
    assert.equal(normalizeRulePoint('п. 5.4.'), '5.4');
    assert.equal(normalizeRulePoint('5,4'), '5.4');
    assert.equal(normalizeRulePoint('abc'), null);
  });
  it('склоняет числительные', () => {
    assert.equal(plural(1, 'минуту', 'минуты', 'минут'), 'минуту');
    assert.equal(plural(3, 'минуту', 'минуты', 'минут'), 'минуты');
    assert.equal(plural(11, 'минуту', 'минуты', 'минут'), 'минут');
  });
});
