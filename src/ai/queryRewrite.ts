import { log } from '../util/logger.js';
import { AiError, complete, type ChatRequest, type ProviderId } from './providers.js';

const SYSTEM = [
  'Ты помогаешь искать ответ в правилах GTA 5 RolePlay проекта NOVA RP.',
  'Преврати вопрос игрока в поисковый запрос по базе правил:',
  '- исправь опечатки и разговорные формы («можна» → «можно», «провоцироват» → «провоцировать»);',
  '- раскрой сленг и сокращения: гос — государственные структуры/сотрудники, копы/ПД — полиция, ЕМС — EMS медики,',
  '  ДМ — DM убийство без причины, МГ — метагейминг, ПГ — пауэргейминг, ДБ — drive by, СК — spawn kill, ТК — team kill,',
  '  РК — revenge kill, ЗЗ — зелёная зона, НРП — NonRP, броник — бронежилет;',
  '- добавь 3–6 синонимов и формулировок, которыми это может быть написано на форуме, — по смыслу вопроса:',
  '  «можно ли / накажут ли» → «запрещено …», «наказание»; «что такое X» → определение и синонимы X (RP → RolePlay ролевая игра отыгровка);',
  '  «как сделать / подать / стать» → названия процедуры, раздела, формы. Не добавляй общие слова, не связанные с вопросом;',
  '- если в вопросе есть номер пункта (например 5.4) — сохрани его.',
  'Ответь ОДНОЙ строкой на русском: только ключевые слова через пробел, без пояснений, кавычек и списков.',
].join('\n');

/** Целое слово (\b в JS не работает с кириллицей). */
const word = (w: string) => new RegExp(`(?<![\\p{L}\\p{N}])(?:${w})(?![\\p{L}\\p{N}])`, 'iu');
const GOV = /(лспд|lspd|сапд|sahp|фиб|fib|фбр|ems|емс|гос|коп|мент|полиц|шериф|служебн|армейск|арми|военн|федерал)/i;

const isGov = (q: string) => GOV.test(q) || word('пд|pd|нг|ng').test(q);
const VEST = /брон(ик|ежилет|ь|[яюеи](?!\p{L})|ей(?!\p{L}))/iu;

/**
 * Сленг, который AI-переписывание раскрывает не всегда: добавляем формулировку из правил напрямую.
 * Срабатывает, только если в вопросе есть оба признака.
 */
const SLANG_EXPANSIONS: { all: ((q: string) => boolean)[]; add: string }[] = [
  {
    // «броники ЛСПД», «госовский броник», «броник пд» → Общие правила 7.7, АК 5.7, Закон об обороте оружия 1.8.3
    all: [(q) => VEST.test(q), isGov],
    add: 'бронежилет государственного образца предметы фракций хранение ношение продажа служебный бронежилет спецсредство',
  },
  {
    // «маска медика», «балаклава гос» → Общие правила 7.7 (медицинские маски и балаклавы со складов госструктур)
    all: [(q) => /(маск|балаклав)/i.test(q), (q) => isGov(q) || /мед/i.test(q)],
    add: 'медицинские маски балаклавы государственного образца предметы фракций хранение ношение продажа',
  },
  {
    // «грабить одному / в одиночку» → Правила похищений и ограблений 1.5 (грабителей вдвое больше, чем жертв)
    all: [(q) => /(граб|ограб|похищ|похит)/i.test(q), (q) => word('одному|одной|один|одна|в одиночку|соло|вдвоем|вдвоём|вдвоем|сколько человек|количество').test(q)],
    add: 'количество грабителей похитителей вдвое больше чем жертв минимальное количество',
  },
];

export function expandSlang(question: string): string | null {
  const add = SLANG_EXPANSIONS.filter((e) => e.all.every((t) => t(question))).map((e) => e.add);
  return add.length ? add.join(' ') : null;
}

const cache = new Map<string, string>();
const CACHE_SIZE = 300;

export interface RewriteCredentials {
  provider: ProviderId;
  token: string;
  model: string;
}

/**
 * «Бот ищет сам»: AI переписывает вопрос в поисковый запрос (опечатки, сленг, синонимы).
 * Если основная модель упёрлась в лимит или недоступна — пробуем резервную, как и для ответа.
 * При любой другой ошибке возвращает null — тогда поиск идёт только по исходному вопросу.
 */
export async function rewriteQuery(creds: RewriteCredentials, question: string, fallbackModel?: string | null): Promise<string | null> {
  const key = `${creds.provider}:${creds.model}:${question.trim().toLowerCase()}`;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  // Запас для «думающих» моделей (gpt-oss, qwen3): их рассуждения тоже тратят лимит, и при 80 токенах ответ иногда пустой.
  const req: ChatRequest = { system: SYSTEM, user: `Вопрос игрока: ${question}`, maxTokens: 160, temperature: 0 };
  try {
    let raw: string;
    try {
      raw = await complete(creds.provider, creds.token, creds.model, req);
    } catch (err) {
      const retryable = err instanceof AiError && (err.status === 0 || err.status === 404 || err.status === 429 || err.status >= 500);
      if (!retryable || !fallbackModel || fallbackModel === creds.model) throw err;
      raw = await complete(creds.provider, creds.token, fallbackModel, req);
    }
    const line = raw
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l.length > 0)
      ?.replace(/^(поисковый запрос|запрос|ключевые слова)\s*:\s*/i, '')
      .replace(/["«»*`]/g, '')
      .slice(0, 300);
    if (!line) return null;
    if (cache.size >= CACHE_SIZE) cache.delete(cache.keys().next().value!);
    cache.set(key, line);
    return line;
  } catch (err) {
    log.debug('Не удалось переписать запрос, ищем по исходному вопросу', err);
    return null;
  }
}
