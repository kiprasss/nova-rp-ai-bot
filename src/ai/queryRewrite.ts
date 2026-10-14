import { log } from '../util/logger.js';
import { complete, type ProviderId } from './providers.js';

const SYSTEM = [
  'Ты помогаешь искать ответ в правилах GTA 5 RolePlay проекта NOVA RP.',
  'Преврати вопрос игрока в поисковый запрос по базе правил:',
  '- исправь опечатки и разговорные формы («можна» → «можно», «провоцироват» → «провоцировать»);',
  '- раскрой сленг и сокращения: гос — государственные структуры/сотрудники, копы/ПД — полиция, ЕМС — EMS медики,',
  '  ДМ — DM убийство без причины, МГ — метагейминг, ПГ — пауэргейминг, ДБ — drive by, СК — spawn kill, ТК — team kill,',
  '  РК — revenge kill, ЗЗ — зелёная зона, НРП — NonRP;',
  '- добавь 3–6 слов и формулировок, которыми это может быть написано в правилах («запрещено …», «наказание», возможные синонимы);',
  '- если в вопросе есть номер пункта (например 5.4) — сохрани его.',
  'Ответь ОДНОЙ строкой на русском: только ключевые слова через пробел, без пояснений, кавычек и списков.',
].join('\n');

const cache = new Map<string, string>();
const CACHE_SIZE = 300;

export interface RewriteCredentials {
  provider: ProviderId;
  token: string;
  model: string;
}

/**
 * «Бот ищет сам»: AI переписывает вопрос в поисковый запрос (опечатки, сленг, синонимы).
 * При любой ошибке возвращает null — тогда поиск идёт только по исходному вопросу.
 */
export async function rewriteQuery(creds: RewriteCredentials, question: string): Promise<string | null> {
  const key = `${creds.provider}:${creds.model}:${question.trim().toLowerCase()}`;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  try {
    const raw = await complete(creds.provider, creds.token, creds.model, {
      system: SYSTEM,
      user: `Вопрос игрока: ${question}`,
      maxTokens: 80,
      temperature: 0,
    });
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
