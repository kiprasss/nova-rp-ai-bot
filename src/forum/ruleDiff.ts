export interface RuleLike {
  point: string;
  text: string;
  punishment: string | null;
}

export interface RuleDiff<T extends RuleLike> {
  added: T[];
  removed: RuleLike[];
  changed: { point: string; before: RuleLike; after: T }[];
}

const norm = (s: string | null) => (s ?? '').replace(/\s+/g, ' ').replace(/[.\s]+$/, '').trim().toLowerCase();

/** Сравнивает пункты правил темы до и после обновления (незначимые пробелы и точки в конце не учитываются). */
export function diffRules<T extends RuleLike>(before: RuleLike[], after: T[]): RuleDiff<T> {
  const old = new Map(before.map((r) => [r.point, r]));
  const now = new Map(after.map((r) => [r.point, r]));
  const added: T[] = [];
  const changed: { point: string; before: RuleLike; after: T }[] = [];
  for (const [point, r] of now) {
    const prev = old.get(point);
    if (!prev) added.push(r);
    else if (norm(prev.text) !== norm(r.text) || norm(prev.punishment) !== norm(r.punishment)) {
      changed.push({ point, before: prev, after: r });
    }
  }
  const removed = before.filter((r) => !now.has(r.point));
  return { added, removed, changed };
}
