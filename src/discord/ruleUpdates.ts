import { ChannelType, EmbedBuilder, type Client } from 'discord.js';
import {
  GLOBAL_SCOPE,
  docUrlsForScope,
  listGuilds,
  maxRuleEventId,
  pruneRuleEvents,
  ruleEventsBetween,
  updateGuild,
  type RuleEventRow,
} from '../db/repo.js';
import { log } from '../util/logger.js';
import { truncate } from '../util/text.js';

const COLOR = 0x0ea5e9;
const MAX_DESCRIPTION = 3900;
const RETENTION_MS = 30 * 24 * 3600_000;

const same = (a: string | null, b: string | null) =>
  (a ?? '').replace(/\s+/g, ' ').trim().toLowerCase() === (b ?? '').replace(/\s+/g, ' ').trim().toLowerCase();

function eventLine(e: RuleEventRow): string {
  switch (e.kind) {
    case 'added':
      return `🆕 **${e.point}** ${truncate(e.after_text ?? '', 300)}${e.after_punishment ? `\n> ⚖️ ${truncate(e.after_punishment, 200)}` : ''}`;
    case 'removed':
      return `🗑 **${e.point}** удалён: ~~${truncate(e.before_text ?? '', 150)}~~`;
    case 'new_doc':
      return `📄 Опубликована новая тема правил. ${e.after_text ?? ''}`;
    case 'changed': {
      const punishChanged = !same(e.before_punishment, e.after_punishment);
      if (same(e.before_text, e.after_text) && punishChanged) {
        return `✏️ **${e.point}** — изменено наказание:\n> было: ${truncate(e.before_punishment ?? 'не указано', 150)}\n> стало: **${truncate(e.after_punishment ?? 'не указано', 150)}**`;
      }
      return (
        `✏️ **${e.point}** изменён: ${truncate(e.after_text ?? '', 300)}` +
        (punishChanged ? `\n> ⚖️ было: ${truncate(e.before_punishment ?? 'не указано', 120)} → стало: **${truncate(e.after_punishment ?? 'не указано', 120)}**` : '')
      );
    }
  }
}

/** Группирует события по темам правил и превращает в embed'ы. */
export function buildRuleUpdateEmbeds(events: RuleEventRow[]): EmbedBuilder[] {
  const byDoc = new Map<string, RuleEventRow[]>();
  for (const e of events) byDoc.set(e.doc_url, [...(byDoc.get(e.doc_url) ?? []), e]);

  const embeds: EmbedBuilder[] = [];
  for (const [url, list] of byDoc) {
    const lines: string[] = [];
    let used = 0;
    let shown = 0;
    for (const e of list) {
      const line = eventLine(e);
      if (used + line.length + 2 > MAX_DESCRIPTION) break;
      lines.push(line);
      used += line.length + 2;
      shown++;
    }
    if (shown < list.length) lines.push(`…и ещё ${list.length - shown} изменений — смотрите тему на форуме.`);
    const counts = {
      added: list.filter((e) => e.kind === 'added').length,
      changed: list.filter((e) => e.kind === 'changed').length,
      removed: list.filter((e) => e.kind === 'removed').length,
    };
    const summary = [
      counts.added ? `новых: ${counts.added}` : '',
      counts.changed ? `изменено: ${counts.changed}` : '',
      counts.removed ? `удалено: ${counts.removed}` : '',
    ]
      .filter(Boolean)
      .join(' · ');
    embeds.push(
      new EmbedBuilder()
        .setColor(COLOR)
        .setTitle(truncate(`📜 Обновление правил: ${list[0].doc_title}`, 256))
        .setURL(url)
        .setDescription(lines.join('\n\n'))
        .setFooter({ text: `${summary ? `${summary} · ` : ''}forum.nova-rp.com` })
        .setTimestamp(list[list.length - 1].ts),
    );
  }
  return embeds;
}

let running = false;

/**
 * Рассылает новые изменения правил в каналы #ai-правила всех серверов.
 * Каждый сервер получает только изменения тем из своих источников; жалобы сюда не попадают.
 */
export async function dispatchRuleUpdates(client: Client): Promise<void> {
  if (running) return;
  running = true;
  try {
    const maxId = maxRuleEventId();
    for (const g of listGuilds()) {
      if (g.last_rule_event_id >= maxId) continue;
      const guild = client.guilds.cache.get(g.guild_id);
      if (!guild || !g.rules_channel_id) {
        updateGuild(g.guild_id, { last_rule_event_id: maxId });
        continue;
      }
      let allowed = docUrlsForScope(g.guild_id);
      if (!allowed.size) allowed = docUrlsForScope(GLOBAL_SCOPE);
      const events = ruleEventsBetween(g.last_rule_event_id, maxId).filter((e) => allowed.has(e.doc_url));
      if (events.length) {
        const channel = await guild.channels.fetch(g.rules_channel_id).catch(() => null);
        if (channel?.type !== ChannelType.GuildText && channel?.type !== ChannelType.GuildAnnouncement) {
          log.warn(`Канал #ai-правила сервера ${g.guild_id} недоступен`);
        } else {
          const embeds = buildRuleUpdateEmbeds(events);
          try {
            for (let i = 0; i < embeds.length; i += 10) await channel.send({ embeds: embeds.slice(i, i + 10) });
          } catch (err) {
            log.warn(`Не удалось отправить обновления правил на сервер ${g.guild_id}`, err);
            continue; // попробуем снова в следующий раз
          }
        }
      }
      updateGuild(g.guild_id, { last_rule_event_id: maxId });
    }
    pruneRuleEvents(RETENTION_MS);
  } finally {
    running = false;
  }
}
