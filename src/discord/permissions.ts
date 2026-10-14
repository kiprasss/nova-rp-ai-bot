import { PermissionFlagsBits, type Client, type Guild, type GuildMember } from 'discord.js';
import { config } from '../config.js';
import { blockedCommandsOf, getGuild, getRolePerms } from '../db/repo.js';
import { UserError } from '../util/errors.js';

export interface ActorPerms {
  isAdmin: boolean;
  canAsk: boolean;
  anyChannel: boolean;
  manageSources: boolean;
  manageAi: boolean;
  viewLogs: boolean;
  /** Может задавать вопросы в ЛС за счёт AI-токена сервера. */
  dmAccess: boolean;
  /** Команды, запрещённые всем ролям пользователя. */
  blockedCommands: Set<string>;
  /** 0 — без ограничений */
  hourlyLimit: number;
}

export function isGuildAdmin(member: GuildMember): boolean {
  return (
    member.guild.ownerId === member.id ||
    member.permissions.has(PermissionFlagsBits.Administrator) ||
    member.permissions.has(PermissionFlagsBits.ManageGuild)
  );
}

export function computePerms(member: GuildMember): ActorPerms {
  const admin = isGuildAdmin(member);
  if (admin) {
    return {
      isAdmin: true,
      canAsk: true,
      anyChannel: true,
      manageSources: true,
      manageAi: true,
      viewLogs: true,
      dmAccess: true,
      blockedCommands: new Set(),
      hourlyLimit: 0,
    };
  }
  const rows = getRolePerms(member.guild.id);
  const mine = rows.filter((r) => r.role_id === member.guild.id || member.roles.cache.has(r.role_id));

  // Если роли ещё не настраивались — все могут спрашивать в #ai-помощник с лимитом по умолчанию.
  if (!rows.length) {
    return {
      isAdmin: false,
      canAsk: true,
      anyChannel: false,
      manageSources: false,
      manageAi: false,
      viewLogs: false,
      dmAccess: true,
      blockedCommands: new Set(),
      hourlyLimit: config.defaultUserHourlyLimit,
    };
  }

  // Команда запрещена, только если её запрещают ВСЕ настроенные роли пользователя (как разрешения в Discord).
  const lists = mine.map(blockedCommandsOf);
  const blocked = new Set<string>(lists.length ? [...lists[0]].filter((c) => lists.every((l) => l.has(c))) : []);

  const limit = mine
    .filter((r) => r.can_ask === 1)
    .reduce((max, r) => (r.hourly_limit === 0 || max === 0 ? 0 : Math.max(max, r.hourly_limit)), -1);

  return {
    isAdmin: false,
    canAsk: mine.some((r) => r.can_ask === 1),
    anyChannel: mine.some((r) => r.any_channel === 1),
    manageSources: mine.some((r) => r.manage_sources === 1),
    manageAi: mine.some((r) => r.manage_ai === 1),
    viewLogs: mine.some((r) => r.view_logs === 1),
    dmAccess: mine.some((r) => r.can_ask === 1 && r.dm_access === 1),
    blockedCommands: blocked,
    hourlyLimit: limit < 0 ? config.defaultUserHourlyLimit : limit,
  };
}

/** Получает участника с сервера (fresh = свежие данные из API, для проверки прав в реальном времени). */
export async function fetchMember(guild: Guild, userId: string, fresh = false): Promise<GuildMember | null> {
  try {
    return await guild.members.fetch({ user: userId, force: fresh });
  } catch {
    return null;
  }
}

export type Section = 'wizard' | 'roles' | 'ai' | 'aiset' | 'sources' | 'channels' | 'faq' | 'status';
export const SECTIONS: Section[] = ['wizard', 'roles', 'ai', 'aiset', 'sources', 'channels', 'faq', 'status'];

export function canOpenSection(p: ActorPerms, section: Section): boolean {
  switch (section) {
    case 'wizard':
    case 'roles':
    case 'channels':
      return p.isAdmin;
    case 'ai':
    case 'aiset':
      return p.isAdmin || p.manageAi;
    case 'sources':
    case 'faq':
      return p.isAdmin || p.manageSources;
    case 'status':
      return p.isAdmin || p.viewLogs || p.manageAi || p.manageSources;
  }
}

export function canManageAnything(p: ActorPerms): boolean {
  return p.isAdmin || p.manageAi || p.manageSources || p.viewLogs;
}

/** Проверка прав в реальном времени (в т.ч. из ЛС): бот должен быть на сервере, пользователь — его участником. */
export async function requireSection(client: Client, guildId: string, userId: string, section: Section) {
  const { guild, member, perms } = await requireMember(client, guildId, userId);
  if (!canOpenSection(perms, section)) throw new UserError('⛔ У вас нет прав для этого раздела настроек.');
  return { guild, member, perms };
}

export async function requireMember(client: Client, guildId: string, userId: string) {
  const guild = client.guilds.cache.get(guildId);
  if (!guild) throw new UserError('Бот больше не находится на этом сервере.');
  const member = await fetchMember(guild, userId, true);
  if (!member) throw new UserError('Вы не являетесь участником этого сервера.');
  return { guild, member, perms: computePerms(member) };
}

// ---------- AI-токен сервера для вопросов в ЛС ----------

const donorCache = new Map<string, { at: number; guildId: string | null }>();
const DONOR_CACHE_MS = 5 * 60_000;

/**
 * Сервер, чей AI-токен пользователь может использовать в ЛС: бот там есть, токен задан,
 * у пользователя есть роль с правами «Задавать вопросы» и «Использовать в ЛС».
 */
export async function findDmTokenGuild(client: Client, userId: string): Promise<{ guild: Guild; perms: ActorPerms } | null> {
  const cached = donorCache.get(userId);
  if (cached && Date.now() - cached.at < DONOR_CACHE_MS) {
    const guild = cached.guildId ? client.guilds.cache.get(cached.guildId) : null;
    if (!cached.guildId) return null;
    if (guild) {
      const member = await fetchMember(guild, userId);
      if (member) {
        const perms = computePerms(member);
        if (perms.dmAccess && getGuild(guild.id)?.ai_token) return { guild, perms };
      }
    }
  }
  for (const guild of client.guilds.cache.values()) {
    if (!getGuild(guild.id)?.ai_token) continue;
    const member = await fetchMember(guild, userId);
    if (!member) continue;
    const perms = computePerms(member);
    if (perms.canAsk && perms.dmAccess) {
      donorCache.set(userId, { at: Date.now(), guildId: guild.id });
      return { guild, perms };
    }
  }
  donorCache.set(userId, { at: Date.now(), guildId: null });
  return null;
}

/** Сбросить кэш (после изменения ролей/токена). */
export function clearDmTokenCache(): void {
  donorCache.clear();
}
