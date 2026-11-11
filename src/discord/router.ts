import { ChannelType, DiscordAPIError, type Client, type Interaction, type Message } from 'discord.js';
import { getGuild } from '../db/repo.js';
import { truncate } from '../util/text.js';
import { onCleanButton } from '../commands/clean.js';
import { handleAutocomplete, handleCommand, onComplaintModal, onFaqSelect, onSetupButton } from '../commands/handlers.js';
import { UserError, errorDetails } from '../util/errors.js';
import { log } from '../util/logger.js';
import { askSafely, gateQuestion } from './ask.js';
import { handleDmInteraction } from './dmMenu.js';
import { logError } from './guildLog.js';
import { handleSettingsInteraction } from './settingsMenu.js';
import { channelIdFor } from './setupGuild.js';
import { replyText } from './ui.js';
import type { PreviousExchange } from '../ai/prompt.js';

/** Сколько после ответа бота следующее сообщение игрока считается возможным продолжением разговора. */
const FOLLOW_UP_MS = 10 * 60_000;

/**
 * Прошлый вопрос игрока и ответ бота: сообщение — ответ (reply) на сообщение бота
 * или последний ответ бота этому игроку в канале был недавно. Модель сама решает, продолжение это или новая тема.
 */
async function previousExchange(client: Client, message: Message): Promise<PreviousExchange | null> {
  const botId = client.user?.id;
  if (!botId) return null;
  try {
    let botMsg: Message | null = null;
    if (message.reference?.messageId) {
      const ref = await message.fetchReference().catch(() => null);
      if (ref?.author.id !== botId) return null;
      botMsg = ref;
    } else {
      const recent = await message.channel.messages.fetch({ limit: 10, before: message.id });
      botMsg =
        [...recent.values()].find(
          (m) => m.author.id === botId && m.mentions.repliedUser?.id === message.author.id,
        ) ?? null;
      if (!botMsg || message.createdTimestamp - botMsg.createdTimestamp > FOLLOW_UP_MS) return null;
    }
    if (!botMsg.reference?.messageId) return null;
    const q = await botMsg.fetchReference().catch(() => null);
    const question = q?.content.replace(/<@!?\d+>/g, '').trim();
    const answer = botMsg.content.replace(/\n+\*\*Источники:\*\*[\s\S]*$/, '').trim();
    return question && answer ? { question, answer } : null;
  } catch (err) {
    log.debug('Не удалось получить предыдущий вопрос', err);
    return null;
  }
}

const GENERIC_ERROR = '⚠️ Произошла внутренняя ошибка. Подробности переданы администрации, попробуйте позже.';

async function routeInteraction(i: Interaction): Promise<void> {
  if (i.isChatInputCommand()) return handleCommand(i);
  if (i.isAutocomplete()) {
    await handleAutocomplete(i).catch(() => i.respond([]).catch(() => undefined));
    return;
  }
  if (!i.isMessageComponent() && !i.isModalSubmit()) return;
  const prefix = i.customId.split(':')[0];
  switch (prefix) {
    case 'cfg':
      return handleSettingsInteraction(i);
    case 'dm':
      return handleDmInteraction(i);
    case 'setup':
      if (i.isButton()) return onSetupButton(i);
      return;
    case 'complaint':
      if (i.isModalSubmit()) return onComplaintModal(i);
      return;
    case 'faq':
      if (i.isStringSelectMenu()) return onFaqSelect(i);
      return;
    case 'clean':
      if (i.isButton()) return onCleanButton(i);
      return;
  }
}

export async function onInteraction(i: Interaction): Promise<void> {
  try {
    await routeInteraction(i);
  } catch (err) {
    if (!i.isRepliable()) return;
    if (err instanceof UserError) {
      await replyText(i, err.message);
      return;
    }
    // 40060 «already acknowledged» — почти всегда второй экземпляр бота ответил первым.
    // 10062 «Unknown interaction» — бот не успел ответить за 3 секунды (или тоже второй экземпляр).
    if (err instanceof DiscordAPIError && (err.code === 10062 || err.code === 40060)) {
      const where = i.isChatInputCommand() ? `/${i.commandName}` : 'customId' in i ? i.customId : 'взаимодействие';
      log.warn(
        err.code === 40060
          ? `Взаимодействие уже обработано другим экземпляром (${where}). Похоже, бот запущен дважды — оставьте только один.`
          : `Взаимодействие истекло (${where}): ответ занял больше 3 секунд. Если повторяется на разных кнопках — проверьте, не запущен ли бот дважды.`,
      );
      return;
    }
    const where = i.isChatInputCommand() ? `/${i.commandName}` : 'customId' in i ? `компонент ${i.customId}` : 'взаимодействие';
    await logError(i.client, i.guildId, where, errorDetails(err), i.user.id);
    await replyText(i, GENERIC_ERROR);
  }
}

/** Вопросы обычными сообщениями: в ЛС, в #ai-помощник и по упоминанию бота (если разрешён любой канал). */
export async function onMessage(client: Client, message: Message): Promise<void> {
  if (message.author.bot || message.system) return;
  const content = message.content.trim();
  if (!content) return;

  try {
    if (!message.inGuild()) {
      if (content.startsWith('/')) return;
      const gate = await gateQuestion(client, null, message.author.id, null);
      if (!gate.ok) {
        await message.reply(gate.message);
        return;
      }
      if ('sendTyping' in message.channel) await message.channel.sendTyping().catch(() => undefined);
      const res = await askSafely(client, null, message.author.id, content, await previousExchange(client, message));
      await message.reply({ content: res.text, allowedMentions: { repliedUser: false, parse: [] } });
      return;
    }

    const g = getGuild(message.guildId);
    const isAssistant = message.channelId === channelIdFor(message.guildId, 'assistant');
    const mentioned = client.user ? message.mentions.users.has(client.user.id) : false;
    // «Автоответ» выключен — в #ai-помощник бот отвечает только на упоминание (и на /вопрос).
    if (!mentioned && (!isAssistant || g?.ai_auto_reply === 0)) return;
    const question = content.replace(/<@!?\d+>/g, '').trim();
    if (question.length < 3) return;

    const gate = await gateQuestion(client, message.guild, message.author.id, message.channelId);
    if (!gate.ok) {
      // В чужих каналах на упоминание без прав молчим, чтобы не спамить.
      if (isAssistant || !gate.message.startsWith('📍')) {
        const reply = await message.reply({ content: gate.message, allowedMentions: { repliedUser: false } });
        setTimeout(() => reply.delete().catch(() => undefined), 15_000);
      }
      return;
    }
    // «Ответ в ветке»: под каждым вопросом создаётся ветка — основной канал остаётся чистым.
    if (g?.ai_threads === 1 && message.channel.type === ChannelType.GuildText) {
      const thread = await message
        .startThread({ name: truncate(question.replace(/\s+/g, ' '), 90), autoArchiveDuration: 60 })
        .catch(() => null);
      if (thread) {
        await thread.sendTyping().catch(() => undefined);
        const res = await askSafely(client, gate.guildId, message.author.id, question);
        await thread.send({ content: res.text, allowedMentions: { parse: [] } });
        return;
      }
    }
    await message.channel.sendTyping().catch(() => undefined);
    const res = await askSafely(client, gate.guildId, message.author.id, question, await previousExchange(client, message));
    await message.reply({ content: res.text, allowedMentions: { repliedUser: false, parse: [] } });
  } catch (err) {
    await logError(client, message.guildId, 'Сообщение-вопрос', errorDetails(err), message.author.id);
    await message.reply('⚠️ Не удалось получить ответ. Попробуйте позже.').catch(() => undefined);
  }
}
