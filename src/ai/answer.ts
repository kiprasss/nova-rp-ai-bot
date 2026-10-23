import { config } from '../config.js';
import { secrets } from '../crypto.js';
import { getGuild, getUserSettings, listFaq, recordAiRequest } from '../db/repo.js';
import { log } from '../util/logger.js';
import { truncate } from '../util/text.js';
import { matchFaq } from './faq.js';
import { buildPrompt, citedNumbers, type ContextFragment } from './prompt.js';
import { AiError, PROVIDERS, complete, isProviderId, listModels, promptStyleFor, type ProviderId } from './providers.js';
import { lookupRule } from './ruleLookup.js';
import { termDefinitions } from './glossary.js';
import { rewriteQuery } from './queryRewrite.js';
import { mergeHits, searchKnowledge } from './search.js';

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

/** Токен сервера (на сервере) или личный токен (в ЛС); иначе — токен по умолчанию из .env. */
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
}

export interface AskResult {
  kind: 'faq' | 'ai' | 'nodata' | 'notoken';
  text: string;
}

const NO_DATA =
  '🤔 Не нашёл информации об этом в базе знаний NOVA RP.\n' +
  'Я отвечаю только на вопросы о проекте NOVA RP — правилах, наказаниях, жалобах и процедурах. ' +
  'Попробуйте переформулировать вопрос или загляните на форум: <https://forum.grand-rp.su>';

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
  const rewritten = creds && ai.rewrite ? await rewriteQuery(creds, question) : null;
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
      text: `Пункт ${r.point}: ${r.text}${r.punishment ? `\nНаказание: ${r.punishment}` : ''}`,
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
      });
    }
  }
  const hits = mergeHits(
    [
      searchKnowledge(question, input.guildId, ai.contextSize + 2, 1.5, !ai.searchComplaints),
      rewritten ? searchKnowledge(rewritten, input.guildId, ai.contextSize + 2, 1.5, !ai.searchComplaints) : [],
    ],
    ai.contextSize,
  );
  for (const h of hits) {
    fragments.push({ n: fragments.length + 1, title: h.chunk.title, url: h.chunk.post_url, text: h.chunk.text });
  }
  // Без контекста AI всё равно отвечает (приветствие, общие вопросы), но правила без форума не придумывает — это в промпте.
  if (!fragments.length && !creds) return { kind: 'nodata', text: NO_DATA };

  if (!creds) {
    return {
      kind: 'notoken',
      text: input.guildId
        ? '⚙️ AI-токен для этого сервера не настроен. Администратор может указать его в #ai-настройки → «AI-токен».'
        : '⚙️ AI-токен для ЛС не найден: личный токен не задан, а на ваших серверах с ботом токен не настроен или ваша роль не может использовать бота в ЛС. ' +
          'Задайте личный токен через /setupls → «Личный токен» или обратитесь к администрации сервера.',
    };
  }

  const length = settings.answer_length === 'auto' ? ai.answerLength : settings.answer_length === 'long' ? 'long' : 'short';
  const extra = [TONE_PROMPTS[ai.tone], ai.instructions].filter(Boolean).join('\n') || null;
  let answer: string;
  let usedModel = creds.model;
  try {
    const prompt = buildPrompt(promptStyleFor(creds.provider, creds.model), length, question, fragments, extra);
    const request = {
      system: prompt.system,
      user: prompt.user,
      temperature: ai.temperature ?? prompt.temperature,
      maxTokens: ai.maxTokens ?? (length === 'long' ? 900 : 400),
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
  const modelNote = ai.showModel ? `\n-# 🤖 ${PROVIDERS[creds.provider].label} · ${usedModel}` : '';

  let sources = '';
  if (settings.show_sources && ai.showSources) {
    const cited = citedNumbers(answer).filter((n) => n >= 1 && n <= fragments.length);
    const used = (cited.length ? cited.map((n) => fragments[n - 1]) : fragments.slice(0, 3)).slice(0, 5);
    const seen = new Set<string>();
    const lines = used
      .filter((f) => !seen.has(f.url) && seen.add(f.url))
      .map((f) => `[${f.n}] ${truncate(f.title, 60)} — <${f.url}>`);
    if (lines.length) sources = `\n\n**Источники:**\n${lines.join('\n')}`;
  } else {
    answer = answer.replace(/\s?\[\d{1,2}\]/g, '');
  }

  return { kind: 'ai', text: truncate(answer, MAX_MESSAGE - sources.length - modelNote.length) + sources + modelNote };
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
  };
}

export function aiErrorMessage(err: unknown): string | null {
  return err instanceof AiError ? `⚠️ ${err.userMessage}` : null;
}
