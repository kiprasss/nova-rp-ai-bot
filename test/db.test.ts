import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { lookupRule } from '../src/ai/ruleLookup.js';
import { invalidateSearchIndex, searchKnowledge } from '../src/ai/search.js';
import { openDatabase } from '../src/db/database.js';
import {
  addSource,
  deleteSource,
  ensureGuildRow,
  getDocument,
  kbStats,
  linkSourceDocs,
  listSources,
  saveDocument,
  updateGuild,
  getGuild,
  addRuleEvents,
  blockedCommandsOf,
  getRolePerm,
  newRolePerm,
  upsertRolePerm,
  maxRuleEventId,
  ruleEventsBetween,
} from '../src/db/repo.js';
import { buildRuleUpdateEmbeds } from '../src/discord/ruleUpdates.js';
import { TONE_PROMPTS, aiSettingsFor } from '../src/ai/answer.js';

describe('база данных (node:sqlite)', () => {
  before(() => {
    openDatabase(':memory:');
  });

  it('создаёт сервер и обновляет поля', () => {
    ensureGuildRow('g1', 12);
    updateGuild('g1', { ai_provider: 'openai', refresh_hours: 6 });
    const g = getGuild('g1')!;
    assert.equal(g.ai_provider, 'openai');
    assert.equal(g.refresh_hours, 6);
  });

  it('источники без дублей', () => {
    assert.equal(addSource('g1', 'https://f/forums/1/', 'forum', 'u'), true);
    assert.equal(addSource('g1', 'https://f/forums/1/', 'forum', 'u'), false);
    assert.equal(addSource('g1', 'https://f/threads/2/', 'thread', 'u'), true);
    assert.equal(listSources('g1').length, 2);
  });

  it('сохраняет документы, ищет правила и фрагменты в области сервера', () => {
    const [forum, thread] = listSources('g1');
    saveDocument(
      { url: 'https://f/threads/10/', title: 'Общие правила проекта', author: 'Admin', breadcrumbs: 'Правила', is_rules: 1, is_complaint: 0, last_post_ts: null, content_hash: 'x' },
      [{ postUrl: 'https://f/threads/10/#post-1', text: '5.4 Запрещено провоцирование сотрудников на погони. | JAIL от 120 до 180 минут' }],
      [{ postUrl: 'https://f/threads/10/#post-1', point: '5.4', text: 'Запрещено провоцирование сотрудников на погони.', punishment: 'JAIL от 120 до 180 минут | WARN при повторном нарушении', repeatWarn: true }],
    );
    saveDocument(
      { url: 'https://f/threads/2/', title: '5.4 ОП I [скрыто]', author: null, breadcrumbs: 'Жалобы', is_rules: 0, is_complaint: 1, last_post_ts: 1, content_hash: 'y' },
      [{ postUrl: 'https://f/threads/2/#post-5', text: 'Ник игрока: [скрыто]\n5.4 Запрещено провоцирование' }],
      [{ postUrl: 'https://f/threads/2/#post-5', point: '5.4', text: 'Запрещено провоцирование', punishment: 'JAIL', repeatWarn: false }],
    );
    linkSourceDocs(forum.id, ['https://f/threads/10/']);
    linkSourceDocs(thread.id, ['https://f/threads/2/']);
    invalidateSearchIndex();

    const rules = lookupRule('5.4', 'g1');
    assert.equal(rules[0].doc_title, 'Общие правила проекта');
    assert.equal(rules[0].repeat_warn, 1);

    const hits = searchKnowledge('провоцирование на погони', 'g1');
    assert.ok(hits.length >= 1);
    assert.equal(hits[0].chunk.doc_url, 'https://f/threads/10/');

    const stats = kbStats('g1');
    assert.deepEqual(stats, { sources: 2, documents: 2, chunks: 2, rules: 2 });
  });

  it('роли: новые настройки доступа по умолчанию и сохранение', () => {
    upsertRolePerm(newRolePerm('g1', 'r1', 10, { see_channels: 0, blocked_commands: 'жалоба,faq' }));
    const p = getRolePerm('g1', 'r1')!;
    assert.equal(p.dm_access, 1);
    assert.equal(p.see_channels, 0);
    assert.equal(p.can_write, 1);
    assert.equal(p.see_settings, 0);
    assert.deepEqual([...blockedCommandsOf(p)], ['жалоба', 'faq']);
  });

  it('миграция добавила колонки для канала правил', () => {
    const g = getGuild('g1')!;
    assert.equal(g.rules_channel_id, null);
    assert.equal(g.last_rule_event_id, 0);
  });

  it('события изменений правил и их оформление', () => {
    addRuleEvents([
      { doc_url: 'https://f/threads/10/', doc_title: 'Общие правила проекта', kind: 'changed', point: '5.4', before_text: 'Запрещено провоцирование', before_punishment: 'JAIL 120', after_text: 'Запрещено провоцирование', after_punishment: 'JAIL 180', post_url: null },
      { doc_url: 'https://f/threads/10/', doc_title: 'Общие правила проекта', kind: 'added', point: '7.1', before_text: null, before_punishment: null, after_text: 'Новый пункт', after_punishment: 'BAN', post_url: null },
    ]);
    const max = maxRuleEventId();
    assert.equal(max, 2);
    const events = ruleEventsBetween(0, max);
    assert.equal(events.length, 2);
    const embeds = buildRuleUpdateEmbeds(events);
    assert.equal(embeds.length, 1);
    const json = embeds[0].toJSON();
    assert.match(json.title!, /Обновление правил: Общие правила проекта/);
    assert.match(json.description!, /изменено наказание/);
    assert.match(json.description!, /🆕 \*\*7\.1\*\*/);
    assert.match(json.footer!.text, /новых: 1 · изменено: 1/);
  });

  it('настройки AI сервера: значения по умолчанию и изменения', () => {
    assert.deepEqual(
      { ...aiSettingsFor('g1'), instructions: null },
      {
        answerLength: 'short',
        temperature: null,
        rewrite: true,
        showSources: true,
        contextSize: 6,
        instructions: null,
        tone: 'neutral',
        maxTokens: null,
        fallbackModel: null,
        searchComplaints: true,
        showModel: false,
        faqFirst: true,
      },
    );
    updateGuild('g1', { ai_tone: 'official', ai_max_tokens: 600, ai_fallback_model: 'llama-3.3-70b-versatile', ai_search_complaints: 0 });
    const s = aiSettingsFor('g1');
    assert.equal(s.tone, 'official');
    assert.equal(s.maxTokens, 600);
    assert.equal(s.fallbackModel, 'llama-3.3-70b-versatile');
    assert.match(TONE_PROMPTS[s.tone], /на «вы»/);
    // «Жалобы в поиске» выключены — фрагменты из жалоб не попадают в результаты.
    const withComplaints = searchKnowledge('провоцирование', 'g1', 6, 0.1, false).map((h) => h.chunk.doc_url);
    const rulesOnly = searchKnowledge('провоцирование', 'g1', 6, 0.1, true).map((h) => h.chunk.doc_url);
    assert.ok(withComplaints.includes('https://f/threads/2/'));
    assert.ok(!rulesOnly.includes('https://f/threads/2/'));
  });

  it('удаление источника удаляет осиротевшие документы', () => {
    const thread = listSources('g1').find((s) => s.kind === 'thread')!;
    deleteSource(thread.id);
    assert.equal(getDocument('https://f/threads/2/'), undefined);
    assert.ok(getDocument('https://f/threads/10/'));
  });
});
