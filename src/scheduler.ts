import type { Client } from 'discord.js';
import { DEFAULT_SOURCES, config } from './config.js';
import { GLOBAL_SCOPE, addSource, countPlayerIds, getMeta, listGuilds, listSources } from './db/repo.js';
import { dispatchComplaintAlerts } from './discord/complaintAlerts.js';
import { dispatchRuleUpdates } from './discord/ruleUpdates.js';
import { watchComplaints } from './forum/complaintWatch.js';
import { startRefresh } from './discord/settingsMenu.js';
import { isRefreshing, refreshScope } from './forum/refresh.js';
import { normalizeForumUrl } from './forum/url.js';
import { log } from './util/logger.js';

const TICK_MS = 10 * 60 * 1000;

/** Глобальная база для ЛС: стандартные источники NOVA RP. */
export function seedGlobalSources(): void {
  if (!config.seedGlobalSources || listSources(GLOBAL_SCOPE).length) return;
  for (const url of DEFAULT_SOURCES) {
    const n = normalizeForumUrl(url, config.forumBaseUrl);
    if (n) addSource(GLOBAL_SCOPE, n.url, n.kind, null);
  }
}

function tick(client: Client): void {
  const now = Date.now();
  for (const g of listGuilds()) {
    if (!client.guilds.cache.has(g.guild_id) || isRefreshing(g.guild_id)) continue;
    if (!listSources(g.guild_id).length) continue;
    const due = !g.last_refresh_at || now - g.last_refresh_at >= g.refresh_hours * 3600_000;
    if (due) startRefresh(client, g.guild_id, null);
  }
  if (config.seedGlobalSources && listSources(GLOBAL_SCOPE).length && !isRefreshing(GLOBAL_SCOPE)) {
    const last = Number(getMeta('global_last_refresh') ?? 0);
    if (now - last >= config.defaultRefreshHours * 3600_000) {
      refreshScope(GLOBAL_SCOPE)
        .then(() => dispatchRuleUpdates(client))
        .catch((err) => log.error('Ошибка обновления глобальной базы', err));
    }
  }
}

/** Жалобы проверяем, только если есть кого уведомлять: привязанные ID или настроенный канал #ai-жалобы. */
async function complaintTick(client: Client): Promise<void> {
  const needed = countPlayerIds() > 0 || listGuilds().some((g) => g.complaints_channel_id);
  if (!needed) return;
  try {
    await watchComplaints();
    await dispatchComplaintAlerts(client);
  } catch (err) {
    log.error('Ошибка проверки жалоб', err);
  }
}

export function startScheduler(client: Client): NodeJS.Timeout {
  setTimeout(() => tick(client), 15_000);
  setTimeout(() => void complaintTick(client), 30_000);
  setInterval(() => void complaintTick(client), config.complaintCheckMinutes * 60_000);
  return setInterval(() => tick(client), TICK_MS);
}
