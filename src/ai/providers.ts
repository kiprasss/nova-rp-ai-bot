export type ProviderId = 'openai' | 'gemini' | 'anthropic' | 'openrouter' | 'groq' | 'mistral' | 'deepseek' | 'xai';

/** Стиль промпта: у разных моделей разные сильные стороны (см. prompt.ts). */
export type PromptStyle = 'standard' | 'claude' | 'gemini' | 'compact';

export interface ProviderInfo {
  id: ProviderId;
  label: string;
  defaultModel: string;
  /** Подсказки для меню выбора модели. Можно указать и любую другую модель вручную. */
  models: string[];
  tokenHint: string;
  /** Для OpenAI-совместимых API. */
  baseUrl?: string;
  style: PromptStyle;
}

export const PROVIDERS: Record<ProviderId, ProviderInfo> = {
  openai: {
    id: 'openai',
    label: 'OpenAI',
    defaultModel: 'gpt-4.1-mini',
    models: ['gpt-4.1-mini', 'gpt-4.1-nano', 'gpt-4.1', 'gpt-4o-mini', 'gpt-4o', 'o4-mini'],
    tokenHint: 'sk-...',
    baseUrl: 'https://api.openai.com/v1',
    style: 'standard',
  },
  gemini: {
    id: 'gemini',
    label: 'Google Gemini',
    // gemini-2.5-* новым ключам уже не выдаются (404), а 3.8/3.7 часто перегружены (503).
    defaultModel: 'gemini-3.5-flash',
    models: ['gemini-3.5-flash', 'gemini-3.5-flash-lite', 'gemini-3.8-flash', 'gemini-3.1-pro-preview', 'gemini-2.5-flash'],
    tokenHint: 'AIza...',
    style: 'gemini',
  },
  anthropic: {
    id: 'anthropic',
    label: 'Anthropic Claude',
    defaultModel: 'claude-haiku-5-5',
    models: ['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5'],
    tokenHint: 'sk-ant-...',
    style: 'claude',
  },
  groq: {
    id: 'groq',
    label: 'Groq',
    defaultModel: 'llama-3.3-70b-versatile',
    models: ['llama-3.3-70b-versatile', 'openai/gpt-oss-120b', 'openai/gpt-oss-20b', 'qwen/qwen3-32b', 'moonshotai/kimi-k2-instruct'],
    tokenHint: 'gsk_...',
    baseUrl: 'https://api.groq.com/openai/v1',
    style: 'compact',
  },
  mistral: {
    id: 'mistral',
    label: 'Mistral AI',
    defaultModel: 'mistral-small-latest',
    models: ['mistral-small-latest', 'mistral-medium-latest', 'mistral-large-latest', 'open-mistral-nemo'],
    tokenHint: '32 символа',
    baseUrl: 'https://api.mistral.ai/v1',
    style: 'compact',
  },
  deepseek: {
    id: 'deepseek',
    label: 'DeepSeek',
    defaultModel: 'deepseek-chat',
    models: ['deepseek-chat', 'deepseek-reasoner'],
    tokenHint: 'sk-...',
    baseUrl: 'https://api.deepseek.com/v1',
    style: 'compact',
  },
  xai: {
    id: 'xai',
    label: 'xAI Grok',
    defaultModel: 'grok-3-mini',
    models: ['grok-3-mini', 'grok-3', 'grok-4'],
    tokenHint: 'xai-...',
    baseUrl: 'https://api.x.ai/v1',
    style: 'standard',
  },
  openrouter: {
    id: 'openrouter',
    label: 'OpenRouter',
    defaultModel: 'openai/gpt-4.1-mini',
    models: [
      'openai/gpt-4.1-mini',
      'google/gemini-2.5-flash',
      'anthropic/claude-sonnet-4',
      'meta-llama/llama-3.3-70b-instruct',
      'deepseek/deepseek-chat',
      'mistralai/mistral-small-3.2-24b-instruct',
      'qwen/qwen-2.5-72b-instruct',
    ],
    tokenHint: 'sk-or-...',
    baseUrl: 'https://openrouter.ai/api/v1',
    style: 'standard',
  },
};

export function isProviderId(v: string | null | undefined): v is ProviderId {
  return !!v && v in PROVIDERS;
}

/** Стиль промпта по провайдеру и модели (у OpenRouter — по «семейству» модели). */
export function promptStyleFor(provider: ProviderId, model: string): PromptStyle {
  if (provider === 'openrouter') {
    if (model.startsWith('anthropic/')) return 'claude';
    if (model.startsWith('google/')) return 'gemini';
    if (/^(meta-llama|mistralai|qwen|deepseek|nousresearch|microsoft|moonshotai)\//.test(model)) return 'compact';
    return 'standard';
  }
  return PROVIDERS[provider].style;
}

/** «Думающие» модели тратят часть лимита токенов на рассуждения — им нужен запас. */
export function isReasoningModel(model: string): boolean {
  return /(^|\/)(o\d|gpt-5|gpt-oss|deepseek-reasoner|qwen3|grok-3-mini|grok-4|claude-(haiku|sonnet|opus|fable)-5|.*-thinking)/i.test(model);
}

export interface ChatRequest {
  system: string;
  user: string;
  maxTokens: number;
  temperature?: number;
}

export class AiError extends Error {
  constructor(
    public readonly status: number,
    public readonly userMessage: string,
    details: string,
  ) {
    super(details);
    this.name = 'AiError';
  }
}

function userMessageFor(status: number): string {
  if (status === 401 || status === 403) return 'AI-провайдер отклонил токен (неверный или отозванный ключ).';
  if (status === 404) return 'Модель не найдена у AI-провайдера. Проверьте название модели в настройках.';
  if (status === 429) return 'AI-провайдер временно ограничил запросы (лимит или закончился баланс). Попробуйте позже.';
  if (status === 400 || status === 422) return 'AI-провайдер отклонил запрос (проверьте модель и настройки).';
  if (status === 402) return 'На аккаунте AI-провайдера недостаточно средств.';
  if (status >= 500) return 'AI-провайдер временно недоступен. Попробуйте позже.';
  return 'Не удалось получить ответ от AI-провайдера.';
}

const TIMEOUT_MS = 90_000;

async function postJson(url: string, headers: Record<string, string>, body: unknown): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    throw new AiError(0, 'Не удалось связаться с AI-провайдером (таймаут или нет сети).', String(err));
  }
  const text = await res.text();
  if (!res.ok) throw new AiError(res.status, userMessageFor(res.status), `HTTP ${res.status}: ${text.slice(0, 500)}`);
  try {
    return JSON.parse(text);
  } catch {
    throw new AiError(res.status, 'AI-провайдер вернул некорректный ответ.', text.slice(0, 500));
  }
}

/* eslint-disable @typescript-eslint/no-explicit-any */
async function openAiCompatible(provider: ProviderId, token: string, model: string, req: ChatRequest) {
  const info = PROVIDERS[provider];
  const isOpenAi = provider === 'openai';
  const reasoning = isReasoningModel(model);
  const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
  if (provider === 'openrouter') headers['X-Title'] = 'NOVA RP AI Bot';
  const body: Record<string, unknown> = {
    model,
    messages: [
      { role: 'system', content: req.system },
      { role: 'user', content: req.user },
    ],
  };
  // OpenAI: max_completion_tokens; у «думающих» моделей OpenAI нельзя менять temperature.
  if (isOpenAi) body.max_completion_tokens = req.maxTokens;
  else body.max_tokens = req.maxTokens;
  if (req.temperature !== undefined && !(isOpenAi && reasoning)) body.temperature = req.temperature;
  // Groq: у qwen3 скрываем рассуждения из ответа.
  if (provider === 'groq' && /qwen3/i.test(model)) body.reasoning_format = 'hidden';

  const data = (await postJson(`${info.baseUrl}/chat/completions`, headers, body)) as any;
  return String(data?.choices?.[0]?.message?.content ?? '');
}

async function gemini(token: string, model: string, req: ChatRequest) {
  const data = (await postJson(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
    { 'x-goog-api-key': token },
    {
      systemInstruction: { parts: [{ text: req.system }] },
      contents: [{ role: 'user', parts: [{ text: req.user }] }],
      // У «думающих» моделей Gemini размышления тоже расходуют лимит, поэтому даём запас.
      generationConfig: { maxOutputTokens: Math.max(req.maxTokens * 4, 2048), temperature: req.temperature ?? 0.2 },
    },
  )) as any;
  const parts: any[] = data?.candidates?.[0]?.content?.parts ?? [];
  return parts
    .filter((p) => !p.thought)
    .map((p) => p.text ?? '')
    .join('');
}

async function anthropic(token: string, model: string, req: ChatRequest) {
  const data = (await postJson(
    'https://api.anthropic.com/v1/messages',
    { 'x-api-key': token, 'anthropic-version': '2023-06-01' },
    {
      model,
      max_tokens: req.maxTokens,
      system: req.system,
      messages: [{ role: 'user', content: req.user }],
      // Новые Claude (5.x) думают по умолчанию, и рассуждения тратят тот же max_tokens. Для ответов по правилам
      // хватает низкого уровня — так ответ быстрее, дешевле и не обрезается.
      ...(isReasoningModel(model) ? { output_config: { effort: 'low' } } : {}),
    },
  )) as any;
  const blocks: any[] = data?.content ?? [];
  return blocks
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('');
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/** Убирает рассуждения <think>…</think>, которые некоторые открытые модели пишут прямо в ответ. */
export function stripReasoning(text: string): string {
  return text
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/^[\s\S]*?<\/think>/i, '')
    .trim();
}

export async function complete(provider: ProviderId, token: string, model: string, req: ChatRequest): Promise<string> {
  const effective = isReasoningModel(model) ? { ...req, maxTokens: req.maxTokens * 4 } : req;
  let text: string;
  try {
    if (provider === 'gemini') text = await gemini(token, model, effective);
    else if (provider === 'anthropic') text = await anthropic(token, model, effective);
    else text = await openAiCompatible(provider, token, model, effective);
  } catch (err) {
    if (err instanceof AiError && (err.status === 404 || /model_not_found|does not exist|decommissioned|deprecated/i.test(err.message))) {
      throw new AiError(
        err.status,
        `Модель «${model}» больше недоступна у провайдера ${PROVIDERS[provider].label}. Выберите другую в меню «AI-токен» — список моделей берётся прямо у провайдера.`,
        err.message,
      );
    }
    throw err;
  }
  text = stripReasoning(text);
  if (!text) throw new AiError(200, 'AI-провайдер вернул пустой ответ. Попробуйте переформулировать вопрос.', 'empty completion');
  return text;
}

// ---------- Актуальный список моделей у провайдера ----------

/** Модели, которые не годятся для чата (речь, картинки, эмбеддинги, модерация и т.п.). */
const NON_CHAT = /(whisper|tts|audio|transcribe|realtime|embed|moderation|guard|image|dall-e|imagen|veo|vision-preview|ocr|search|computer-use|davinci|babbage|aqa|live|native-audio|playai|distil)/i;

const modelCache = new Map<string, { at: number; models: string[] }>();
const MODEL_CACHE_MS = 15 * 60_000;

/* eslint-disable @typescript-eslint/no-explicit-any */
async function fetchModelIds(provider: ProviderId, token: string, timeoutMs: number): Promise<string[]> {
  const signal = AbortSignal.timeout(timeoutMs);
  if (provider === 'gemini') {
    const res = await fetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=200', { headers: { 'x-goog-api-key': token }, signal });
    if (!res.ok) throw new AiError(res.status, userMessageFor(res.status), `models HTTP ${res.status}`);
    const data = (await res.json()) as any;
    return (data?.models ?? [])
      .filter((m: any) => (m.supportedGenerationMethods ?? []).includes('generateContent'))
      .map((m: any) => String(m.name).replace(/^models\//, ''))
      .filter((id: string) => /^gemini/.test(id));
  }
  if (provider === 'anthropic') {
    const res = await fetch('https://api.anthropic.com/v1/models?limit=100', { headers: { 'x-api-key': token, 'anthropic-version': '2023-06-01' }, signal });
    if (!res.ok) throw new AiError(res.status, userMessageFor(res.status), `models HTTP ${res.status}`);
    const data = (await res.json()) as any;
    return (data?.data ?? []).map((m: any) => String(m.id));
  }
  const res = await fetch(`${PROVIDERS[provider].baseUrl}/models`, { headers: { Authorization: `Bearer ${token}` }, signal });
  if (!res.ok) throw new AiError(res.status, userMessageFor(res.status), `models HTTP ${res.status}`);
  const data = (await res.json()) as any;
  let list: any[] = data?.data ?? [];
  if (provider === 'groq') list = list.filter((m) => m.active !== false);
  if (provider === 'mistral') list = list.filter((m) => m.capabilities?.completion_chat !== false && !m.deprecation);
  let ids = list.map((m) => String(m.id));
  if (provider === 'openai') ids = ids.filter((id) => /^(gpt-|o\d|chatgpt)/.test(id));
  return ids;
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/** Упорядочивает: сначала известные нам модели, потом остальные (новые — по алфавиту с конца, т.е. свежие версии выше). */
export function rankModels(provider: ProviderId, ids: string[]): string[] {
  const chat = [...new Set(ids)].filter((id) => !NON_CHAT.test(id));
  const known = PROVIDERS[provider].models.filter((m) => chat.includes(m));
  const rest = chat.filter((m) => !known.includes(m)).sort((a, b) => b.localeCompare(a));
  return [...known, ...rest];
}

/**
 * Актуальные чат-модели, доступные этому токену (кэш 15 минут).
 * Для OpenRouter (сотни моделей) и при ошибке возвращает null — тогда меню покажет встроенные подсказки.
 */
// Таймаут небольшой: меню Discord должно ответить за 3 секунды. Результат кэшируется.
export async function listModels(provider: ProviderId, token: string, timeoutMs = 1500): Promise<string[] | null> {
  if (provider === 'openrouter') return null;
  const key = `${provider}:${token.slice(-12)}`;
  const cached = modelCache.get(key);
  if (cached && Date.now() - cached.at < MODEL_CACHE_MS) return cached.models;
  try {
    const models = rankModels(provider, await fetchModelIds(provider, token, timeoutMs));
    if (!models.length) return null;
    modelCache.set(key, { at: Date.now(), models });
    return models;
  } catch {
    return null;
  }
}

/** Проверка токена без расхода генерации (запрос списка моделей / информации о ключе). */
export async function verifyToken(provider: ProviderId, token: string): Promise<{ ok: boolean; message: string }> {
  let url: string;
  let headers: Record<string, string> = { Authorization: `Bearer ${token}` };
  if (provider === 'gemini') {
    url = 'https://generativelanguage.googleapis.com/v1beta/models?pageSize=1';
    headers = { 'x-goog-api-key': token };
  } else if (provider === 'anthropic') {
    url = 'https://api.anthropic.com/v1/models?limit=1';
    headers = { 'x-api-key': token, 'anthropic-version': '2023-06-01' };
  } else if (provider === 'openrouter') {
    url = 'https://openrouter.ai/api/v1/key';
  } else {
    url = `${PROVIDERS[provider].baseUrl}/models`;
  }
  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(20_000) });
    if (res.ok) return { ok: true, message: 'Токен действителен ✅' };
    return { ok: false, message: userMessageFor(res.status) };
  } catch {
    return { ok: false, message: 'Не удалось связаться с AI-провайдером (таймаут или нет сети).' };
  }
}
