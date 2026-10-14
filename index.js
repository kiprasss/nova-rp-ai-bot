// Запуск для хостингов с панелью (bot-hosting.net, Pterodactyl и т.п.): «главный файл» — index.js.
// 1) проверяет версию Node.js; 2) собирает TypeScript, если код изменился (например, после git pull);
// 3) запускает бота (на Node 22.5–22.12 — с флагом --experimental-sqlite).
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));
const [major, minor] = process.versions.node.split('.').map(Number);

if (major < 22 || (major === 22 && minor < 5)) {
  console.error(
    `❌ Нужен Node.js 22 или новее (сейчас ${process.versions.node}). ` +
      'В панели хостинга выберите образ Node.js 22/24 (Startup → Docker Image) и перезапустите сервер.',
  );
  process.exit(1);
}

/** Хэш всех исходников: если он изменился — пересобираем. */
function sourceHash() {
  const h = createHash('sha1');
  const walk = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (p.endsWith('.ts')) h.update(p).update(readFileSync(p));
    }
  };
  walk(join(root, 'src'));
  h.update(readFileSync(join(root, 'package.json')));
  return h.digest('hex');
}

const entry = join(root, 'dist', 'src', 'index.js');
const stampFile = join(root, 'dist', '.build-stamp');
const hash = sourceHash();
const stamp = existsSync(stampFile) ? readFileSync(stampFile, 'utf8') : '';

if (!existsSync(entry) || stamp !== hash) {
  console.log('🔨 Сборка TypeScript…');
  const tsc = join(root, 'node_modules', 'typescript', 'bin', 'tsc');
  if (!existsSync(tsc)) {
    console.error('❌ Не найден TypeScript. Убедитесь, что хостинг выполнил «npm install» (нужен package.json), и перезапустите.');
    process.exit(1);
  }
  const res = spawnSync(process.execPath, [tsc, '-p', join(root, 'tsconfig.json')], { stdio: 'inherit', cwd: root });
  if (res.status !== 0) {
    console.error('❌ Сборка не удалась — см. ошибки выше.');
    process.exit(1);
  }
  writeFileSync(stampFile, hash);
  console.log('✅ Сборка готова');
}

let sqliteOk = true;
try {
  await import('node:sqlite');
} catch {
  sqliteOk = false;
}

if (sqliteOk) {
  await import(new URL('./dist/src/index.js', import.meta.url).href);
} else {
  // Node 22.5–22.12: модуль node:sqlite включается флагом.
  const res = spawnSync(process.execPath, ['--experimental-sqlite', entry], { stdio: 'inherit', cwd: root });
  process.exit(res.status ?? 1);
}
