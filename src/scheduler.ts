import type { Client } from 'discord.js';
import { DEFAULT_SOURCES, config } from './config.js';
import { GLOBAL_SCOPE, addSource, getMeta, listGuilds, listSources } from './db/repo.js';
import { dispatchRuleUpdates } from './discord/ruleUpdates.js';
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

export function startScheduler(client: Client): NodeJS.Timeout {
  setTimeout(() => tick(client), 15_000);
  return setInterval(() => tick(client), TICK_MS);
}
