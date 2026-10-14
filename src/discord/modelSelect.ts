import { StringSelectMenuBuilder } from 'discord.js';
import { listModels, promptStyleFor, type ProviderInfo } from '../ai/providers.js';
import { secrets } from '../crypto.js';
import { truncate } from '../util/text.js';

export const CUSTOM_MODEL = '__custom';

const STYLE_LABELS = {
  standard: 'универсальный',
  claude: 'XML-структура для Claude',
  gemini: 'краткий для Gemini',
  compact: 'упрощённый для открытых моделей',
} as const;

export function promptStyleLabel(provider: ProviderInfo, model: string | null): string {
  return STYLE_LABELS[promptStyleFor(provider.id, model || provider.defaultModel)];
}

/** Актуальные модели провайдера по сохранённому (зашифрованному) токену; null — показать встроенные подсказки. */
export async function liveModels(provider: ProviderInfo, encryptedToken: string | null): Promise<string[] | null> {
  if (!encryptedToken) return null;
  try {
    return await listModels(provider.id, secrets.decrypt(encryptedToken));
  } catch {
    return null;
  }
}

/**
 * Меню выбора модели. Если удалось получить список у провайдера — показываем только реально
 * доступные модели (выбранная, но исчезнувшая модель помечается ⚠️), иначе — встроенные подсказки.
 */
export function modelSelect(customId: string, provider: ProviderInfo, current: string | null, live: string[] | null): StringSelectMenuBuilder {
  const active = current || provider.defaultModel;
  const base = live ?? provider.models;
  const missing = !base.includes(active);
  const models = (missing ? [active, ...base] : base).slice(0, 24);
  return new StringSelectMenuBuilder()
    .setCustomId(customId)
    .setPlaceholder(live ? 'Выберите модель (список от провайдера)…' : 'Выберите модель…')
    .addOptions(
      ...models.map((m) => ({
        label: truncate(m, 100),
        value: m,
        emoji: m === active && missing && live ? '⚠️' : undefined,
        description:
          m === active && missing && live
            ? 'Недоступна у провайдера — выберите другую'
            : m === provider.defaultModel
              ? 'по умолчанию'
              : undefined,
        default: m === active,
      })),
      { label: 'Другая модель…', value: CUSTOM_MODEL, emoji: '✏️', description: 'Ввести название вручную' },
    );
}
