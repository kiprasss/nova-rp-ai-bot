import { GLOBAL_SCOPE, docUrlsForScope, rulesLike, type RuleRow } from '../db/repo.js';

/**
 * RP-термины: как их пишут игроки (кириллицей, латиницей, полностью) → аббревиатура и полное
 * название, как в правилах («DeathMatch (DM) — …»).
 */
export const TERMS: { abbr: string; name: string; aliases: string[] }[] = [
  { abbr: 'DM', name: 'DeathMatch', aliases: ['дм', 'dm', 'дмить', 'дмят', 'дмил', 'deathmatch', 'дезматч'] },
  { abbr: 'DB', name: 'DriveBy', aliases: ['дб', 'db', 'driveby', 'драйвбай', 'драйв бай'] },
  { abbr: 'PG', name: 'PowerGaming', aliases: ['пг', 'pg', 'powergaming', 'павергейминг', 'пауэргейминг'] },
  { abbr: 'MG', name: 'MetaGaming', aliases: ['мг', 'mg', 'metagaming', 'метагейминг'] },
  { abbr: 'SK', name: 'Spawn Kill', aliases: ['ск', 'sk', 'спавн килл', 'спавнкилл', 'spawnkill'] },
  { abbr: 'TK', name: 'Team Kill', aliases: ['тк', 'tk', 'тимкилл', 'тим килл', 'teamkill'] },
  { abbr: 'RK', name: 'Revenge Kill', aliases: ['рк', 'rk', 'ревендж килл', 'revengekill', 'репит килл'] },
  { abbr: 'NLR', name: 'New Life Rule', aliases: ['нлр', 'nlr', 'нью лайф'] },
  { abbr: 'NRD', name: 'NonRP Drive', aliases: ['нрд', 'nrd', 'нонрп драйв', 'нрп драйв'] },
  { abbr: 'NonRP', name: 'NonRP', aliases: ['нрп', 'нонрп', 'нон рп', 'nonrp', 'non rp'] },
  { abbr: 'OOC', name: 'OOC', aliases: ['оос', 'ooc', 'ноос'] },
  { abbr: 'IC', name: 'IC', aliases: ['ic', 'айси'] },
];

/** Какие термины упомянуты в вопросе (по целым словам). */
export function detectTerms(question: string): (typeof TERMS)[number][] {
  const q = ` ${question.toLowerCase().replace(/ё/g, 'е').replace(/[^\p{L}\p{N}]+/gu, ' ')} `;
  return TERMS.filter((t) => t.aliases.some((a) => q.includes(` ${a} `)));
}

/**
 * Пункты правил с определением термина: «DeathMatch (DM) — …», «NonRP — …».
 * Сначала из источников сервера, если там нет — из всей базы.
 */
export function termDefinitions(question: string, scope: string | null, perTerm = 2): RuleRow[] {
  const terms = detectTerms(question).slice(0, 3);
  if (!terms.length) return [];
  let allowed: Set<string> | null = null;
  if (scope) {
    allowed = docUrlsForScope(scope);
    if (!allowed.size) allowed = docUrlsForScope(GLOBAL_SCOPE);
  }
  const out: RuleRow[] = [];
  for (const t of terms) {
    const candidates = [...rulesLike(`%(${t.abbr})%`), ...rulesLike(`${t.name}%`), ...rulesLike(`%${t.name} (%`)];
    const seen = new Set<number>();
    const picked = candidates
      .filter((r) => !r.is_complaint && !seen.has(r.id) && seen.add(r.id))
      .filter((r) => !allowed?.size || allowed.has(r.doc_url))
      // Определение — это пункт, где термин стоит в начале («DeathMatch (DM) — …»).
      .sort((a, b) => Number(startsWithTerm(b, t)) - Number(startsWithTerm(a, t)) || a.point.length - b.point.length)
      .slice(0, perTerm);
    out.push(...picked);
  }
  return out;
}

function startsWithTerm(r: RuleRow, t: (typeof TERMS)[number]): boolean {
  const s = r.text.toLowerCase();
  return s.startsWith(t.name.toLowerCase()) || s.startsWith(t.abbr.toLowerCase());
}
