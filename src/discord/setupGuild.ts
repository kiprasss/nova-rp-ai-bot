import {
  ChannelType,
  PermissionFlagsBits,
  type CategoryChannel,
  type Client,
  type Guild,
  type OverwriteResolvable,
  type TextChannel,
} from 'discord.js';
import { DEFAULT_SOURCES, config } from '../config.js';
import {
  addSource,
  ensureGuildRow,
  getGuild,
  getRolePerms,
  listSources,
  maxRuleEventId,
  newRolePerm,
  updateGuild,
  upsertRolePerm,
} from '../db/repo.js';
import { normalizeForumUrl } from '../forum/url.js';
import { UserError } from '../util/errors.js';
import { log } from '../util/logger.js';
import { buildMainMenu } from './mainMenu.js';

export const CATEGORY_NAME = 'NOVA RP AI';
export const CHANNEL_NAMES = {
  assistant: 'ai-помощник',
  settings: 'ai-настройки',
  logs: 'ai-логи',
  rules: 'ai-правила',
} as const;
export type Purpose = keyof typeof CHANNEL_NAMES;
export const PURPOSES: Purpose[] = ['assistant', 'rules', 'settings', 'logs'];

export const PURPOSE_LABELS: Record<Purpose, string> = {
  assistant: '#ai-помощник — вопросы AI',
  rules: '#ai-правила — обновления правил',
  settings: '#ai-настройки — меню администраторов',
  logs: '#ai-логи — ошибки и журнал изменений',
};

const TOPICS: Record<Purpose, string> = {
  assistant: 'Задайте вопрос о NOVA RP — AI ответит по данным форума forum.grand-rp.su. Команды: /помощь',
  rules: 'Автоматические уведомления об изменениях правил NOVA RP с форума (только правила, без жалоб)',
  settings: 'Панель управления ботом NOVA RP AI (видна только администраторам)',
  logs: 'Ошибки бота и журнал изменений настроек',
};

const PURPOSE_COLUMN = {
  assistant: 'assistant_channel_id',
  rules: 'rules_channel_id',
  settings: 'settings_channel_id',
  logs: 'logs_channel_id',
} as const;

export function channelIdFor(guildId: string, purpose: Purpose): string | null {
  const g = getGuild(guildId);
  return g ? g[PURPOSE_COLUMN[purpose]] : null;
}

export function setChannelFor(guildId: string, purpose: Purpose, channelId: string): void {
  if (channelIdFor(guildId, purpose) === channelId) return;
  // Новые каналы уведомлений начинают с текущего момента — без старых событий.
  const patch = purpose === 'rules' ? { last_rule_event_id: maxRuleEventId() } : {};
  updateGuild(guildId, { [PURPOSE_COLUMN[purpose]]: channelId, ...patch });
}

/** Канал обновлений правил: все читают, пишет только бот. */
function readOnlyOverwrites(client: Client, guild: Guild): OverwriteResolvable[] {
  return [
    { id: guild.roles.everyone.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory], deny: [PermissionFlagsBits.SendMessages] },
    botOverwrite(client),
  ];
}

export interface SetupInspection {
  isNew: boolean;
  category: CategoryChannel | null;
  channels: Record<Purpose, TextChannel | null>;
  menuOk: boolean;
  missing: string[];
}

async function findCategory(guild: Guild): Promise<CategoryChannel | null> {
  const stored = getGuild(guild.id)?.category_id;
  if (stored) {
    const ch = await guild.channels.fetch(stored).catch(() => null);
    if (ch?.type === ChannelType.GuildCategory) return ch;
  }
  const all = await guild.channels.fetch();
  return (all.find((c) => c?.type === ChannelType.GuildCategory && c.name === CATEGORY_NAME) as CategoryChannel | undefined) ?? null;
}

async function findChannel(guild: Guild, purpose: Purpose, category: CategoryChannel | null): Promise<TextChannel | null> {
  const stored = channelIdFor(guild.id, purpose);
  if (stored) {
    const ch = await guild.channels.fetch(stored).catch(() => null);
    if (ch?.type === ChannelType.GuildText) return ch;
  }
  if (!category) return null;
  const all = await guild.channels.fetch();
  return (
    (all.find((c) => c?.type === ChannelType.GuildText && c.parentId === category.id && c.name === CHANNEL_NAMES[purpose]) as
      | TextChannel
      | undefined) ?? null
  );
}

export async function inspectSetup(guild: Guild): Promise<SetupInspection> {
  const row = getGuild(guild.id);
  const category = await findCategory(guild);
  const channels = {} as Record<Purpose, TextChannel | null>;
  for (const p of PURPOSES) channels[p] = await findChannel(guild, p, category);

  let menuOk = false;
  if (row?.settings_message_id && channels.settings) {
    menuOk = !!(await channels.settings.messages.fetch(row.settings_message_id).catch(() => null));
  }
  const missing: string[] = [];
  if (!category) missing.push(`категория «${CATEGORY_NAME}»`);
  for (const p of PURPOSES) if (!channels[p]) missing.push(`#${CHANNEL_NAMES[p]}`);
  if (!menuOk) missing.push('сообщение с меню в #ai-настройки');
  return { isNew: !row?.category_id, category, channels, menuOk, missing };
}

function assertBotPermissions(guild: Guild): void {
  const me = guild.members.me;
  const need = [PermissionFlagsBits.ManageChannels, PermissionFlagsBits.ManageRoles, PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages];
  if (!me || !me.permissions.has(need)) {
    throw new UserError('⛔ Боту не хватает прав: нужны «Управлять каналами» (Manage Channels) и «Управлять ролями» (Manage Roles).');
  }
}

function botOverwrite(client: Client): OverwriteResolvable {
  return {
    id: client.user!.id,
    allow: [
      PermissionFlagsBits.ViewChannel,
      PermissionFlagsBits.SendMessages,
      PermissionFlagsBits.EmbedLinks,
      PermissionFlagsBits.ReadMessageHistory,
    ],
  };
}

function privateOverwrites(client: Client, guild: Guild, purpose: Purpose): OverwriteResolvable[] {
  const list: OverwriteResolvable[] = [{ id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] }, botOverwrite(client)];
  if (purpose === 'logs') {
    for (const rp of getRolePerms(guild.id)) {
      if (rp.view_logs && rp.role_id !== guild.id && guild.roles.cache.has(rp.role_id)) {
        list.push({
          id: rp.role_id,
          allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory],
          deny: [PermissionFlagsBits.SendMessages],
        });
      }
    }
  }
  return list;
}

type Overwrite = Partial<Record<'ViewChannel' | 'SendMessages' | 'ReadMessageHistory', boolean | null>>;

/** Ставит права роли в канале; если всё «наследуется» — убирает переопределение совсем. */
async function applyOverwrite(ch: TextChannel, roleId: string, ow: Overwrite, isEveryone: boolean): Promise<void> {
  const allNull = Object.values(ow).every((v) => v === null);
  if (allNull && !isEveryone) {
    if (ch.permissionOverwrites.cache.has(roleId)) await ch.permissionOverwrites.delete(roleId);
    return;
  }
  await ch.permissionOverwrites.edit(roleId, ow);
}

/**
 * Переносит настройки ролей на права каналов бота:
 * - «Видит каналы бота» → просмотр #ai-помощник и #ai-правила;
 * - «Может писать в #ai-помощник» → отправка сообщений;
 * - «Видит #ai-настройки» и «Просматривать логи» → доступ к закрытым каналам.
 * Возвращает список проблем (например, нет прав у бота).
 */
export async function syncAllRoleAccess(guild: Guild, resetRoleIds: string[] = []): Promise<string[]> {
  const problems: string[] = [];
  const rows = getRolePerms(guild.id).filter((r) => r.role_id === guild.id || guild.roles.cache.has(r.role_id));
  const everyone = rows.find((r) => r.role_id === guild.id);
  const everyoneHides = everyone ? everyone.see_channels === 0 : false;
  const everyoneMute = everyone ? everyone.can_write === 0 : false;

  const channels: Partial<Record<Purpose, TextChannel>> = {};
  for (const p of PURPOSES) {
    const id = channelIdFor(guild.id, p);
    const ch = id ? await guild.channels.fetch(id).catch(() => null) : null;
    if (ch?.type === ChannelType.GuildText) channels[p] = ch;
  }

  // Роли со сброшенными настройками тоже обрабатываем — их переопределения в каналах бота снимаются.
  // Чужие (ручные) переопределения других ролей не трогаем.
  const roleIds = new Set<string>([...rows.map((r) => r.role_id), ...resetRoleIds]);

  for (const roleId of roleIds) {
    const r = rows.find((x) => x.role_id === roleId) ?? null;
    const isEveryone = roleId === guild.id;
    const see = r ? r.see_channels === 1 : true;
    const write = r ? r.can_write === 1 : true;
    try {
      if (channels.assistant) {
        await applyOverwrite(
          channels.assistant,
          roleId,
          isEveryone
            ? { ViewChannel: see ? null : false, SendMessages: write ? null : false }
            : { ViewChannel: see ? (everyoneHides ? true : null) : false, SendMessages: write ? (everyoneMute ? true : null) : false },
          isEveryone,
        );
      }
      for (const readOnly of [channels.rules]) {
        if (!readOnly) continue;
        await applyOverwrite(
          readOnly,
          roleId,
          isEveryone
            ? { ViewChannel: see, SendMessages: false }
            : { ViewChannel: see ? (everyoneHides ? true : null) : false },
          isEveryone,
        );
      }
      if (!isEveryone && channels.settings) {
        await applyOverwrite(
          channels.settings,
          roleId,
          r?.see_settings ? { ViewChannel: true, ReadMessageHistory: true, SendMessages: false } : { ViewChannel: null, ReadMessageHistory: null, SendMessages: null },
          false,
        );
      }
      if (!isEveryone && channels.logs) {
        await applyOverwrite(
          channels.logs,
          roleId,
          r?.view_logs ? { ViewChannel: true, ReadMessageHistory: true, SendMessages: false } : { ViewChannel: null, ReadMessageHistory: null, SendMessages: null },
          false,
        );
      }
    } catch (err) {
      log.warn(`Не удалось обновить права роли ${roleId} в каналах бота`, err);
      problems.push(isEveryone ? '@everyone' : `<@&${roleId}>`);
    }
  }
  return problems;
}

export async function postSettingsMenu(guild: Guild, channel: TextChannel): Promise<string> {
  const msg = await channel.send(buildMainMenu(guild.id));
  updateGuild(guild.id, { settings_message_id: msg.id, settings_channel_id: channel.id });
  return msg.id;
}

export interface SetupResult {
  created: string[];
  firstRun: boolean;
}

/** Создаёт недостающие категорию/каналы/меню. Ничего не дублирует. */
export async function applySetup(client: Client, guild: Guild): Promise<SetupResult> {
  assertBotPermissions(guild);
  const before = getGuild(guild.id);
  const firstRun = !before?.category_id;
  ensureGuildRow(guild.id, config.defaultRefreshHours);

  const created: string[] = [];
  let category = await findCategory(guild);
  if (!category) {
    category = await guild.channels.create({ name: CATEGORY_NAME, type: ChannelType.GuildCategory, reason: 'NOVA RP AI: /setup' });
    created.push(`категория «${CATEGORY_NAME}»`);
  }
  updateGuild(guild.id, { category_id: category.id });

  const channels = {} as Record<Purpose, TextChannel>;
  for (const p of PURPOSES) {
    let ch = await findChannel(guild, p, category);
    if (!ch) {
      ch = await guild.channels.create({
        name: CHANNEL_NAMES[p],
        type: ChannelType.GuildText,
        parent: category.id,
        topic: TOPICS[p],
        permissionOverwrites:
          p === 'assistant'
            ? [botOverwrite(client)]
            : p === 'rules'
              ? readOnlyOverwrites(client, guild)
              : privateOverwrites(client, guild, p),
        reason: 'NOVA RP AI: /setup',
      });
      created.push(`#${CHANNEL_NAMES[p]}`);
    }
    channels[p] = ch;
    setChannelFor(guild.id, p, ch.id);
  }

  const row = getGuild(guild.id)!;
  const menuOk =
    !!row.settings_message_id && !!(await channels.settings.messages.fetch(row.settings_message_id).catch(() => null));
  if (!menuOk) {
    await postSettingsMenu(guild, channels.settings);
    created.push('меню в #ai-настройки');
  }

  // Начальные данные: стандартные источники и право задавать вопросы для @everyone.
  if (!listSources(guild.id).length) {
    for (const url of DEFAULT_SOURCES) {
      const n = normalizeForumUrl(url, config.forumBaseUrl);
      if (n) addSource(guild.id, n.url, n.kind, client.user!.id);
    }
  }
  if (!getRolePerms(guild.id).length) {
    upsertRolePerm(newRolePerm(guild.id, guild.id, config.defaultUserHourlyLimit));
  }
  if (created.length) await syncAllRoleAccess(guild);
  return { created, firstRun };
}
