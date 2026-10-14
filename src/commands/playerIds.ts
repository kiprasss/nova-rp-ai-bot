import { EmbedBuilder, MessageFlags, type ChatInputCommandInteraction } from 'discord.js';
import {
  MAX_IDS_PER_USER,
  addPlayerId,
  getGuild,
  getUserSettings,
  listPlayerIds,
  recentComplaintsFor,
  removePlayerId,
} from '../db/repo.js';
import { COLORS, audit } from '../discord/guildLog.js';
import { isGuildAdmin } from '../discord/permissions.js';
import { UserError } from '../util/errors.js';
import { truncate } from '../util/text.js';

export function normalizeGameId(raw: string): string | null {
  const v = raw.trim().replace(/^#/, '');
  return /^\d{1,7}$/.test(v) ? String(Number(v)) : null;
}

/** Текст со списком ID пользователя и последними жалобами на них. */
export function idsOverview(userId: string, guildId: string | null): string {
  const ids = listPlayerIds(userId);
  if (!ids.length) return 'У вас нет привязанных игровых ID. Добавьте: `/мой-id добавить id:12345`';
  const lines = ids.map((id) => {
    const recent = recentComplaintsFor(id, 3);
    const tail = recent.length
      ? '\n' + recent.map((c) => `   ↳ [${truncate(c.title, 60)}](${c.url}) — ${c.prefix ?? 'без статуса'}`).join('\n')
      : '';
    return `• **${id}**${tail}`;
  });
  const g = guildId ? getGuild(guildId) : undefined;
  const where = g?.complaints_channel_id ? `<#${g.complaints_channel_id}>` : 'канал #ai-жалобы на серверах, где он настроен';
  const dm = getUserSettings(userId).complaint_dm ? 'и в ЛС' : '(уведомления в ЛС выключены — /setupls → «Мои игровые ID»)';
  return `${lines.join('\n')}\n\n🔔 Уведомления о новых жалобах и смене их статуса: ${where} ${dm}. Проверка форума — каждые несколько минут.`;
}

export async function cmdPlayerIds(i: ChatInputCommandInteraction): Promise<void> {
  const sub = i.options.getSubcommand();
  const uid = i.user.id;

  if (sub === 'список') {
    await i.reply({ embeds: [new EmbedBuilder().setColor(COLORS.info).setTitle('🎮 Мои игровые ID').setDescription(idsOverview(uid, i.guildId))], flags: MessageFlags.Ephemeral });
    return;
  }

  const id = normalizeGameId(i.options.getString('id', true));
  if (!id) throw new UserError('Игровой ID — это только цифры (до 7), например 54321.');

  if (sub === 'добавить') {
    const res = addPlayerId(uid, id);
    if (res === 'taken') throw new UserError(`ID **${id}** уже привязан другим пользователем. Если это ваш ID — обратитесь к администрации сервера.`);
    if (res === 'limit') throw new UserError(`Можно привязать не больше ${MAX_IDS_PER_USER} ID. Удалите лишний: /мой-id удалить`);
    const head = res === 'exists' ? `ℹ️ ID **${id}** уже привязан к вам.` : `✅ ID **${id}** привязан.`;
    await i.reply({
      embeds: [new EmbedBuilder().setColor(COLORS.ok).setTitle('🎮 Мои игровые ID').setDescription(`${head}\n\n${idsOverview(uid, i.guildId)}`)],
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  // удалить: свой ID — всегда; чужой — только администратор сервера.
  if (removePlayerId(id, uid)) {
    await i.reply({ content: `🗑 ID **${id}** отвязан.\n\n${idsOverview(uid, i.guildId)}`, flags: MessageFlags.Ephemeral });
    return;
  }
  if (i.inCachedGuild() && isGuildAdmin(i.member) && removePlayerId(id, null)) {
    await audit(i.client, i.guild.id, uid, 'Отвязан чужой игровой ID', id);
    await i.reply({ content: `🗑 ID **${id}** отвязан (администратор).`, flags: MessageFlags.Ephemeral });
    return;
  }
  throw new UserError(`ID **${id}** не привязан к вам.`);
}
