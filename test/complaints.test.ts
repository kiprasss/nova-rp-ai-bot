import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { normalizeGameId } from '../src/commands/playerIds.js';
import { openDatabase } from '../src/db/database.js';
import {
  addComplaintEvent,
  addPlayerId,
  complaintEventsBetween,
  listPlayerIds,
  maxComplaintEventId,
  ownerOfGameId,
  recentComplaintsFor,
  removePlayerId,
  saveComplaintThread,
} from '../src/db/repo.js';
import { buildComplaintAlert } from '../src/discord/complaintAlerts.js';
import { extractOffenderId, extractOffenderNick, queueExistingComplaints } from '../src/forum/complaintWatch.js';
import { parseThread } from '../src/forum/parser.js';
import { THREAD_HTML } from './fixtures.js';

describe('жалобы на игровые ID', () => {
  before(() => {
    openDatabase(':memory:');
  });

  it('ID нарушителя из полей формы и из заголовка', () => {
    const t = parseThread(THREAD_HTML, 'https://forum.grand-rp.su/threads/410706/');
    assert.equal(extractOffenderId(t.fields, t.title), '54321');
    assert.equal(extractOffenderId([], '6.2 ОП / ID 74687'), '74687');
    assert.equal(extractOffenderId([], '5.4 ОП I 54321'), '54321');
    assert.equal(extractOffenderId([], 'запрос откат'), null);
  });

  it('нормализует игровой ID', () => {
    assert.equal(normalizeGameId(' #054321 '), '54321');
    assert.equal(normalizeGameId('abc'), null);
    assert.equal(normalizeGameId('12345678'), null);
  });

  it('привязка: один ID — один пользователь, не больше 3 на человека', () => {
    assert.equal(addPlayerId('u1', '54321', 3), 'ok');
    assert.equal(addPlayerId('u1', '54321', 3), 'exists');
    assert.equal(addPlayerId('u2', '54321', 3), 'taken');
    assert.equal(addPlayerId('u1', '1', 3), 'ok');
    assert.equal(addPlayerId('u1', '2', 3), 'ok');
    assert.equal(addPlayerId('u1', '3', 3), 'limit');
    assert.equal(addPlayerId('u1', '3', 0), 'ok', '0 — без лимита');
    assert.equal(removePlayerId('3', 'u1'), true);
    assert.equal(ownerOfGameId('54321'), 'u1');
    assert.equal(removePlayerId('54321', 'u2'), false);
    assert.equal(removePlayerId('2', 'u1'), true);
    assert.deepEqual(listPlayerIds('u1'), ['54321', '1']);
  });

  it('события и уведомление с упоминанием', () => {
    saveComplaintThread({
      url: 'https://f/threads/1/',
      offender_id: '54321',
      offender_nick: 'John Doe',
      author: 'Test Author',
      title: '5.4 ОП I 54321',
      prefix: 'Ожидает рассмотрения',
      last_post_ts: 1,
    });
    assert.equal(recentComplaintsFor('54321').length, 1);
    addComplaintEvent({ url: 'https://f/threads/1/', offender_id: '54321', title: '5.4 ОП I 54321', prefix: 'Ожидает рассмотрения', kind: 'new' });
    const [e] = complaintEventsBetween(0, maxComplaintEventId());
    const msg = buildComplaintAlert(e, 'u1');
    assert.equal(msg.content, '<@u1>');
    assert.deepEqual(msg.allowedMentions, { users: ['u1'] });
    const embed = JSON.parse(JSON.stringify(msg.embeds![0]));
    assert.match(embed.title, /подана жалоба/);
    assert.equal(buildComplaintAlert(e, 'u1', false).content, undefined);
    // кто подал и на кого
    const fields = embed.fields.map((f: { name: string; value: string }) => `${f.name}=${f.value}`);
    assert.ok(fields.includes('Кто подал=Test Author'));
    assert.ok(fields.includes('На кого (ник в жалобе)=John Doe'));
  });

  it('при привязке ID находятся уже существующие жалобы', () => {
    const before = maxComplaintEventId();
    assert.equal(queueExistingComplaints('54321'), 1);
    const [e] = complaintEventsBetween(before, maxComplaintEventId());
    assert.equal(e.kind, 'existing');
    assert.match(JSON.stringify(buildComplaintAlert(e, 'u1').embeds), /есть жалоба на ваш игровой ID/);
    assert.equal(queueExistingComplaints('99999'), 0);
  });

  it('ник из формы жалобы', () => {
    const t = parseThread(THREAD_HTML, 'https://forum.grand-rp.su/threads/410706/');
    assert.equal(extractOffenderNick(t.fields), 'John Doe');
  });
});
