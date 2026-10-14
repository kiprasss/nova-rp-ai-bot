import { ChannelType, EmbedBuilder, type BaseMessageOptions, type Client } from 'discord.js';
import {
  complaintEventsBetween,
  getComplaintThread,
  getUserSettings,
  listGuilds,
  markComplaintEventDm,
  maxComplaintEventId,
  ownerOfGameId,
  pendingDmComplaintEvents,
  pruneComplaintEvents,
  updateGuild,
  type ComplaintEventRow,
} from '../db/repo.js';
import { log } from '../util/logger.js';
import { truncate } from '../util/text.js';
import { fetchMember } from './permissions.js';

const RETENTION_MS = 30 * 24 * 3600_000;

/** Сообщение о жалобе с упоминанием владельца игрового ID. */
const ALERT_TITLES: Record<ComplaintEventRow['kind'], string> = {
  new: '🚨 На форуме подана жалоба на ваш игровой ID',
  status: '📋 Изменился статус жалобы на ваш игровой ID',
  existing: '📂 На форуме есть жалоба на ваш игровой ID',
};

export function buildComplaintAlert(e: ComplaintEventRow, userId: string, mention = true): BaseMessageOptions {
  const thread = getComplaintThread(e.url);
  const embed = new EmbedBuilder()
    .setColor(e.kind === 'new' ? 0xef4444 : e.kind === 'status' ? 0xf59e0b : 0x3b82f6)
    .setTitle(ALERT_TITLES[e.kind])
    .setURL(e.url)
    .addFields(
      { name: 'Тема', value: `[${truncate(e.title, 200)}](${e.url})` },
      { name: 'Кто подал', value: thread?.author ?? 'не указано', inline: true },
      { name: 'На кого (ник в жалобе)', value: thread?.offender_nick ?? 'не указан', inline: true },
      { name: 'Игровой ID', value: e.offender_id, inline: true },
      { name: 'Статус', value: e.prefix ?? 'не указан', inline: true },
    )
    .setFooter({ text: 'Ознакомьтесь с жалобой и правилами раздела. Управление ID: /мой-id' })
    .setTimestamp(e.ts);
  return {
    content: mention ? `<@${userId}>` : undefined,
    embeds: [embed],
    allowedMentions: { users: mention ? [userId] : [] },
  };
}

let running = false;

/**
 * Рассылает события жалоб: в канал #ai-жалобы каждого сервера (если владелец ID — участник)
 * и в ЛС владельцу, если он не отключил это в /setupls.
 */
export async function dispatchComplaintAlerts(client: Client): Promise<void> {
  if (running) return;
  running = true;
  try {
    const maxId = maxComplaintEventId();
    for (const g of listGuilds()) {
      if (g.last_complaint_event_id >= maxId) continue;
      const guild = client.guilds.cache.get(g.guild_id);
      const events = complaintEventsBetween(g.last_complaint_event_id, maxId);
      if (guild && g.complaints_channel_id && events.length) {
        const channel = await guild.channels.fetch(g.complaints_channel_id).catch(() => null);
        if (channel?.type === ChannelType.GuildText) {
          let failed = false;
          for (const e of events) {
            const owner = ownerOfGameId(e.offender_id);
            if (!owner || !(await fetchMember(guild, owner))) continue;
            try {
              await channel.send(buildComplaintAlert(e, owner));
            } catch (err) {
              log.warn(`Не удалось отправить уведомление о жалобе на сервер ${g.guild_id}`, err);
              failed = true;
              break;
            }
          }
          if (failed) continue; // повторим в следующий раз
        }
      }
      updateGuild(g.guild_id, { last_complaint_event_id: maxId });
    }

    for (const e of pendingDmComplaintEvents()) {
      const owner = ownerOfGameId(e.offender_id);
      if (owner && getUserSettings(owner).complaint_dm) {
        try {
          const user = await client.users.fetch(owner);
          await user.send(buildComplaintAlert(e, owner, false));
        } catch {
          // ЛС закрыты — ничего страшного, уведомление есть в канале
        }
      }
      markComplaintEventDm(e.id);
    }
    pruneComplaintEvents(RETENTION_MS);
  } finally {
    running = false;
  }
}
