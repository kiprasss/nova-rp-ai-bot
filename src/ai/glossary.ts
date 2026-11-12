import { GLOBAL_SCOPE, chunkTextsForDoc, docUrlsForScope, rulesLike, type RuleRow } from '../db/repo.js';

/**
 * RP-термины: как их пишут игроки (кириллицей, латиницей, полностью) → аббревиатура и полное
 * название, как в правилах («DeathMatch (DM) — …»).
 */
export const TERMS: {
  abbr: string;
  name: string;
  aliases: string[];
  /** Свой шаблон LIKE, если термин в правилах не в виде «Название (ABBR)». */
  like?: string;
  /** Свой признак в вопросе (вопрос уже в нижнем регистре, ё → е, слова через пробел), если алиасов-слов мало. */
  match?: RegExp;
  /** Строки из той же темы правил (вступление, определения), которые нужны, чтобы понять пункт, — добавляются к нему. */
  context?: RegExp;
  /** Только на вопрос-определение («что такое рп»): слово встречается почти в каждом вопросе. */
  definitionOnly?: boolean;
}[] = [
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
  {
    abbr: 'RP',
    name: 'RolePlay',
    aliases: ['рп', 'rp', 'roleplay', 'role play', 'ролеплей', 'ролплей', 'рол плей'],
    like: '%RolePlay (RP)%',
    definitionOnly: true,
  },
  {
    abbr: 'уход от RP',
    name: 'уход от RP',
    aliases: ['уход от рп', 'уход от rp', 'уходить от рп', 'уходит от рп', 'ушел от рп', 'уход с рп', 'уход от roleplay'],
    like: '%уходить от RP%',
  },
  {
    // «Можно ли стрелять во враждебную семью / у нас война с бандой»: поиск часто находил только 1.9 (опасный район),
    // и бот отвечал «вне гетто нельзя», хотя 2.9 крим. правил разрешает убивать вне гетто при враждебной дипломатии.
    abbr: 'враждебная дипломатия',
    name: 'враждебная дипломатия',
    aliases: [],
    match: /\s(враждебн\p{L}*|враждующ\p{L}*|враждуе\p{L}*|вражеск\p{L}*|враг\p{L}{0,2})\s|\sвойн\p{L}*\s(с|со)\s/u,
    like: '%Во время враждебных дипломатических отношений%',
    // Без этого бот отвечал «про семьи в 2.9 ничего не сказано»: семьи с криминальной веткой подчиняются тем же правилам.
    context: /(Криминальной семьи обязан соблюдать|^Криминальная семья\s*[-—])/iu,
  },
];

const DEFINITION_QUESTION = /что\s+(такое|значит|означает|это)|кто\s+так(ой|ие|ая)|расшифр|определени|значение\s+слова/i;

/** Какие термины упомянуты в вопросе (по целым словам). */
export function detectTerms(question: string): (typeof TERMS)[number][] {
  const q = ` ${question.toLowerCase().replace(/ё/g, 'е').replace(/[^\p{L}\p{N}]+/gu, ' ')} `;
  const isDefinition = DEFINITION_QUESTION.test(q);
  const found = TERMS.filter((t) => (!t.definitionOnly || isDefinition) && (t.match?.test(q) || t.aliases.some((a) => q.includes(` ${a} `))));
  // «Что такое уход от рп / дм в рп» — спрашивают о конкретном термине, общее определение RP не нужно.
  const specific = found.filter((t) => !t.definitionOnly);
  return specific.length ? specific : found;
}

/**
 * Пункты правил с определением термина: «DeathMatch (DM) — …», «NonRP — …».
 * Сначала из источников сервера, если там нет — из всей базы.
 */
export type TermRule = RuleRow & { context?: string };

export function termDefinitions(question: string, scope: string | null, perTerm = 2): TermRule[] {
  const terms = detectTerms(question).slice(0, 3);
  if (!terms.length) return [];
  let allowed: Set<string> | null = null;
  if (scope) {
    allowed = docUrlsForScope(scope);
    if (!allowed.size) allowed = docUrlsForScope(GLOBAL_SCOPE);
  }
  const out: TermRule[] = [];
  for (const t of terms) {
    const candidates = t.like
      ? rulesLike(t.like)
      : [...rulesLike(`%(${t.abbr})%`), ...rulesLike(`${t.name}%`), ...rulesLike(`%${t.name} (%`)];
    const seen = new Set<number>();
    const picked = candidates
      .filter((r) => !r.is_complaint && !seen.has(r.id) && seen.add(r.id))
      .filter((r) => !allowed?.size || allowed.has(r.doc_url))
      // Определение — это пункт, где термин стоит в начале («DeathMatch (DM) — …»).
      .sort((a, b) => Number(startsWithTerm(b, t)) - Number(startsWithTerm(a, t)) || a.point.length - b.point.length)
      .slice(0, perTerm);
    const ctx = t.context;
    out.push(...(ctx ? picked.map((r) => ({ ...r, context: contextLines(r.doc_url, ctx) })) : picked));
  }
  return out;
}

function startsWithTerm(r: RuleRow, t: (typeof TERMS)[number]): boolean {
  const s = r.text.toLowerCase();
  return s.startsWith(t.name.toLowerCase()) || s.startsWith(t.abbr.toLowerCase());
}

/** Строки темы, подходящие под шаблон, без повторов. */
function contextLines(docUrl: string, re: RegExp): string | undefined {
  const lines = new Set<string>();
  for (const text of chunkTextsForDoc(docUrl)) for (const l of text.split('\n')) if (re.test(l.trim())) lines.add(l.trim());
  return lines.size ? [...lines].join('\n') : undefined;
}
