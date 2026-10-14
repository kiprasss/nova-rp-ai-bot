import {
  ButtonStyle,
  ChannelType,
  EmbedBuilder,
  MessageFlags,
  PermissionFlagsBits,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type GuildTextBasedChannel,
  type Message,
  type TextBasedChannel,
} from 'discord.js';
import { getGuild, updateGuild } from '../db/repo.js';
import { COLORS, audit } from '../discord/guildLog.js';
import { button, row } from '../discord/ui.js';
import { UserError } from '../util/errors.js';

const DEFAULT_COUNT = 100;
/** Сколько сообщений максимум просматриваем в поисках сообщений бота. */
const SCAN_LIMIT = 2000;
/** Discord не даёт массово удалять сообщения старше 14 дней. */
const BULK_MAX_AGE = 14 * 24 * 3600_000 - 60_000;

export interface CleanResult {
  deleted: number;
  kept: number;
}

/**
 * Можно ли удалить сообщение: только сообщения самого бота и только «обычные» ответы.
 * Не трогаем меню и всё с кнопками/списками (панель настроек, /setupls, FAQ), закреплённые
 * и служебные сообщения (обновления правил, журнал, ошибки).
 */
export function isDeletableBotMessage(m: Pick<Message, 'author' | 'pinned' | 'components' | 'embeds' | 'id'>, botId: string, keepIds: Set<string>): boolean {
  if (m.author.id !== botId) return false;
  if (m.pinned || keepIds.has(m.id)) return false;
  if (m.components.length > 0) return false;
  const title = m.embeds[0]?.title ?? '';
  if (/^(📜 Обновление правил|🛠 Изменение настроек|⚠️ Ошибка|🔄 База знаний|❌ Ошибка|⚙️ Панель управления|🤖 NOVA RP AI)/u.test(title)) return false;
  return true;
}

/** Удаляет до `count` последних сообщений бота в канале (сервер или ЛС). */
export async function cleanBotMessages(
  channel: TextBasedChannel,
  botId: string,
  count: number,
  keepIds: Set<string>,
  canBulk: boolean,
): Promise<CleanResult> {
  const res: CleanResult = { deleted: 0, kept: 0 };
  const cutoff = Date.now() - BULK_MAX_AGE;
  let before: string | undefined;
  let scanned = 0;
  while (res.deleted < count && scanned < SCAN_LIMIT) {
    const batch = await channel.messages.fetch({ limit: 100, before });
    if (!batch.size) break;
    scanned += batch.size;
    before = batch.last()?.id;
    const take: Message[] = [];
    for (const m of batch.values()) {
      if (m.author.id !== botId) continue;
      if (!isDeletableBotMessage(m, botId, keepIds)) {
        res.kept++;
        continue;
      }
      if (take.length < count - res.deleted) take.push(m);
    }
    const fresh = take.filter((m) => m.createdTimestamp > cutoff);
    if (canBulk && fresh.length > 1 && 'bulkDelete' in channel) {
      await (channel as GuildTextBasedChannel).bulkDelete(fresh.map((m) => m.id), true);
      for (const m of take.filter((x) => x.createdTimestamp <= cutoff)) await m.delete().catch(() => undefined);
    } else {
      for (const m of take) await m.delete().catch(() => undefined);
    }
    res.deleted += take.length;
    if (batch.size < 100) break;
  }
  return res;
}

function resultText(res: CleanResult, where: string): string {
  const kept = res.kept ? `\nОставлено важных сообщений бота (меню, обновления правил, журнал, закреплённые): **${res.kept}**.` : '';
  return res.deleted ? `🧹 Удалено сообщений бота ${where}: **${res.deleted}**.${kept}` : `🧹 Сообщений бота для удаления ${where} не найдено.${kept}`;
}

/** «123…» или «https://discord.com/channels/<сервер|@me>/<канал>/<сообщение>». */
export function parseMessageRef(input: string): { channelId: string | null; messageId: string } | null {
  const link = input.trim().match(/discord(?:app)?\.com\/channels\/(?:\d+|@me)\/(\d+)\/(\d+)/);
  if (link) return { channelId: link[1], messageId: link[2] };
  const id = input.trim().match(/^\d{17,20}$/);
  return id ? { channelId: null, messageId: id[0] } : null;
}

/** Удаление одного конкретного сообщения по ID/ссылке — без защиты меню и служебных сообщений. */
async function cleanSingle(i: ChatInputCommandInteraction, raw: string): Promise<void> {
  const ref = parseMessageRef(raw);
  if (!ref) throw new UserError('Укажите ID сообщения (ПКМ по сообщению → «Копировать ID сообщения») или ссылку на него.');
  const botId = i.client.user.id;

  if (!i.inGuild()) {
    const dm = await i.user.createDM();
    const msg = await dm.messages.fetch(ref.messageId).catch(() => null);
    if (!msg) throw new UserError('Сообщение не найдено в ЛС с ботом.');
    if (msg.author.id !== botId) throw new UserError('В ЛС бот может удалять только свои сообщения — своё сообщение удалите сами.');
    await msg.delete();
    await i.reply({ content: '🗑 Сообщение бота удалено.', flags: MessageFlags.Ephemeral });
    return;
  }

  if (!i.inCachedGuild()) throw new UserError('Бот не добавлен на этот сервер.');
  const channelId = ref.channelId ?? i.options.getChannel('канал')?.id ?? i.channelId;
  const channel = await i.guild.channels.fetch(channelId).catch(() => null);
  if (!channel || channel.type === ChannelType.GuildCategory || !channel.isTextBased()) {
    throw new UserError('Канал сообщения не найден. Укажите ссылку на сообщение или выберите канал в параметре «канал».');
  }
  if (!channel.permissionsFor(i.member).has(PermissionFlagsBits.ManageMessages)) {
    throw new UserError('⛔ Нужно право «Управлять сообщениями» в этом канале.');
  }
  const msg = await channel.messages.fetch(ref.messageId).catch(() => null);
  if (!msg) throw new UserError(`Сообщение не найдено в <#${channel.id}>.`);
  const me = i.guild.members.me;
  if (msg.author.id !== botId && !(me && channel.permissionsFor(me).has(PermissionFlagsBits.ManageMessages))) {
    throw new UserError('⛔ Это чужое сообщение, а у бота нет права «Управлять сообщениями» в этом канале.');
  }
  await msg.delete();
  let note = '';
  const g = getGuild(i.guild.id);
  if (g?.settings_message_id === msg.id) {
    updateGuild(i.guild.id, { settings_message_id: null });
    note = '\nЭто было меню настроек — восстановить: /setup → «Восстановить недостающее».';
  }
  await audit(i.client, i.guild.id, i.user.id, 'Удалено сообщение', `<#${channel.id}> · ID ${msg.id} · автор <@${msg.author.id}>`);
  await i.reply({ content: `🗑 Сообщение удалено из <#${channel.id}>.${note}`, flags: MessageFlags.Ephemeral });
}

export async function cmdClean(i: ChatInputCommandInteraction): Promise<void> {
  const single = i.options.getString('сообщение');
  if (single) return cleanSingle(i, single);
  const count = i.options.getInteger('количество') ?? DEFAULT_COUNT;
  const botId = i.client.user.id;

  // ЛС: удаляем только ответы бота, меню /setupls остаются.
  if (!i.inGuild()) {
    await i.deferReply({ flags: MessageFlags.Ephemeral });
    const dm = await i.user.createDM();
    const res = await cleanBotMessages(dm, botId, count, new Set(), false);
    await i.editReply(resultText(res, 'в ЛС') + '\nСвои сообщения в ЛС Discord не позволяет удалять ботам.');
    return;
  }

  if (!i.inCachedGuild()) throw new UserError('Бот не добавлен на этот сервер.');
  const channel = (i.options.getChannel('канал') ?? i.channel) as GuildTextBasedChannel | null;
  if (!channel || !channel.isTextBased()) throw new UserError('Выберите текстовый канал.');
  const g = getGuild(i.guild.id);
  if (channel.id === g?.logs_channel_id || channel.id === g?.rules_channel_id) {
    throw new UserError('🛡 Этот канал защищён: журнал (#ai-логи) и обновления правил (#ai-правила) не очищаются.');
  }
  if (!channel.permissionsFor(i.member).has(PermissionFlagsBits.ManageMessages)) {
    throw new UserError('⛔ Для очистки нужно право «Управлять сообщениями» в этом канале.');
  }
  const me = i.guild.members.me;
  if (!me || !channel.permissionsFor(me).has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory])) {
    throw new UserError(`⛔ Бот не видит историю сообщений в <#${channel.id}>.`);
  }

  const embed = new EmbedBuilder()
    .setColor(COLORS.warn)
    .setTitle('🧹 Очистка сообщений бота')
    .setDescription(
      `Удалить до **${count}** последних **сообщений бота** в <#${channel.id}>?\n\n` +
        '• Сообщения участников не удаляются.\n' +
        '• Меню настроек, сообщения с кнопками, закреплённые, обновления правил и журнал остаются.\n' +
        '**Действие нельзя отменить.**',
    );
  await i.reply({
    embeds: [embed],
    components: [
      row(
        button(`clean:yes:${channel.id}:${count}`, 'Да, удалить', ButtonStyle.Danger, '🧹'),
        button('clean:no', 'Отмена', ButtonStyle.Secondary, '✖️'),
      ),
    ],
    flags: MessageFlags.Ephemeral,
  });
}

export async function onCleanButton(i: ButtonInteraction): Promise<void> {
  const [, op, channelId, countRaw] = i.customId.split(':');
  if (op === 'no') {
    await i.update({ content: 'Очистка отменена.', embeds: [], components: [] });
    return;
  }
  if (!i.inCachedGuild()) throw new UserError('Кнопка работает только на сервере.');
  const channel = await i.guild.channels.fetch(channelId).catch(() => null);
  if (!channel || channel.type === ChannelType.GuildCategory || !channel.isTextBased()) throw new UserError('Канал не найден.');
  // Права перепроверяем в момент нажатия.
  const member = await i.guild.members.fetch({ user: i.user.id, force: true });
  if (!channel.permissionsFor(member).has(PermissionFlagsBits.ManageMessages)) {
    throw new UserError('⛔ Для очистки нужно право «Управлять сообщениями» в этом канале.');
  }
  await i.update({ content: '⏳ Удаляю сообщения бота…', embeds: [], components: [] });
  const keep = new Set<string>();
  const menuId = getGuild(i.guild.id)?.settings_message_id;
  if (menuId) keep.add(menuId);
  const me = i.guild.members.me;
  const canBulk = !!me && channel.permissionsFor(me).has(PermissionFlagsBits.ManageMessages);
  const count = Math.min(Math.max(Number(countRaw) || DEFAULT_COUNT, 1), 1000);
  const res = await cleanBotMessages(channel, i.client.user.id, count, keep, canBulk);
  await audit(i.client, i.guild.id, i.user.id, 'Очистка сообщений бота', `<#${channel.id}>: удалено ${res.deleted}`);
  await i.editReply({ content: resultText(res, `в <#${channel.id}>`) });
}
