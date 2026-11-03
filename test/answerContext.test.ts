import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { joinDocChunks, wantsList } from '../src/ai/answer.js';
import { annotateClarifications, annotateExceptions } from '../src/ai/prompt.js';
import { truncate } from '../src/util/text.js';

describe('контекст ответа', () => {
  it('«Исключение:» подписывается номером пункта над ним', () => {
    const t = '3.1 Инициаторам запрещено выезжать из зоны. | JAIL от 60 до 120 минут.\n\nИсключение: Ограбление дома.\n3.1.1 Нельзя за руль.';
    assert.match(annotateExceptions(t), /Исключение из пункта 3\.1 \(на это пункт 3\.1 НЕ распространяется\): Ограбление дома/);
    assert.match(annotateExceptions('Пункт 2.1: Личный транспорт.\nИсключение: DB/CID.'), /Исключение из пункта 2\.1 /);
    assert.equal(annotateExceptions('Исключение: без пункта'), 'Исключение: без пункта');
  });

  it('уточнения и исключения подписываются вместе', () => {
    const t = 'Пункт 7.7: Маски.\nНаказание: BAN до 60 дней\nУточнение: балаклавы\nИсключение: ивенты';
    const out = annotateClarifications(t);
    assert.match(out, /Уточнение \(нарушение наказывается так же: BAN до 60 дней\):/);
    assert.match(out, /Исключение из пункта 7\.7 /);
  });

  it('полный текст темы: без картинок, вложений и повторных заголовков', () => {
    const text = joinDocChunks([
      'logo.png\nПравила для грабителей\n3.1 Выезжать нельзя.\nИсключение: Ограбление дома.',
      'Правила для грабителей\n3.4 Минимум грабителей:\n2 игрока для ограбления дома;\nПосмотреть вложение 5463',
    ]);
    assert.equal(text, 'Правила для грабителей\n3.1 Выезжать нельзя.\nИсключение: Ограбление дома.\n3.4 Минимум грабителей:\n2 игрока для ограбления дома;');
  });

  it('просьба перечислить правила', () => {
    assert.ok(wantsList('перечисли правила ограбления дома'));
    assert.ok(wantsList('правила ограбления дома'));
    assert.ok(wantsList('какие правила при захвате авианосца?'));
    assert.ok(!wantsList('можно ли грабить на ограблении дома?'));
  });

  it('длинный ответ режется по целой строке', () => {
    const lines = Array.from({ length: 30 }, (_, i) => `- пункт ${i} — суть — JAIL 60 минут`).join('\n');
    const out = truncate(lines, 300);
    assert.ok(out.length <= 300);
    assert.ok(out.endsWith('\n…'));
    assert.ok(!/JAIL 6…$/.test(out));
  });
});
