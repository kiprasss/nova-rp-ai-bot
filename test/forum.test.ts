import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { chunkRulesText, chunkText } from '../src/forum/chunker.js';
import { isBotChallenge } from '../src/forum/http.js';
import { parseForum, parseThread } from '../src/forum/parser.js';
import { extractRules, splitPunishment } from '../src/forum/rules.js';
import { HIDDEN, sanitizeComplaintTitle, sanitizeField, sanitizeText } from '../src/forum/sanitize.js';
import { normalizeForumUrl, pageUrl } from '../src/forum/url.js';
import { FORUM_HTML, RULES_TEXT, THREAD_HTML } from './fixtures.js';

const BASE = 'https://forum.grand-rp.su';

describe('антибот-защита форума', () => {
  it('распознаёт страницу проверки браузера и пустой 401', () => {
    assert.equal(isBotChallenge(200, '<html><title>Checking your browser / Проверка браузера</title></html>'), true);
    assert.equal(isBotChallenge(401, '{"ok":false}'), true);
    assert.equal(isBotChallenge(200, THREAD_HTML), false);
    assert.equal(isBotChallenge(404, 'not found'), false);
  });
});

describe('normalizeForumUrl', () => {
  it('понимает темы с якорем и slug', () => {
    assert.deepEqual(normalizeForumUrl('https://forum.grand-rp.su/threads/410706/#post-1819563', BASE), {
      url: `${BASE}/threads/410706/`,
      kind: 'thread',
      id: 410706,
    });
    assert.equal(normalizeForumUrl('/threads/zhaloba.410706/page-3', BASE)?.url, `${BASE}/threads/410706/`);
  });
  it('понимает разделы', () => {
    assert.equal(normalizeForumUrl('https://forum.grand-rp.su/forums/1010/', BASE)?.kind, 'forum');
  });
  it('отклоняет чужие сайты и прочие страницы', () => {
    assert.equal(normalizeForumUrl('https://evil.example/threads/1/', BASE), null);
    assert.equal(normalizeForumUrl('https://forum.grand-rp.su/members/1/', BASE), null);
    assert.equal(normalizeForumUrl('не ссылка', BASE), null);
  });
  it('строит ссылки на страницы', () => {
    assert.equal(pageUrl(`${BASE}/threads/1/`, 1), `${BASE}/threads/1/`);
    assert.equal(pageUrl(`${BASE}/threads/1/`, 3), `${BASE}/threads/1/page-3`);
  });
});

describe('parseThread', () => {
  const t = parseThread(THREAD_HTML, `${BASE}/threads/410706/`);
  it('извлекает заголовок без меток и префикс', () => {
    assert.equal(t.title, '5.4 ОП I 54321');
    assert.equal(t.prefix, 'Ожидает рассмотрения');
  });
  it('извлекает поля жалобы', () => {
    assert.deepEqual(
      t.fields.map((f) => f.label),
      ['Ник игрока', 'ID нарушителя', 'Дата нарушения', 'Время нарушения', 'Доказательства'],
    );
    assert.equal(t.fields[1].value, '54321');
  });
  it('извлекает сообщения с автором, ссылкой и текстом', () => {
    assert.equal(t.posts.length, 2);
    assert.equal(t.posts[0].author, 'Test Author');
    assert.equal(t.posts[0].url, `${BASE}/threads/410706/#post-1819563`);
    assert.match(t.posts[0].text, /^5\.4 Запрещено/);
    assert.match(t.posts[0].text, /JAIL от 120 до 180 минут/);
    assert.equal(t.posts[1].text, 'Жалоба одобрена.\nИгрок будет наказан.');
  });
  it('считает страницы и хлебные крошки', () => {
    assert.equal(t.totalPages, 2);
    assert.deepEqual(t.breadcrumbs, ['Форумы', 'Жалобы', 'Жалобы на игроков']);
  });
});

describe('parseForum', () => {
  const f = parseForum(FORUM_HTML, BASE);
  it('находит темы, закреплённые и даты', () => {
    assert.equal(f.title, 'Жалобы на игроков');
    assert.equal(f.threads.length, 2);
    assert.equal(f.threads[0].url, `${BASE}/threads/409510/`);
    assert.equal(f.threads[0].sticky, true);
    assert.equal(f.threads[0].lastPostTs, 1778854687000);
    assert.equal(f.threads[1].url, `${BASE}/threads/410706/`);
    assert.equal(f.threads[1].sticky, false);
  });
  it('находит подразделы и страницы', () => {
    assert.deepEqual(f.subforums, [{ url: `${BASE}/forums/1011/`, title: 'Проверенные жалобы на игроков' }]);
    assert.equal(f.totalPages, 7);
  });
});

describe('extractRules', () => {
  const rules = extractRules(RULES_TEXT);
  const byPoint = Object.fromEntries(rules.map((r) => [r.point, r]));
  it('находит пункты, но не заголовки разделов и даты', () => {
    assert.deepEqual(
      rules.map((r) => r.point),
      ['1.1', '2.1', '2.2', '2.3', '5.4'],
    );
  });
  it('отделяет наказание и распознаёт WARN за повтор', () => {
    assert.equal(byPoint['5.4'].punishment, 'JAIL от 120 до 180 минут | WARN при повторном нарушении');
    assert.equal(byPoint['5.4'].repeatWarn, true);
    assert.equal(byPoint['2.3'].punishment, 'BAN навсегда');
    assert.equal(byPoint['2.3'].repeatWarn, false);
    assert.equal(byPoint['2.2'].punishment, null);
    assert.match(byPoint['2.1'].text, /^Запрещено иметь более 1/);
  });
  it('понимает «Наказание:»', () => {
    assert.deepEqual(splitPunishment('Запрещён DM. Наказание: JAIL 60 минут.'), { text: 'Запрещён DM.', punishment: 'JAIL 60 минут' });
  });
  it('не принимает «|» без наказания за разделитель наказания', () => {
    assert.equal(splitPunishment('Текст | ещё текст').punishment, null);
  });
});

describe('sanitize', () => {
  it('скрывает ники и ID в полях', () => {
    assert.equal(sanitizeField('Ник игрока', 'John Doe'), HIDDEN);
    assert.equal(sanitizeField('ID нарушителя', '54321'), HIDDEN);
    assert.equal(sanitizeField('Дата нарушения', '13.10.2026'), '13.10.2026');
  });
  it('скрывает ники и ID в тексте', () => {
    const out = sanitizeText('Ник игрока: John Doe\nID нарушителя - 12345\nСуть: ДМ в зелёной зоне');
    assert.equal(out, `Ник игрока: ${HIDDEN}\nID нарушителя - ${HIDDEN}\nСуть: ДМ в зелёной зоне`);
  });
  it('скрывает ID в заголовке жалобы, но не номер пункта', () => {
    assert.equal(sanitizeComplaintTitle('5.4 ОП I 54321'), `5.4 ОП I ${HIDDEN}`);
    assert.equal(sanitizeComplaintTitle('6.2 ОП / ID 74687'), `6.2 ОП / ID ${HIDDEN}`);
  });
});

describe('chunkText', () => {
  it('короткий текст — один фрагмент', () => {
    assert.deepEqual(chunkText('Привет'), ['Привет']);
  });
  it('длинный текст режется на фрагменты не длиннее лимита', () => {
    const text = Array.from({ length: 60 }, (_, i) => `${i + 1}.1 Правило номер ${i + 1}, которое что-то запрещает.`).join('\n');
    const chunks = chunkText(text, 300, 50);
    assert.ok(chunks.length > 5);
    for (const c of chunks) assert.ok(c.length <= 300, `длина ${c.length}`);
    assert.ok(chunks.join('\n').includes('60.1 Правило номер 60'));
  });
  it('режет очень длинную строку без переносов', () => {
    const chunks = chunkText('а'.repeat(2000), 500, 0);
    assert.equal(chunks.length, 4);
  });
});

describe('chunkRulesText', () => {
  it('ненумерованный заголовок «Правила для …» становится разделом и подписывает пункты', () => {
    const filler = (n: string) => `${n} Запрещено ${'что-то очень длинное '.repeat(20)}| JAIL до 120 минут.`;
    const text = [
      'Общее положение',
      filler('1.1'),
      filler('1.2'),
      'Правила для государственных структур',
      '2.1 В мероприятии могут принять участие только сотрудники государственных структур. | JAIL до 180 минут.',
      filler('2.2'),
      'Правила для криминальных организаций',
      '3.1 В мероприятии могут принять участие только члены криминальных фракций. | JAIL до 180 минут.',
      filler('3.2'),
    ].join('\n');
    const chunks = chunkRulesText(text);
    const gov = chunks.find((c) => c.includes('2.1 В мероприятии'));
    const crime = chunks.find((c) => c.includes('3.1 В мероприятии'));
    assert.ok(gov?.includes('Правила для государственных структур'));
    assert.ok(crime?.includes('Правила для криминальных организаций'));
    assert.ok(!crime?.includes('Правила для государственных структур'));
    // Пункт 2.2 начинает новый фрагмент посреди раздела — тоже получает заголовок.
    assert.ok(chunks.find((c) => c.includes('2.2 Запрещено'))?.startsWith('Правила для государственных структур'));
  });
});
