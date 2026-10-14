import { ChannelType, EmbedBuilder, type BaseMessageOptions, type Client } from 'discord.js';
import {
  complaintEventsBetween,
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
export function buildComplaintAlert(e: ComplaintEventRow, userId: string, mention = true): BaseMessageOptions {
  const isNew = e.kind === 'new';
  const embed = new EmbedBuilder()
    .setColor(isNew ? 0xef4444 : 0xf59e0b)
    .setTitle(isNew ? '🚨 На форуме подана жалоба на ваш игровой ID' : '📋 Изменился статус жалобы на ваш игровой ID')
    .setURL(e.url)
    .addFields(
      { name: 'Тема', value: `[${truncate(e.title, 200)}](${e.url})` },
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
