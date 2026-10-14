import { allChunks, docUrlsForScope, ruleChunks, type ChunkRow } from '../db/repo.js';

const STOPWORDS = new Set(
  (
    'и в во не что он на я с со как а то все она так его но да ты к у же вы за бы по только ее мне было вот от меня еще нет о из ему ' +
    'теперь когда даже ну вдруг ли если уже или ни быть был него до вас нибудь опять уж вам ведь там потом себя ничего ей может они ' +
    'тут где есть надо ней для мы тебя их чем была сам чтоб без будто чего раз тоже себе под будет ж тогда кто этот того потому ' +
    'этого какой совсем ним здесь этом один почти мой тем чтобы нее сейчас были куда зачем всех никогда можно при наконец два об ' +
    'другой хоть после над больше тот через эти нас про всего них какая много разве три эту моя впрочем хорошо свою этой перед ' +
    'иногда лучше чуть том нельзя такой им более всегда конечно всю между это как-то скажи подскажи пожалуйста привет здравствуйте ' +
    'бот можно ли что-то какие какое каков какова сколько можна мона низя нельзи ваще вообще че чё щас ' +
    'такое такой значит означает обозначает расшифровывается расшифровка это'
  ).split(/\s+/),
);

/**
 * Сленг и сокращения GTA RP → слова, которыми это написано в правилах.
 * Работает без AI, дополняет запрос перед поиском.
 */
const SLANG: [RegExp, string][] = [
  [/(^|[^\p{L}])(гос|госс|госник\p{L}*|гоc)(?=[^\p{L}]|$)/giu, ' государственных структур сотрудников'],
  [/(^|[^\p{L}])(копы?|копов|копам|мусор\p{L}*|пд|lspd|lssd|шериф\p{L}*|полицейск\p{L}*)(?=[^\p{L}]|$)/giu, ' полиция сотрудников государственных структур'],
  [/(^|[^\p{L}])(емс|ems|медик\p{L}*|скорая)(?=[^\p{L}]|$)/giu, ' EMS медиков'],
  // Термины — ровно так, как они названы в правилах («DeathMatch (DM) — …»), без общих слов,
  // иначе поиск находит всё подряд про убийства и урон.
  [/(^|[^\p{L}])(дм|dm|дмить|дмил)(?=[^\p{L}]|$)/giu, ' DM DeathMatch'],
  [/(^|[^\p{L}])(мг|mg)(?=[^\p{L}]|$)/giu, ' MG MetaGaming'],
  [/(^|[^\p{L}])(пг|pg)(?=[^\p{L}]|$)/giu, ' PG Powergaming'],
  [/(^|[^\p{L}])(дб|db)(?=[^\p{L}]|$)/giu, ' DB DriveBy'],
  [/(^|[^\p{L}])(ск|sk)(?=[^\p{L}]|$)/giu, ' SK Spawn Kill'],
  [/(^|[^\p{L}])(тк|tk)(?=[^\p{L}]|$)/giu, ' TK Team Kill'],
  [/(^|[^\p{L}])(рк|rk)(?=[^\p{L}]|$)/giu, ' RK Revenge Kill Repeat Kill'],
  [/(^|[^\p{L}])(нлр|nlr)(?=[^\p{L}]|$)/giu, ' NLR New Life Rule'],
  [/(^|[^\p{L}])(нрп|нонрп|nonrp)(?=[^\p{L}]|$)/giu, ' NonRP'],
  [/(^|[^\p{L}])(оос|ooc)(?=[^\p{L}]|$)/giu, ' OOC'],
  [/(^|[^\p{L}])(зз|зелёнк\p{L}*|зеленк\p{L}*)(?=[^\p{L}]|$)/giu, ' зелёная зона'],
  [/(^|[^\p{L}])(чит\p{L}*|софт\p{L}*)(?=[^\p{L}]|$)/giu, ' стороннее ПО читы'],
  [/(^|[^\p{L}])(варн\p{L}*|warn)(?=[^\p{L}]|$)/giu, ' WARN предупреждение'],
  [/(^|[^\p{L}])(деморган\p{L}*|джайл\p{L}*|jail)(?=[^\p{L}]|$)/giu, ' JAIL'],
  [/(^|[^\p{L}])(бан\p{L}*|ban)(?=[^\p{L}]|$)/giu, ' BAN блокировка'],
  [/(^|[^\p{L}])(акк|акка|акков|акки|твинк\p{L}*)(?=[^\p{L}]|$)/giu, ' аккаунт дополнительного аккаунта'],
  [/(^|[^\p{L}])(тачк\p{L}*|авто|машин\p{L}*|тс)(?=[^\p{L}]|$)/giu, ' транспорт Т/С'],
];

export function expandSlang(text: string): string {
  const extra: string[] = [];
  for (const [re, add] of SLANG) {
    re.lastIndex = 0;
    if (re.test(text)) extra.push(add.trim());
  }
  return extra.length ? `${text} ${extra.join(' ')}` : text;
}

const ENDINGS = [
  'иями', 'ями', 'ами', 'ией', 'иям', 'ием', 'иях', 'ость', 'ости', 'остью', 'ение', 'ения', 'ению', 'ением', 'ении',
  'ание', 'ания', 'анию', 'анием', 'ании', 'ться', 'тся', 'ешь', 'ете', 'ите', 'ишь', 'ает', 'яет', 'ует', 'ют', 'ут',
  'ать', 'ять', 'ить', 'еть', 'ого', 'его', 'ому', 'ему', 'ыми', 'ими', 'ый', 'ий', 'ой', 'ая', 'яя', 'ое', 'ее', 'ые',
  'ие', 'ых', 'их', 'ым', 'им', 'ую', 'юю', 'ов', 'ев', 'ей', 'ам', 'ям', 'ах', 'ях', 'ом', 'ем', 'а', 'я', 'о', 'е',
  'ы', 'и', 'у', 'ю', 'ь', 'й',
].sort((a, b) => b.length - a.length);

/** Очень лёгкий стеммер для русского: срезает типичные окончания у слов длиннее 4 букв. */
export function stem(word: string): string {
  if (!/[а-я]/.test(word) || word.length <= 4) return word;
  for (const end of ENDINGS) {
    if (word.endsWith(end) && word.length - end.length >= 3) return word.slice(0, -end.length);
  }
  return word;
}

const POINT_TOKEN = /^\d{1,2}(?:\.\d{1,2}){1,2}$/;

export function tokenize(text: string): string[] {
  const out: string[] = [];
  const raw = text.toLowerCase().replace(/ё/g, 'е').match(/\d{1,2}(?:\.\d{1,2}){1,2}|[\p{L}\p{N}]+/gu) ?? [];
  for (const t of raw) {
    if (POINT_TOKEN.test(t)) {
      out.push(t);
      continue;
    }
    if (t.length < 2 || STOPWORDS.has(t)) continue;
    out.push(stem(t));
    // Префикс длинных русских слов: «провоцироват» (опечатка) и «провоцирование» совпадут по «~провоц».
    if (t.length >= 7 && /[а-я]/.test(t)) out.push(`${PREFIX}${t.slice(0, 6)}`);
  }
  return out;
}

const PREFIX = '~';

interface IndexedDoc {
  chunk: ChunkRow;
  tf: Map<string, number>;
  len: number;
}

export interface SearchHit {
  chunk: ChunkRow;
  score: number;
}

/** Классический BM25 по фрагментам. */
export class Bm25Index {
  private docs: IndexedDoc[] = [];
  private df = new Map<string, number>();
  private avgLen = 1;

  constructor(
    private readonly k1 = 1.4,
    private readonly b = 0.75,
  ) {}

  build(chunks: ChunkRow[]): void {
    this.docs = [];
    this.df.clear();
    let total = 0;
    for (const chunk of chunks) {
      const tokens = [...tokenize(chunk.title), ...tokenize(chunk.text)];
      const tf = new Map<string, number>();
      for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
      for (const t of tf.keys()) this.df.set(t, (this.df.get(t) ?? 0) + 1);
      this.docs.push({ chunk, tf, len: tokens.length });
      total += tokens.length;
    }
    this.avgLen = this.docs.length ? total / this.docs.length : 1;
  }

  get size(): number {
    return this.docs.length;
  }

  search(query: string, limit: number, filter?: (c: ChunkRow) => boolean): SearchHit[] {
    const terms = [...new Set(tokenize(query))];
    if (!terms.length) return [];
    const n = this.docs.length;
    const hits: SearchHit[] = [];
    for (const d of this.docs) {
      if (filter && !filter(d.chunk)) continue;
      let score = 0;
      let matched = 0;
      for (const t of terms) {
        const f = d.tf.get(t);
        if (!f) continue;
        matched++;
        const df = this.df.get(t) ?? 0;
        const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
        const boost = POINT_TOKEN.test(t) ? 3 : t.startsWith(PREFIX) ? 0.5 : 1;
        score += boost * idf * ((f * (this.k1 + 1)) / (f + this.k1 * (1 - this.b + (this.b * d.len) / this.avgLen)));
      }
      if (!matched) continue;
      // Небольшой бонус за покрытие запроса и за документы с правилами.
      score *= 1 + matched / terms.length;
      if (d.chunk.is_rules) score *= 1.25;
      hits.push({ chunk: d.chunk, score });
    }
    return hits.sort((a, b) => b.score - a.score).slice(0, limit);
  }
}

let index: Bm25Index | null = null;

export function invalidateSearchIndex(): void {
  index = null;
}

function getIndex(): Bm25Index {
  if (!index) {
    index = new Bm25Index();
    index.build([...allChunks(), ...ruleChunks()]);
  }
  return index;
}

/**
 * Поиск по базе знаний. scope — ID сервера (ищем только по его источникам; если источников нет —
 * по глобальной базе) или null для ЛС (ищем по всей базе).
 */
export function searchKnowledge(query: string, scope: string | null, limit = 6, minScore = 1.5, excludeComplaints = false): SearchHit[] {
  let allowed: Set<string> | null = null;
  if (scope) {
    allowed = docUrlsForScope(scope);
    if (!allowed.size) allowed = docUrlsForScope('global');
    if (!allowed.size) allowed = null;
  }
  const hits = getIndex().search(
    expandSlang(query),
    limit * 3,
    (c) => (!allowed || allowed.has(c.doc_url)) && !(excludeComplaints && c.is_complaint === 1),
  );
  return capPerDoc(hits, limit, minScore);
}

/** Объединяет результаты нескольких поисков (по исходному и переписанному вопросу): у фрагмента берётся лучший балл. */
export function mergeHits(lists: SearchHit[][], limit = 6, minScore = 1.5): SearchHit[] {
  const best = new Map<number, SearchHit>();
  for (const list of lists) {
    for (const h of list) {
      const prev = best.get(h.chunk.id);
      if (!prev || prev.score < h.score) best.set(h.chunk.id, h);
    }
  }
  return capPerDoc([...best.values()].sort((a, b) => b.score - a.score), limit, minScore);
}

function capPerDoc(hits: SearchHit[], limit: number, minScore: number): SearchHit[] {
  const out: SearchHit[] = [];
  const perDoc = new Map<string, number>();
  for (const h of hits) {
    if (h.score < minScore) continue;
    const n = perDoc.get(h.chunk.doc_url) ?? 0;
    if (n >= 3) continue; // не более 3 фрагментов из одной темы
    perDoc.set(h.chunk.doc_url, n + 1);
    out.push(h);
    if (out.length >= limit) break;
  }
  return out;
}
