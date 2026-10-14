import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { EMPTY_KB, answerQuestion } from '../src/ai/answer.js';
import { termDefinitions } from '../src/ai/glossary.js';
import { lookupRule } from '../src/ai/ruleLookup.js';
import { openDatabase } from '../src/db/database.js';
import { listSources, maxRuleEventId, ruleEventsBetween } from '../src/db/repo.js';
import { backoffMs, canTryForum, getForumAccess, markForumBlocked, markForumOk } from '../src/forum/access.js';
import { classifyBlock, parseExtraHeader } from '../src/forum/http.js';
import { canonicalSourceUrl, importManual, markdownToText } from '../src/forum/manualImport.js';
import { THREAD_HTML } from './fixtures.js';

const MIN = 60_000;

describe('режим без доступа к форуму', () => {
  before(() => {
    openDatabase(':memory:');
  });

  it('пустая база — честный ответ, без выдумок', async () => {
    const res = await answerQuestion({ guildId: null, userId: 'u1', question: 'что такое дм' });
    assert.equal(res.kind, 'nodata');
    assert.equal(res.text, EMPTY_KB);
  });

  it('распознаёт блокировки: защита, captcha, 403/429/503', () => {
    assert.match(classifyBlock(200, '<title>Проверка браузера</title>') ?? '', /Проверка браузера/);
    assert.match(classifyBlock(403, '<html>Just a moment...</html>') ?? '', /captcha/);
    assert.equal(classifyBlock(403, 'forbidden'), 'HTTP 403 Forbidden');
    assert.equal(classifyBlock(429, ''), 'HTTP 429 Too Many Requests');
    assert.equal(classifyBlock(503, ''), 'HTTP 503 Service Unavailable');
    assert.equal(classifyBlock(200, THREAD_HTML), null);
    assert.equal(classifyBlock(404, 'not found'), null);
  });

  it('пауза после блокировок растёт до 6 часов, после успеха — сброс', () => {
    assert.deepEqual([1, 2, 3, 4, 5, 6, 10].map((n) => backoffMs(n) / MIN), [15, 30, 60, 120, 240, 360, 360]);
    const t0 = 1_000_000_000_000;
    assert.equal(canTryForum(false, t0), true);
    markForumBlocked('HTTP 403 Forbidden', t0);
    assert.equal(canTryForum(false, t0 + 5 * MIN), false); // пауза 15 минут
    assert.equal(canTryForum(true, t0 + 5 * MIN), true); // ручное обновление — можно
    assert.equal(canTryForum(false, t0 + 16 * MIN), true);
    markForumBlocked('HTTP 403 Forbidden', t0 + 16 * MIN);
    assert.equal(getForumAccess().failures, 2);
    assert.equal(canTryForum(false, t0 + 40 * MIN), false); // теперь 30 минут
    markForumOk(t0 + 50 * MIN);
    assert.equal(getForumAccess().blocked, false);
    assert.equal(canTryForum(false, t0 + 50 * MIN), true);
  });

  it('заголовок для белого списка', () => {
    assert.deepEqual(parseExtraHeader('X-Bot-Key: abc 123'), ['X-Bot-Key', 'abc 123']);
    assert.equal(parseExtraHeader(''), null);
    assert.equal(parseExtraHeader('без двоеточия'), null);
  });

  it('ссылка на оригинал: тема форума, другая ссылка, но не раздел', () => {
    assert.equal(canonicalSourceUrl('https://forum.grand-rp.su/threads/obshchie-pravila.406242/page-2#post-5'), 'https://forum.grand-rp.su/threads/406242/');
    assert.equal(canonicalSourceUrl('https://example.com/rules'), 'https://example.com/rules');
    assert.throws(() => canonicalSourceUrl('https://forum.grand-rp.su/forums/1242/'), /тему/);
    assert.throws(() => canonicalSourceUrl('не ссылка'), /ссылку/);
  });

  it('импорт текста: правила, ссылка-источник, ответы находят пункты', () => {
    const text = [
      '4. Термины',
      '4.1 DeathMatch (DM) — убийство или попытка убийства без весомой на то IC причины. | JAIL до 120 минут',
      '4.5 Spawn Kill (SK) — убийство на месте появления. | JAIL до 120 минут',
      '4.7 Team Kill (TK) — убийство игроков своей организации. | WARN',
    ].join('\n');
    const res = importManual({ scope: 'g1', url: 'https://forum.grand-rp.su/threads/406242/', title: 'Общие правила (часть)', content: text, userId: 'admin' });
    assert.equal(res.isRules, true);
    assert.equal(res.rules, 3);
    assert.equal(res.url, 'https://forum.grand-rp.su/threads/406242/');
    const [src] = listSources('g1');
    assert.equal(src.kind, 'manual');
    assert.equal(src.access, 'manual');
    assert.equal(termDefinitions('что такое дм', 'g1')[0]?.point, '4.1');
    assert.equal(lookupRule('4.7', 'g1')[0]?.post_url, 'https://forum.grand-rp.su/threads/406242/');
  });

  it('повторный импорт обновляет правила и создаёт события для #ai-правила', () => {
    const before = maxRuleEventId();
    const text = [
      '4.1 DeathMatch (DM) — убийство или попытка убийства без весомой на то IC причины. | JAIL до 180 минут',
      '4.5 Spawn Kill (SK) — убийство на месте появления. | JAIL до 120 минут',
      '4.7 Team Kill (TK) — убийство игроков своей организации. | WARN',
    ].join('\n');
    const res = importManual({ scope: 'g1', url: 'https://forum.grand-rp.su/threads/406242/', content: text, userId: 'admin' });
    assert.equal(res.ruleChanges, 1);
    const [e] = ruleEventsBetween(before, maxRuleEventId());
    assert.equal(e.kind, 'changed');
    assert.equal(e.point, '4.1');
    assert.equal(listSources('g1').length, 1); // тот же источник, без дублей
  });

  it('сохранённая страница форума разбирается как тема', () => {
    const res = importManual({ scope: 'g1', url: 'https://forum.grand-rp.su/threads/410706/', content: THREAD_HTML, format: 'html', userId: 'admin' });
    assert.equal(res.fromSavedPage, true);
    assert.equal(res.url, 'https://forum.grand-rp.su/threads/410706/');
    assert.ok(res.chunks >= 1);
  });

  it('пустой текст не импортируется; markdown очищается', () => {
    assert.throws(() => importManual({ scope: 'g1', url: 'https://forum.grand-rp.su/threads/1/', content: '   ', userId: 'a' }), /короткий/);
    assert.equal(markdownToText('## Правила\n**4.1** `DM` — [тема](https://f/t/1)'), 'Правила\n4.1 DM — тема (https://f/t/1)');
  });
});
