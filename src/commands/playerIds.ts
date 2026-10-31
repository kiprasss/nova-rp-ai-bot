import { EmbedBuilder, MessageFlags, type ChatInputCommandInteraction } from 'discord.js';
import {
  addPlayerId,
  getGuild,
  getUserSettings,
  listPlayerIds,
  recentComplaintsFor,
  removePlayerId,
} from '../db/repo.js';
import { dispatchComplaintAlerts } from '../discord/complaintAlerts.js';
import { COLORS, audit } from '../discord/guildLog.js';
import { lastComplaintCheckAt, queueExistingComplaints, watchComplaints } from '../forum/complaintWatch.js';
import { isGuildAdmin, playerIdLimit } from '../discord/permissions.js';
import { UserError } from '../util/errors.js';
import { log } from '../util/logger.js';
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
      ? '\n' + recent.map((c) => `   ↳ [${truncate(c.title, 60)}](${c.url}) — ${c.prefix ?? 'без статуса'}${c.author ? `, подал: ${c.author}` : ''}`).join('\n')
      : '';
    return `• **${id}**${tail}`;
  });
  const g = guildId ? getGuild(guildId) : undefined;
  const where = g?.complaints_channel_id ? `<#${g.complaints_channel_id}>` : 'канал #ai-жалобы на серверах, где он настроен';
  const dm = getUserSettings(userId).complaint_dm ? 'и в ЛС' : '(уведомления в ЛС выключены — /setupls → «Мои игровые ID»)';
  return `${lines.join('\n')}\n\n🔔 Уведомления о новых жалобах и смене их статуса: ${where} ${dm}. Проверка форума — каждые несколько минут.`;
}

const CHECK_COOLDOWN_MS = 2 * 60_000;
/** Сколько ждать результата проверки, прежде чем ответить «идёт в фоне». */
const CHECK_WAIT_MS = 45_000;

function overviewEmbed(userId: string, guildId: string | null, note: string): EmbedBuilder {
  return new EmbedBuilder().setColor(COLORS.info).setTitle('🎮 Мои игровые ID').setDescription(`${note}\n\n${idsOverview(userId, guildId)}`);
}

export async function cmdPlayerIds(i: ChatInputCommandInteraction): Promise<void> {
  const sub = i.options.getSubcommand();
  const uid = i.user.id;

  if (sub === 'список') {
    await i.reply({ embeds: [new EmbedBuilder().setColor(COLORS.info).setTitle('🎮 Мои игровые ID').setDescription(idsOverview(uid, i.guildId))], flags: MessageFlags.Ephemeral });
    return;
  }

  if (sub === 'проверить') {
    if (!listPlayerIds(uid).length) throw new UserError('Сначала привяжите ID: `/мой-id добавить id:12345`');
    let note: string;
    if (Date.now() - lastComplaintCheckAt() < CHECK_COOLDOWN_MS) {
      note = 'ℹ️ Форум проверялся меньше 2 минут назад — показываю последние данные.';
      await i.reply({ embeds: [overviewEmbed(uid, i.guildId, note)], flags: MessageFlags.Ephemeral });
      return;
    }
    await i.deferReply({ flags: MessageFlags.Ephemeral });
    // Первый проход (или занятый форум) может идти несколько минут — не держим пользователя.
    const check = watchComplaints().then(async (r) => {
      await dispatchComplaintAlerts(i.client).catch(() => undefined);
      return r;
    });
    const res = await Promise.race([check, new Promise<null>((r) => setTimeout(() => r(null), CHECK_WAIT_MS))]);
    if (!res) {
      check.catch((err) => log.warn('Проверка жалоб не удалась', err));
      note = '⏳ Проверка форума идёт в фоне (первая проверка просматривает несколько страниц и занимает пару минут). Если найдутся жалобы на ваши ID — бот сообщит в #ai-жалобы и в ЛС.';
      await i.editReply({ embeds: [overviewEmbed(uid, i.guildId, note)] });
      return;
    }
    note = res.blocked
      ? '⚠️ Форум сейчас закрыт защитой от ботов — проверить не удалось. Ниже — ранее найденные данные.'
      : `🔄 Форум проверен: просмотрено тем ${res.scanned}, новых событий ${res.events}.`;
    await i.editReply({ embeds: [overviewEmbed(uid, i.guildId, note)] });
    return;
  }

  const id = normalizeGameId(i.options.getString('id', true));
  if (!id) throw new UserError('Игровой ID — это только цифры (до 7), например 54321.');

  if (sub === 'добавить') {
    const limit = await playerIdLimit(i.client, uid);
    const res = addPlayerId(uid, id, limit);
    if (res === 'taken') throw new UserError(`ID **${id}** уже привязан другим пользователем. Если это ваш ID — обратитесь к администрации сервера.`);
    if (res === 'limit') throw new UserError(`Можно привязать не больше ${limit} ID. Удалите лишний: /мой-id удалить`);
    let head = res === 'exists' ? `ℹ️ ID **${id}** уже привязан к вам.` : `✅ ID **${id}** привязан.`;
    if (res === 'ok') {
      // Уже существующие жалобы на этот ID — сразу в #ai-жалобы и в ЛС (удобно и для проверки работы).
      const found = queueExistingComplaints(id);
      if (found) {
        head += `\n📂 Найдено уже существующих жалоб: **${found}** — уведомления отправлены.`;
        void dispatchComplaintAlerts(i.client).catch(() => undefined);
      } else {
        head += '\nСуществующих жалоб на этот ID среди просмотренных тем нет.';
      }
    }
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
