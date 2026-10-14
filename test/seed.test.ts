import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { before, describe, it } from 'node:test';
import { termDefinitions } from '../src/ai/glossary.js';
import { lookupRule } from '../src/ai/ruleLookup.js';
import { searchKnowledge } from '../src/ai/search.js';
import { openDatabase } from '../src/db/database.js';
import { SEED_FILE, importSeedIfEmpty } from '../src/kbSeed.js';

describe('снимок правил для нового хостинга', { skip: !existsSync(SEED_FILE) && 'нет seed/knowledge.json' }, () => {
  before(() => {
    openDatabase(':memory:');
  });

  it('пустая база заполняется из снимка, повторно — нет', () => {
    assert.ok(importSeedIfEmpty() > 0);
    assert.equal(importSeedIfEmpty(), 0);
  });

  it('базовые вопросы находят ответ', () => {
    assert.equal(termDefinitions('что такое дм', null)[0]?.point, '4.1');
    assert.equal(termDefinitions('что такое тк', 'какой-то-сервер')[0]?.point, '4.7');
    assert.match(lookupRule('5.4', null)[0]?.punishment ?? '', /JAIL/);
    assert.ok(searchKnowledge('можна ли провоцироват гос сотрудника', null, 3)[0]?.chunk.text.includes('5.4'));
  });
});
