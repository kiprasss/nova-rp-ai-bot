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
  [/(^|[^\p{L}])(бодик\p{L}*|бодикам\p{L}*|bodycam\p{L}*|бодикамер\p{L}*)(?=[^\p{L}]|$)/giu, ' BodyCam'],
  // «Фама» — семья (family); не «фамилия».
  [/(^|[^\p{L}])(фам|фама|фамы|фаме|фаму|фамой|фамка\p{L}*|фамк\p{L}*)(?=[^\p{L}]|$)/giu, ' семья семьи'],
  // «Грабить» и «ограбление» стеммер не сводит к одной основе.
  [/(^|[^\p{L}])(граб\p{L}*|ограб\p{L}*|грабёж\p{L}*|грабеж\p{L}*)(?=[^\p{L}]|$)/giu, ' ограбление ограбления'],
  // «Как стать лидером» — заявление на пост лидера и требования к нему.
  [/(стать|стану|становятся|становиться|попасть\s+на|получить)\s+(на\s+)?(лидер\p{L}*|лидерк\p{L}*|пост\s+лидер\p{L}*)/giu, ' заявление на пост лидера требования'],
  // В правилах «использовать оружие», «открывать огонь», а не «стрелять».
  [/(^|[^\p{L}])(стрел\p{L}*|пострел\p{L}*|шмал\p{L}*|пальб\p{L}*)(?=[^\p{L}]|$)/giu, ' оружие огонь'],
  [/(^|[^\p{L}])(чит\p{L}*|софт\p{L}*)(?=[^\p{L}]|$)/giu, ' стороннее постороннего ПО читы'],
  [/(^|[^\p{L}])(варн\p{L}*|warn)(?=[^\p{L}]|$)/giu, ' WARN предупреждение'],
  [/(^|[^\p{L}])(деморган\p{L}*|джайл\p{L}*|jail)(?=[^\p{L}]|$)/giu, ' JAIL'],
  // Не «банк», «банкомат», «банда»: только сам бан и глаголы от него.
  [/(^|[^\p{L}])(бан|бана|баны|бану|баном|банов|банить|банят|банил\p{L}*|ban)(?=[^\p{L}]|$)/giu, ' BAN блокировка'],
  // «Меня забанили» — обычно ищут, как снять бан.
  [/(^|[^\p{L}])(забан\p{L}*|разбан\p{L}*)(?=[^\p{L}]|$)/giu, ' BAN блокировка обжалование амнистия'],
  // В правилах «RP» латиницей: «уход от RP», «NonRP».
  [/(^|[^\p{L}])(рп|рпшн\p{L}*)(?=[^\p{L}]|$)/giu, ' RP RolePlay'],
  [/(сколько\s+стоит|сколько\s+стоят|цен[аыу]|прайс\p{L}*)/giu, ' стоимость цена прайс'],
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
  // «вступление» ↔ «вступить», «оформление/оформлять» ↔ «оформить»: иначе основы расходятся на «л».
  'ления', 'лению', 'лением', 'лении', 'ление', 'лять', 'ляет', 'лить',
  'иями', 'ями', 'ами', 'ией', 'иям', 'ием', 'иях', 'ость', 'ости', 'остью', 'ение', 'ения', 'ению', 'ением', 'ении',
  'ание', 'ания', 'анию', 'анием', 'ании', 'ться', 'тся', 'ешь', 'ете', 'ите', 'ишь', 'ает', 'яет', 'ует', 'ют', 'ут',
  'ать', 'ять', 'ить', 'еть', 'ого', 'его', 'ому', 'ему', 'ыми', 'ими', 'ый', 'ий', 'ой', 'ая', 'яя', 'ое', 'ее', 'ые',
  'ие', 'ых', 'их', 'ым', 'им', 'ую', 'юю', 'ов', 'ев', 'ей', 'ам', 'ям', 'ах', 'ях', 'ом', 'ем', 'а', 'я', 'о', 'е',
  'ы', 'и', 'у', 'ю', 'ь', 'й',
].sort((a, b) => b.length - a.length);

/** Очень лёгкий стеммер для русского: срезает типичные окончания (у слов из 4 букв — только одну гласную). */
export function stem(word: string): string {
  if (!/[а-я]/.test(word) || word.length <= 3) return word;
  // Короткие слова — только однобуквенное окончание: «зона/зоне/зону» → «зон».
  if (word.length === 4) return /[аяоеыиуюьй]$/.test(word) ? word.slice(0, -1) : word;
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
    const s = stem(t);
    out.push(s);
    // Префикс основы длинных русских слов: «провоцироват» (опечатка) и «провоцирование» совпадут по «~провоц».
    // От основы, а не от слова: у «вступить» и «вступление» основа одна, а первые 6 букв — разные.
    if (s.length > 6 && /[а-я]/.test(s)) out.push(`${PREFIX}${s.slice(0, 6)}`);
  }
  return out;
}

const PREFIX = '~';

/** Насколько поднимать фрагмент, если слова запроса есть в заголовке его темы (до ×1.8 при полном совпадении). */
const TITLE_WEIGHT = 0.8;

const GENERAL_RULES = /^Общие правила проекта/i;
const EVENT_RULES = /^(Правила\s+)?(мероприяти|событи|ГМП)/iu;
/** Слова заголовка ивента, которые его не выделяют («правила мероприятия Ограбление…» — общее, «банкомата» — нет). */
const EVENT_GENERIC = new Set(tokenizeTitleGeneric('правила правил мероприятие мероприятия мероприятий событие события ограбление ограбления ограблений и'));

function tokenizeTitleGeneric(text: string): string[] {
  return tokenize(text);
}

/** Вопрос называет этот ивент — есть отличительное слово его заголовка. */
function eventNamed(titleTerms: Set<string>, query: Set<string>): boolean {
  for (const t of titleTerms) if (!EVENT_GENERIC.has(t) && query.has(t)) return true;
  return false;
}

const COMPLAINT_RULES = /правил|форм[аыу] подачи|регламент/i;

/** Фрагмент — правила: сами правила или регламент раздела жалоб. */
export function isRulesChunk(c: ChunkRow): boolean {
  return Boolean(c.is_rules) || (Boolean(c.is_complaint) && COMPLAINT_RULES.test(c.title));
}

interface IndexedDoc {
  chunk: ChunkRow;
  tf: Map<string, number>;
  len: number;
  titleTerms: Set<string>;
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
      const titleTokens = tokenize(chunk.title);
      const tokens = [...titleTokens, ...tokenize(chunk.text)];
      const tf = new Map<string, number>();
      for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
      for (const t of tf.keys()) this.df.set(t, (this.df.get(t) ?? 0) + 1);
      this.docs.push({ chunk, tf, len: tokens.length, titleTerms: new Set(titleTokens) });
      total += tokens.length;
    }
    this.avgLen = this.docs.length ? total / this.docs.length : 1;
  }

  get size(): number {
    return this.docs.length;
  }

  /** eventText — текст, по которому решаем, назван ли ивент (вопрос игрока, а не переписанный AI запрос с догадками). */
  search(query: string, limit: number, filter?: (c: ChunkRow) => boolean, eventText?: string): SearchHit[] {
    const terms = [...new Set(tokenize(query))];
    if (!terms.length) return [];
    const n = this.docs.length;
    const idfOf = (t: string): number => {
      const df = this.df.get(t) ?? 0;
      return Math.log(1 + (n - df + 0.5) / (df + 0.5));
    };
    const idfTotal = terms.reduce((sum, t) => sum + idfOf(t), 0) || 1;
    const termSet = new Set(eventText !== undefined ? tokenize(expandSlang(eventText)) : terms);
    const hits: SearchHit[] = [];
    for (const d of this.docs) {
      if (filter && !filter(d.chunk)) continue;
      let score = 0;
      let matched = 0;
      let titleIdf = 0;
      for (const t of terms) {
        const f = d.tf.get(t);
        if (!f) continue;
        matched++;
        const idf = idfOf(t);
        if (d.titleTerms.has(t)) titleIdf += idf;
        const boost = POINT_TOKEN.test(t) ? 3 : t.startsWith(PREFIX) ? 0.5 : 1;
        score += boost * idf * ((f * (this.k1 + 1)) / (f + this.k1 * (1 - this.b + (this.b * d.len) / this.avgLen)));
      }
      if (!matched) continue;
      // Небольшой бонус за покрытие запроса и за документы с правилами.
      score *= 1 + matched / terms.length;
      // Заголовок темы говорит, о чём она: «жалоба на игрока» → «Правила подачи жалоб на игроков», а не «…на администрацию».
      // Доля считается по IDF слов запроса: частое «правила» есть почти в каждом заголовке и почти ничего не даёт.
      const unnamedEvent = EVENT_RULES.test(d.chunk.title) && !eventNamed(d.titleTerms, termSet);
      // Совпадение с заголовком ивента по общему слову («ограбление» в «Ограбление банкомата») ни о чём не говорит.
      if (!unnamedEvent) score *= 1 + TITLE_WEIGHT * (titleIdf / idfTotal);
      // Жалобы — разбор конкретных случаев: слова совпадают часто, а отвечают на общий вопрос редко.
      // Регламент раздела жалоб («Правила подачи жалоб», «Форма подачи») — это правила, их не штрафуем.
      if (isRulesChunk(d.chunk)) score *= 1.25;
      // Общие правила проекта — главный ответ на общий вопрос («что будет за читы»), а не правила отдельного ивента.
      if (GENERAL_RULES.test(d.chunk.title)) score *= 1.3;
      // Правила отдельного мероприятия/события, а вопрос его не называет («грабить без отыгровки», а не «ограбление банкомата») —
      // общий ответ скорее в тематических правилах, ивент чуть ниже.
      if (unnamedEvent) score *= 0.8;
      else if (d.chunk.is_complaint) score *= 0.6;
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
export function searchKnowledge(
  query: string,
  scope: string | null,
  limit = 6,
  minScore = 1.5,
  excludeComplaints = false,
  eventText?: string,
): SearchHit[] {
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
    eventText,
  );
  return capPerDoc(hits, limit, minScore);
}

/**
 * Объединяет результаты нескольких поисков (по исходному и переписанному вопросу).
 * Баллы каждого поиска делятся на его лучший балл и складываются: длинный переписанный запрос даёт баллы выше
 * и иначе вытеснял бы точные совпадения с вопросом, а фрагмент, найденный обоими поисками, — самый надёжный.
 * Одинаковые по тексту фрагменты (пункт из разных версий темы) остаются в одном экземпляре.
 */
export function mergeHits(lists: SearchHit[][], limit = 6): SearchHit[] {
  const merged = new Map<number, SearchHit>();
  for (const list of lists) {
    const top = list[0]?.score;
    if (!top) continue;
    for (const h of list) {
      const prev = merged.get(h.chunk.id);
      merged.set(h.chunk.id, { chunk: h.chunk, score: (prev?.score ?? 0) + h.score / top });
    }
  }
  const seenText = new Set<string>();
  const unique = [...merged.values()]
    .sort((a, b) => b.score - a.score)
    .filter((h) => {
      const key = normalizedText(h.chunk.text);
      if (seenText.has(key)) return false;
      seenText.add(key);
      return true;
    });
  // Слабые совпадения уже отсеяны в каждом поиске (searchKnowledge), здесь только лимит и не больше 3–4 фрагментов из темы.
  return capPerDoc(unique, limit, 0, false);
}

/** Текст фрагмента для сравнения на дубли: без пробелов и регистра. */
export function normalizedText(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 300);
}

/** Фрагменты слабее этой доли лучшего результата — случайные совпадения по одному слову. */
const RELATIVE_CUTOFF = 0.55;

/** Номер первого пункта фрагмента («1.2.1 Запрещено…», «Пункт 1.2: …»), пропуская заголовок раздела и дату редакции. */
function leadingPoint(text: string): string | null {
  for (const line of text.split('\n').slice(0, 4)) {
    const m = line.trim().match(/^(?:Пункт\s+)?(\d{1,2}(?:\.\d{1,2}){1,2})\b/u);
    if (m) return m[1];
  }
  return null;
}

function capPerDoc(hits: SearchHit[], limit: number, minScore: number, relative = true): SearchHit[] {
  const out: SearchHit[] = [];
  const perDoc = new Map<string, number>();
  const cutoff = Math.max(minScore, relative ? (hits[0]?.score ?? 0) * RELATIVE_CUTOFF : 0);
  const seenPoints = new Set<string>();
  for (const h of hits) {
    if (h.score < cutoff) continue;
    // Тот же пункт той же темы второй раз (старая и новая редакция, фрагмент и «Пункт N» из таблицы) — не берём.
    const point = leadingPoint(h.chunk.text);
    if (point) {
      const key = `${h.chunk.doc_url}#${point}`;
      if (seenPoints.has(key)) continue;
      seenPoints.add(key);
    }
    const n = perDoc.get(h.chunk.doc_url) ?? 0;
    // Не более 3 фрагментов из одной темы; из правил — 4: там фрагмент ≈ один пункт, и нужный легко вытесняют соседние.
    if (n >= (isRulesChunk(h.chunk) ? 4 : 3)) continue;
    perDoc.set(h.chunk.doc_url, n + 1);
    out.push(h);
    if (out.length >= limit) break;
  }
  return out;
}
