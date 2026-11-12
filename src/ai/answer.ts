import { config } from '../config.js';
import { secrets } from '../crypto.js';
import { chunkForRulePoint, chunkTextsForDoc, getGuild, getUserSettings, listFaq, recordAiRequest, rulesForDoc } from '../db/repo.js';
import { log } from '../util/logger.js';
import { truncate } from '../util/text.js';
import { matchFaq } from './faq.js';
import { buildPrompt, cleanCitations, renumberCitations, type ContextFragment, type PreviousExchange } from './prompt.js';
import { AiError, PROVIDERS, complete, isProviderId, listModels, promptStyleFor, type ProviderId } from './providers.js';
import { lookupRule } from './ruleLookup.js';
import { termDefinitions } from './glossary.js';
import { expandSlang, rewriteQuery } from './queryRewrite.js';
import { isRulesChunk, mergeHits, normalizedText, searchKnowledge, type SearchHit } from './search.js';

export interface Credentials {
  provider: ProviderId;
  token: string;
  model: string;
  /** Модель не выбрана явно — используется модель провайдера по умолчанию. */
  modelIsDefault: boolean;
  origin: 'guild' | 'user' | 'default';
}

function decryptOrNull(enc: string | null): string | null {
  if (!enc) return null;
  try {
    return secrets.decrypt(enc);
  } catch (err) {
    log.error('Не удалось расшифровать AI-токен (сменился ENCRYPTION_KEY?)', err);
    return null;
  }
}

/** AI-токен общего сервера (SHARED_AI_GUILD_ID), если он задан. */
export function sharedAiGuildCredentials(): { guildId: string; provider: ProviderId; token: string; model: string | null } | null {
  const sharedId = config.sharedAiGuildId;
  if (!sharedId) return null;
  const sg = getGuild(sharedId);
  const token = decryptOrNull(sg?.ai_token ?? null);
  if (!sg || !token || !isProviderId(sg.ai_provider)) return null;
  return { guildId: sharedId, provider: sg.ai_provider, token, model: sg.ai_model };
}

/** Токен сервера (на сервере) или личный токен (в ЛС); без них — токен SHARED_AI_GUILD_ID; иначе — токен по умолчанию из .env. */
export function resolveCredentials(guildId: string | null, userId: string): Credentials | null {
  const make = (provider: ProviderId, token: string, model: string | null, origin: Credentials['origin']): Credentials => ({
    provider,
    token,
    model: model || PROVIDERS[provider].defaultModel,
    modelIsDefault: !model,
    origin,
  });
  if (guildId) {
    const g = getGuild(guildId);
    const token = decryptOrNull(g?.ai_token ?? null);
    if (g && token && isProviderId(g.ai_provider)) return make(g.ai_provider, token, g.ai_model, 'guild');
  } else {
    const s = getUserSettings(userId);
    const token = decryptOrNull(s.ai_token);
    if (token && isProviderId(s.ai_provider)) return make(s.ai_provider, token, s.ai_model, 'user');
  }
  // Нет своего токена (сервер или ЛС) — берём токен общего сервера (SHARED_AI_GUILD_ID).
  const shared = sharedAiGuildCredentials();
  if (shared && shared.guildId !== guildId) return make(shared.provider, shared.token, shared.model, 'guild');
  const fb = config.fallbackAi;
  if (fb.token && isProviderId(fb.provider)) return make(fb.provider, fb.token, fb.model, 'default');
  return null;
}

/** Если модель не выбрана, а модель по умолчанию у провайдера уже убрали — берём первую доступную. */
async function ensureAvailableModel(creds: Credentials): Promise<Credentials> {
  if (!creds.modelIsDefault) return creds;
  const live = await listModels(creds.provider, creds.token);
  if (live?.length && !live.includes(creds.model)) return { ...creds, model: live[0] };
  return creds;
}

export interface AskInput {
  guildId: string | null;
  userId: string;
  question: string;
  /** Прошлый вопрос игрока и ответ бота (за последние минуты) — для вопросов-продолжений. */
  previous?: PreviousExchange | null;
}

export interface AskResult {
  kind: 'faq' | 'ai' | 'nodata' | 'notoken';
  text: string;
  /** Фрагменты, переданные модели (для npm run ask -- --context). */
  fragments?: ContextFragment[];
  /** Поисковый запрос, который составил AI (null — переписать не удалось). */
  rewritten?: string | null;
}

const NO_DATA =
  '🤔 Не нашёл информации об этом в базе знаний NOVA RP.\n' +
  'Я отвечаю только на вопросы о проекте NOVA RP — правилах, наказаниях, жалобах и процедурах. ' +
  'Попробуйте переформулировать вопрос или загляните на форум: <https://forum.nova-rp.com>';

const MAX_MESSAGE = 1950;

export async function answerQuestion(input: AskInput): Promise<AskResult> {
  const question = input.question.trim().slice(0, 1500);
  const settings = getUserSettings(input.userId);
  // Настройки AI сервера (в ЛС с личным токеном — значения по умолчанию).
  const ai = aiSettingsFor(input.guildId);

  if (input.guildId && ai.faqFirst) {
    const faq = matchFaq(question, listFaq(input.guildId));
    if (faq) return { kind: 'faq', text: truncate(`📌 **${faq.question}**\n${faq.answer}`, MAX_MESSAGE) };
  }

  const resolved = resolveCredentials(input.guildId, input.userId);
  const creds = resolved ? await ensureAvailableModel(resolved) : null;

  // «Бот ищет сам»: AI переписывает вопрос (опечатки, сленг, синонимы), ищем по обоим вариантам.
  const aiRewrite = creds && ai.rewrite ? await rewriteQuery(creds, question, ai.fallbackModel, input.previous?.question) : null;
  const slang = expandSlang(question);
  const rewritten = [aiRewrite, slang].filter(Boolean).join(' ') || null;
  const searchText = rewritten ? `${question}\n${rewritten}` : question;

  const fragments: ContextFragment[] = [];
  const seenRules = new Set<number>();
  // «Что такое ДМ / ТК / СК…» — сразу берём определение термина из правил.
  for (const r of termDefinitions(searchText, input.guildId)) {
    if (seenRules.has(r.id)) continue;
    seenRules.add(r.id);
    fragments.push({
      n: fragments.length + 1,
      title: r.doc_title,
      url: r.post_url,
      text:
        `Пункт ${r.point}: ${r.text}${r.punishment ? `\nНаказание: ${r.punishment}` : ''}` +
        (r.context ? `\nИз вступления к этим правилам:\n${r.context}` : ''),
      kind: 'rule',
    });
  }
  const points = [...new Set(searchText.match(/\d{1,2}(?:\.\d{1,2}){1,2}/g) ?? [])].slice(0, 3);
  for (const p of points) {
    const r = lookupRule(p, input.guildId)[0];
    if (r && !seenRules.has(r.id)) {
      seenRules.add(r.id);
      fragments.push({
        n: fragments.length + 1,
        title: r.doc_title,
        url: r.post_url,
        text: `Пункт ${r.point}: ${r.text}${r.punishment ? `\nНаказание: ${r.punishment}` : ''}`,
        kind: 'rule',
      });
    }
  }
  const hits = mergeHits(
    [
      searchKnowledge(question, input.guildId, ai.contextSize + 2, 1.5, !ai.searchComplaints),
      rewritten ? searchKnowledge(rewritten, input.guildId, ai.contextSize + 2, 1.5, !ai.searchComplaints, question) : [],
    ],
    ai.contextSize,
  );
  // Пункт, уже добавленный как определение термина или по номеру, второй раз не передаём.
  const seenText = new Set(fragments.map((f) => normalizedText(f.text)));
  const whole = wholeRulesDoc(hits);
  if (whole) {
    fragments.push({ n: fragments.length + 1, title: whole.title, url: whole.url, text: whole.text, kind: 'rule' });
    for (const r of whole.rules) seenText.add(normalizedText(`Пункт ${r.point}: ${r.text}${r.punishment ? `\nНаказание: ${r.punishment}` : ''}`));
  }
  for (const h of hits) {
    if (whole && h.chunk.doc_url === whole.docUrl) continue;
    if (seenText.has(normalizedText(h.chunk.text))) continue;
    const kind = isRulesChunk(h.chunk) ? 'rule' : h.chunk.is_complaint ? 'complaint' : 'forum';
    let { text, post_url: url } = h.chunk;
    // Пункт из таблицы rules (id < 0) заменяем фрагментом форума с ним: там подпункты, списки и исключения.
    const point = h.chunk.id < 0 ? /^Пункт ([\d.]+):/.exec(text)?.[1] : undefined;
    const full = point ? chunkForRulePoint(h.chunk.doc_url, point) : undefined;
    if (full) {
      if (seenText.has(normalizedText(full.text))) continue;
      seenText.add(normalizedText(full.text));
      ({ text, post_url: url } = full);
    }
    seenText.add(normalizedText(text));
    fragments.push({ n: fragments.length + 1, title: h.chunk.title, url, text, kind });
  }
  // Без контекста AI всё равно отвечает (приветствие, общие вопросы), но правила без форума не придумывает — это в промпте.
  // В режиме «Только форум» отвечать не из чего — модель не вызываем.
  if (!fragments.length && (!creds || ai.forumOnly)) return { kind: 'nodata', text: NO_DATA };

  if (!creds) {
    return {
      kind: 'notoken',
      text: input.guildId
        ? '⚙️ AI-токен для этого сервера не настроен. Администратор может указать его в #ai-настройки → «AI-токен».'
        : '⚙️ AI-токен для ЛС не найден: личный токен не задан, а на ваших серверах с ботом токен не настроен или ваша роль не может использовать бота в ЛС. ' +
          'Задайте личный токен через /setupls → «Личный токен» или обратитесь к администрации сервера.',
    };
  }

  const chosen = settings.answer_length === 'auto' ? ai.answerLength : settings.answer_length === 'long' ? 'long' : 'short';
  // «Перечисли правила ограбления дома» в 3 коротких предложения не помещается — даём развёрнутый ответ.
  const length = wantsList(question) ? 'long' : chosen;
  const extra = [TONE_PROMPTS[ai.tone], ai.instructions].filter(Boolean).join('\n') || null;
  let answer: string;
  let usedModel = creds.model;
  try {
    const prompt = buildPrompt(promptStyleFor(creds.provider, creds.model), length, question, fragments, extra, ai.forumOnly, input.previous);
    const request = {
      system: prompt.system,
      user: prompt.user,
      temperature: ai.temperature ?? prompt.temperature,
      maxTokens: ai.maxTokens ?? (length === 'long' ? (wantsList(question) ? 1600 : 900) : 400),
    };
    try {
      answer = await complete(creds.provider, creds.token, creds.model, request);
    } catch (err) {
      // Резервная модель: при лимитах, недоступности или удалённой модели пробуем вторую.
      const retryable = err instanceof AiError && (err.status === 0 || err.status === 404 || err.status === 429 || err.status >= 500);
      if (!retryable || !ai.fallbackModel || ai.fallbackModel === creds.model) throw err;
      log.warn(`Основная модель ${creds.model} не ответила (${(err as AiError).status}), пробую резервную ${ai.fallbackModel}`);
      usedModel = ai.fallbackModel;
      answer = await complete(creds.provider, creds.token, ai.fallbackModel, request);
    }
    recordAiRequest(input.guildId, input.userId, 'ask', true);
  } catch (err) {
    recordAiRequest(input.guildId, input.userId, 'ask', false);
    throw err;
  }
  answer = cleanCitations(answer);
  const modelNote = ai.showModel ? `\n-# 🤖 ${PROVIDERS[creds.provider].label} · ${usedModel}` : '';

  let sources = '';
  if (settings.show_sources && ai.showSources) {
    // Только то, на что модель сослалась: ответ из общих знаний без [n] — без источников, а не с первыми попавшимися.
    const renumbered = renumberCitations(answer, fragments);
    answer = renumbered.text;
    const lines = renumbered.sources.map((s) => `[${s.n}] ${truncate(s.title, 60)} — <${s.url}>`);
    if (lines.length) sources = `\n\n**Источники:**\n${lines.join('\n')}`;
  } else {
    answer = answer.replace(/\s?\[\d{1,2}\]/g, '');
  }

  return { kind: 'ai', text: truncate(answer, MAX_MESSAGE - sources.length - modelNote.length) + sources + modelNote, fragments, rewritten };
}

/** Игрок просит перечислить правила, а не спрашивает про один случай. */
export function wantsList(question: string): boolean {
  return /(перечисл\p{L}*|список|все\s+правила|какие\s+(есть\s+)?правила|^\s*правила\s)/iu.test(question);
}

/** Короткие правила (мероприятия, события) передаём целиком: ответ часто в пункте, где нет слов из вопроса. */
const WHOLE_DOC_MAX_CHARS = 4500;
/**
 * Полный текст темы (из фрагментов) — до этого размера. В таблице rules только «пункт + наказание»:
 * там теряются «Исключение: Ограбление дома», вводная часть («раз в 24 часа», «нужен лом») и списки под пунктом
 * («3.4 Минимальное количество грабителей: 2 игрока…»), и модель отвечала без них.
 */
const WHOLE_DOC_FULL_MAX_CHARS = 8000;

/** Склеивает фрагменты темы: без картинок, вложений и повторённых в начале фрагментов заголовков разделов. */
export function joinDocChunks(chunks: string[]): string {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const chunk of chunks) {
    for (const raw of chunk.split('\n')) {
      const line = raw.trim();
      if (!line) continue;
      if (/\.(png|jpe?g|gif|webp)$/i.test(line) || /^Посмотреть вложение/i.test(line) || /^Спойлер:/i.test(line)) continue;
      // Заголовок раздела чанкер повторяет в каждом фрагменте; пункты и примечания не повторяются.
      if (seen.has(line) && line.length < 120) continue;
      seen.add(line);
      out.push(line);
    }
  }
  return out.join('\n');
}

/**
 * Правила, о которых вопрос: лучший результат поиска или не меньше двух фрагментов из одной темы.
 * Поиск находит тему по названию («станок для печати денег»), но из её пунктов берёт случайные:
 * «каким оружием нельзя» — а в пункте 1.6 написано «пулемёты и снайперские винтовки», без слова «оружие».
 */
function wholeRulesDoc(hits: SearchHit[]) {
  const counts = new Map<string, number>();
  for (const h of hits) if (isRulesChunk(h.chunk)) counts.set(h.chunk.doc_url, (counts.get(h.chunk.doc_url) ?? 0) + 1);
  const candidates = hits
    .filter((h, i) => isRulesChunk(h.chunk) && (i === 0 || (counts.get(h.chunk.doc_url) ?? 0) >= 2))
    .map((h) => h.chunk.doc_url);
  for (const docUrl of new Set(candidates)) {
    const rules = rulesForDoc(docUrl).filter((r) => !r.is_complaint);
    if (rules.length < 2) continue;
    const full = joinDocChunks(chunkTextsForDoc(docUrl));
    if (full.length <= WHOLE_DOC_FULL_MAX_CHARS) {
      return { docUrl, title: rules[0].doc_title, url: rules[0].post_url, text: full, rules };
    }
    const lines = rules.map((r) => `Пункт ${r.point}: ${r.text}${r.punishment ? ` Наказание: ${r.punishment}` : ''}`);
    const text = lines.join('\n');
    if (text.length > WHOLE_DOC_MAX_CHARS) continue;
    return { docUrl, title: rules[0].doc_title, url: rules[0].post_url, text, rules };
  }
  return null;
}

export interface GuildAiSettings {
  answerLength: 'short' | 'long';
  temperature: number | null;
  rewrite: boolean;
  showSources: boolean;
  contextSize: number;
  instructions: string | null;
  tone: 'neutral' | 'official' | 'friendly' | 'strict';
  maxTokens: number | null;
  fallbackModel: string | null;
  searchComplaints: boolean;
  showModel: boolean;
  faqFirst: boolean;
  forumOnly: boolean;
}

/** Стиль общения бота (меню «Настройки AI» → «Тон»). */
export const TONE_PROMPTS: Record<GuildAiSettings['tone'], string> = {
  neutral: '',
  official: 'Тон: официальный и вежливый, обращайся на «вы», как сотрудник администрации проекта.',
  friendly: 'Тон: дружелюбный и простой, можно на «ты», допускается 1–2 уместных эмодзи.',
  strict: 'Тон: максимально сухо и по делу — только ответ, пункт правил и наказание, без пояснений сверх необходимого.',
};

export function aiSettingsFor(guildId: string | null): GuildAiSettings {
  const g = guildId ? getGuild(guildId) : undefined;
  return {
    answerLength: g?.ai_answer_length === 'long' ? 'long' : 'short',
    temperature: g?.ai_temperature ?? null,
    rewrite: (g?.ai_rewrite ?? 1) === 1,
    showSources: (g?.ai_show_sources ?? 1) === 1,
    contextSize: Math.min(Math.max(g?.ai_context_size ?? 6, 2), 12),
    instructions: g?.ai_instructions?.trim() || null,
    tone: g?.ai_tone && g.ai_tone in TONE_PROMPTS ? g.ai_tone : 'neutral',
    maxTokens: g?.ai_max_tokens ?? null,
    fallbackModel: g?.ai_fallback_model?.trim() || null,
    searchComplaints: (g?.ai_search_complaints ?? 1) === 1,
    showModel: (g?.ai_show_model ?? 0) === 1,
    faqFirst: (g?.ai_faq_first ?? 1) === 1,
    forumOnly: (g?.ai_forum_only ?? 0) === 1,
  };
}

export function aiErrorMessage(err: unknown): string | null {
  return err instanceof AiError ? `⚠️ ${err.userMessage}` : null;
}
