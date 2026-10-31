import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import type { GuildMember } from 'discord.js';
import { openDatabase } from '../src/db/database.js';
import { newRolePerm, upsertRolePerm } from '../src/db/repo.js';
import { buildMainMenu } from '../src/discord/mainMenu.js';
import { computePerms } from '../src/discord/permissions.js';

/** Минимальная заглушка участника: роли, права администратора, владелец. */
function member(roles: string[], admin = false): GuildMember {
  return {
    id: 'u1',
    guild: { id: 'g', ownerId: 'owner' },
    permissions: { has: () => admin },
    roles: { cache: { has: (id: string) => roles.includes(id) } },
  } as unknown as GuildMember;
}

describe('права ролей', () => {
  before(() => {
    openDatabase(':memory:');
    upsertRolePerm(newRolePerm('g', 'g', 10, { blocked_commands: 'жалоба,faq', dm_access: 0 }));
    upsertRolePerm(newRolePerm('g', 'vip', 50, { blocked_commands: 'faq', any_channel: 1, max_player_ids: 10 }));
    upsertRolePerm(newRolePerm('g', 'staff', 50, { max_player_ids: 0 }));
    upsertRolePerm(newRolePerm('g', 'muted', 5, { can_ask: 0 }));
  });

  it('обычный участник: ограничения @everyone', () => {
    const p = computePerms(member([]));
    assert.equal(p.canAsk, true);
    assert.equal(p.dmAccess, false);
    assert.equal(p.hourlyLimit, 10);
    assert.equal(p.maxPlayerIds, 3);
    assert.deepEqual([...p.blockedCommands].sort(), ['faq', 'жалоба']);
  });

  it('несколько ролей: действует самое широкое разрешение', () => {
    const p = computePerms(member(['vip']));
    assert.equal(p.anyChannel, true);
    assert.equal(p.dmAccess, true);
    assert.equal(p.hourlyLimit, 50);
    assert.equal(p.maxPlayerIds, 10);
    // /жалоба разрешена ролью VIP, /faq запрещена обеими ролями
    assert.deepEqual([...p.blockedCommands], ['faq']);
  });

  it('лимит игровых ID: 0 у любой роли — без лимита', () => {
    assert.equal(computePerms(member(['vip', 'staff'])).maxPlayerIds, 0);
  });

  it('администратор может всё', () => {
    const p = computePerms(member([], true));
    assert.equal(p.isAdmin, true);
    assert.equal(p.blockedCommands.size, 0);
    assert.equal(p.hourlyLimit, 0);
    assert.equal(p.maxPlayerIds, 0);
  });

  it('панель в ЛС показывает только доступные разделы', () => {
    const p = computePerms(member([]));
    const json = JSON.stringify(buildMainMenu('g', 'Сервер', { ...p, manageAi: true }).components);
    assert.match(json, /"value":"ai"/);
    assert.match(json, /"value":"status"/);
    assert.doesNotMatch(json, /"value":"roles"/);
    assert.match(json, /dm:open:servers/);
  });
});
