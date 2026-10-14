import { GLOBAL_SCOPE, docUrlsForScope, findRules, type RuleRow } from '../db/repo.js';

function rank(r: RuleRow): number {
  let s = 0;
  if (!r.is_complaint) s += 100;
  if (/общие правила/i.test(r.doc_title)) s += 50;
  if (r.is_rules) s += 20;
  if (r.punishment) s += 10;
  return s + Math.min(r.text.length, 500) / 100;
}

/** Варианты пункта правил, лучший — первым. Сначала ищем в источниках сервера, затем везде. */
export function lookupRule(point: string, scope: string | null): RuleRow[] {
  let rows = findRules(point);
  if (scope && rows.length) {
    let allowed = docUrlsForScope(scope);
    if (!allowed.size) allowed = docUrlsForScope(GLOBAL_SCOPE);
    const scoped = rows.filter((r) => allowed.has(r.doc_url));
    if (scoped.length) rows = scoped;
  }
  const sorted = [...rows].sort((a, b) => rank(b) - rank(a));
  // Убираем дубли одного и того же текста из разных тем (например, жалоб с цитатой пункта).
  const seen = new Set<string>();
  return sorted.filter((r) => {
    const key = `${r.text.slice(0, 80)}|${r.punishment ?? ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
