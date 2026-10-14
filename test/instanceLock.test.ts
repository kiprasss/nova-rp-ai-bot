import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { acquireInstanceLock } from '../src/util/instanceLock.js';

describe('защита от второго экземпляра', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nova-lock-'));

  it('первый запуск получает блокировку', () => {
    assert.equal(acquireInstanceLock(join(dir, 'a.lock')), null);
  });

  it('если в блокировке живой процесс — второй экземпляр не запускается', () => {
    const lock = join(dir, 'b.lock');
    writeFileSync(lock, String(process.ppid)); // родительский процесс точно жив
    assert.equal(acquireInstanceLock(lock), process.ppid);
  });

  it('устаревшая блокировка (процесса нет) перезаписывается', () => {
    const lock = join(dir, 'c.lock');
    writeFileSync(lock, '999999');
    assert.equal(acquireInstanceLock(lock), null);
  });
});
