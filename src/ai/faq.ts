import type { FaqRow } from '../db/repo.js';
import { tokenize } from './search.js';

/**
 * Подбирает FAQ-ответ: совпадение ключевой фразы целиком или достаточно большое
 * пересечение слов вопроса пользователя с вопросом FAQ.
 */
export function matchFaq(question: string, faqs: FaqRow[]): FaqRow | null {
  const q = question.toLowerCase().replace(/ё/g, 'е');
  const qTokens = new Set(tokenize(question));
  let best: { faq: FaqRow; score: number } | null = null;

  for (const faq of faqs) {
    const keywords = (faq.keywords ?? '')
      .split(',')
      .map((k) => k.trim().toLowerCase().replace(/ё/g, 'е'))
      .filter((k) => k.length >= 2);
    if (keywords.some((k) => q.includes(k))) return faq;

    const fTokens = [...new Set(tokenize(faq.question))];
    if (!fTokens.length) continue;
    const common = fTokens.filter((t) => qTokens.has(t)).length;
    const coverage = common / fTokens.length;
    const precision = qTokens.size ? common / qTokens.size : 0;
    const score = (coverage + precision) / 2;
    if (coverage >= 0.6 && precision >= 0.5 && (!best || score > best.score)) best = { faq, score };
  }
  return best?.faq ?? null;
}
