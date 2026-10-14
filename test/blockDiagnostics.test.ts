import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { collectBlockDetails, formatBlockDetails, setForumDebugDir } from '../src/forum/blockDiagnostics.js';

describe('подробные логи блокировки форума', () => {
  it('собирает статус, заголовки, имена cookie, текст и сохраняет страницу', () => {
    const dir = mkdtempSync(join(tmpdir(), 'nova-block-'));
    setForumDebugDir(dir);
    const headers = new Headers({
      server: 'nginx',
      'content-type': 'text/html; charset=utf-8',
      'x-protected-by': 'React Labs',
      'set-cookie': 'rl_challenge=secret123; Path=/',
      'cache-control': 'no-store',
    });
    const body = '<html><head><title>Checking your browser / Проверка браузера</title><script>x()</script></head><body><h1>Проверка браузера</h1></body></html>';
    const d = collectBlockDetails('https://forum.grand-rp.su/forums/1010/', { status: 200, headers }, body, 'NovaRP-AI-Bot/1.0');

    assert.equal(d.status, 200);
    assert.equal(d.server, 'nginx');
    assert.equal(d.title, 'Checking your browser / Проверка браузера');
    assert.equal(d.headers['x-protected-by'], 'React Labs');
    assert.equal(d.headers['cache-control'], undefined); // неинтересные заголовки не пишем
    assert.deepEqual(d.cookieNames, ['rl_challenge']);
    assert.match(d.snippet, /Проверка браузера/);
    assert.doesNotMatch(d.snippet, /x\(\)/);
    assert.ok(d.savedTo && existsSync(d.savedTo));
    assert.match(readFileSync(d.savedTo, 'utf8'), /HTTP 200/);

    const text = formatBlockDetails(d);
    assert.match(text, /HTTP-статус:\s+200/);
    assert.match(text, /x-protected-by: React Labs/);
    assert.doesNotMatch(text, /secret123/); // значения cookie в лог не попадают
  });
});
