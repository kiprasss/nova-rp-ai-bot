import type { Client, Guild } from 'discord.js';
import { aiErrorMessage, answerQuestion, type AskResult } from '../ai/answer.js';
import { AiError } from '../ai/providers.js';
import { config } from '../config.js';
import { QuestionRateLimiter } from '../util/rateLimit.js';
import { minutesText } from '../util/text.js';
import { logError } from './guildLog.js';
import { getUserSettings } from '../db/repo.js';
import { computePerms, fetchMember, findDmTokenGuild } from './permissions.js';
import { channelIdFor } from './setupGuild.js';

export const questionLimiter = new QuestionRateLimiter(config.cooldownSeconds * 1000, config.guildHourlyLimit);

export type Gate = { ok: true; guildId: string | null } | { ok: false; message: string };

/**
 * Проверяет право задать вопрос, канал и лимиты.
 * guild = null — ЛС (или пользовательская установка на сервере без бота).
 */
export async function gateQuestion(client: Client, guild: Guild | null, userId: string, channelId: string | null): Promise<Gate> {
  let scope = 'dm';
  let limit = config.dmHourlyLimit;
  let answerGuildId: string | null = guild?.id ?? null;
  if (!guild && !getUserSettings(userId).ai_token) {
    // ЛС без личного токена: используем AI-токен сервера, если роль это разрешает.
    // Тогда действуют лимиты, FAQ и источники этого сервера.
    const donor = await findDmTokenGuild(client, userId);
    if (donor) {
      scope = donor.guild.id;
      limit = donor.perms.hourlyLimit;
      answerGuildId = donor.guild.id;
    }
  }
  if (guild) {
    const member = await fetchMember(guild, userId);
    if (!member) return { ok: false, message: '⛔ Не удалось проверить ваши права на этом сервере.' };
    const perms = computePerms(member);
    if (!perms.canAsk) return { ok: false, message: '⛔ У вас нет доступа к AI-помощнику. Обратитесь к администрации сервера.' };
    const assistant = channelIdFor(guild.id, 'assistant');
    if (!perms.anyChannel && assistant && channelId !== assistant) {
      return { ok: false, message: `📍 Задавать вопросы AI можно только в канале <#${assistant}>.` };
    }
    scope = guild.id;
    limit = perms.hourlyLimit;
  }

  const d = questionLimiter.take(scope, userId, limit);
  if (!d.ok) {
    const wait = minutesText(d.retryAfterMs);
    if (d.reason === 'cooldown') return { ok: false, message: `⏳ Не так быстро! Подождите ${wait} перед следующим вопросом.` };
    if (d.reason === 'user') return { ok: false, message: `⏳ Лимит вопросов исчерпан (${limit} в час). Попробуйте через ${wait}.` };
    return { ok: false, message: `⏳ Сервер исчерпал лимит вопросов к AI на этот час. Попробуйте через ${wait}.` };
  }
  return { ok: true, guildId: answerGuildId };
}

/** Получает ответ; ошибки AI-провайдера превращает в понятный текст и пишет детали в #ai-логи. */
export async function askSafely(client: Client, guildId: string | null, userId: string, question: string): Promise<AskResult> {
  try {
    return await answerQuestion({ guildId, userId, question });
  } catch (err) {
    const friendly = aiErrorMessage(err);
    if (friendly) {
      await logError(client, guildId, 'Запрос к AI-провайдеру', err instanceof AiError ? `${err.status}: ${err.message}` : String(err), userId);
      return { kind: 'ai', text: friendly };
    }
    throw err;
  }
}
