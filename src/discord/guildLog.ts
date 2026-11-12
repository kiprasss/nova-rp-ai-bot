import { EmbedBuilder, type Client } from 'discord.js';
import type { AskResult } from '../ai/answer.js';
import { addAudit, getGuild } from '../db/repo.js';
import { log } from '../util/logger.js';
import { truncate } from '../util/text.js';

export const COLORS = {
  info: 0x3b82f6,
  ok: 0x22c55e,
  warn: 0xf59e0b,
  error: 0xef4444,
  audit: 0x8b5cf6,
} as const;

/** Отправляет embed в #ai-логи сервера (если канал настроен). Ошибки отправки только пишутся в консоль. */
export async function logToGuild(client: Client, guildId: string | null, embed: EmbedBuilder): Promise<void> {
  if (!guildId) return;
  const channelId = getGuild(guildId)?.logs_channel_id;
  if (!channelId) return;
  try {
    const channel = await client.channels.fetch(channelId);
    if (channel?.isSendable()) await channel.send({ embeds: [embed.setTimestamp()] });
  } catch (err) {
    log.warn(`Не удалось записать в #ai-логи сервера ${guildId}`, err);
  }
}

export async function logError(client: Client, guildId: string | null, where: string, details: string, userId?: string) {
  log.error(`[${guildId ?? 'DM'}] ${where}: ${details}`);
  await logToGuild(
    client,
    guildId,
    new EmbedBuilder()
      .setColor(COLORS.error)
      .setTitle('⚠️ Ошибка')
      .setDescription(`**Где:** ${where}${userId ? `\n**Пользователь:** <@${userId}>` : ''}\n\`\`\`\n${truncate(details, 3500)}\n\`\`\``),
  );
}

/** Журнал изменений настроек: БД + #ai-логи. Секреты сюда не передаются. */
export async function audit(client: Client, guildId: string, userId: string, action: string, details?: string) {
  addAudit(guildId, userId, action, details ?? null);
  log.info(`[audit ${guildId}] ${userId}: ${action}${details ? ` — ${details}` : ''}`);
  await logToGuild(
    client,
    guildId,
    new EmbedBuilder()
      .setColor(COLORS.audit)
      .setTitle('🛠 Изменение настроек')
      .setDescription(`<@${userId}> — **${action}**${details ? `\n${truncate(details, 1500)}` : ''}`),
  );
}

/**
 * «Ход мыслей» бота в #ai-логи: вопрос, поисковый запрос, фрагменты форума и черновик модели (<analysis>).
 * Помогает администрации понять, почему бот ответил именно так. Только для ответов AI (не FAQ/ошибок).
 */
export async function logAnswerTrace(
  client: Client,
  guildId: string | null,
  userId: string,
  question: string,
  res: AskResult,
  replyUrl?: string,
): Promise<void> {
  if (!guildId || res.kind !== 'ai' || !res.fragments) return;
  const frags = res.fragments.map((f) => `[${f.n}] ${truncate(f.title, 70)}`).join('\n') || '—';
  const parts = [
    `**Игрок:** <@${userId}>${replyUrl ? ` · [ответ](${replyUrl})` : ''}${res.model ? ` · ${res.model}` : ''}`,
    `**Вопрос:** ${truncate(question.replace(/\s+/g, ' '), 300)}`,
    `**Поиск:** ${truncate(res.rewritten ?? '(без AI-переписывания)', 300)}`,
    `**Фрагменты:**\n${truncate(frags, 900)}`,
    `**Черновик модели:**\n${res.analysis ? truncate(res.analysis, 2300) : '(модель не написала черновик)'}`,
  ];
  await logToGuild(
    client,
    guildId,
    new EmbedBuilder().setColor(COLORS.info).setTitle('🧠 Ход мыслей бота').setDescription(truncate(parts.join('\n\n'), 4000)),
  );
}
