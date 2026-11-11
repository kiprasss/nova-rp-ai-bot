import { readFileSync } from 'node:fs';
import { config } from './config.js';
import { initSecretKey } from './crypto.js';
import { openDatabase } from './db/database.js';
import { answerQuestion } from './ai/answer.js';

/**
 * npm run ask -- [--guild <id>] [--file вопросы.txt] [--context] [--delay сек] ["вопрос" ...]
 * Задать боту вопросы без Discord — тот же поиск, промпт и модель, что и на сервере.
 * Нужно для настройки промпта: спросили → посмотрели ответ → поправили src/ai/prompt.ts → снова спросили.
 * В файле — по одному вопросу на строку, строки с # пропускаются, «> вопрос» — продолжение предыдущего. --context — показать фрагменты, которые получила модель.
 */
const args = process.argv.slice(2);
let guildId: string | null = null;
let showContext = false;
let delaySec = 5;
const questions: string[] = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--guild') guildId = args[++i] ?? null;
  else if (args[i] === '--context') showContext = true;
  else if (args[i] === '--delay') delaySec = Number(args[++i]) || 0;
  else if (args[i] === '--file') {
    for (const line of readFileSync(args[++i], 'utf8').split('\n')) {
      if (line.trim() && !line.trim().startsWith('#')) questions.push(line.trim());
    }
  } else questions.push(args[i]);
}
if (!questions.length) {
  console.error('Использование: npm run ask -- [--guild <id>] [--file вопросы.txt] "вопрос"');
  process.exit(1);
}

initSecretKey(config.encryptionKey);
const db = openDatabase(config.databasePath);
// По умолчанию — первый сервер с AI-токеном, чтобы были его настройки (модель, тон, указания).
guildId ??=
  (db.prepare('SELECT guild_id FROM guilds WHERE ai_token IS NOT NULL ORDER BY guild_id LIMIT 1').get() as { guild_id: string } | undefined)
    ?.guild_id ?? null;

// Строка, начинающаяся с «>», — продолжение разговора: бот получает предыдущий вопрос и свой ответ.
let previous: { question: string; answer: string } | null = null;
for (const [i, line] of questions.entries()) {
  const followUp = line.startsWith('>');
  const question = followUp ? line.slice(1).trim() : line;
  console.log(`\n=== [${i + 1}/${questions.length}] ${followUp ? '↳ ' : ''}${question}`);
  try {
    const r = await answerQuestion({ guildId, userId: 'ask-cli', question, previous: followUp ? previous : null });
    previous = { question, answer: r.text.replace(/\n+\*\*Источники:\*\*[\s\S]*$/, '') };
    if (showContext) {
      if (r.kind === 'ai') console.log(`  поиск: ${r.rewritten ?? '(AI не переписал запрос)'}`);
      for (const f of r.fragments ?? []) console.log(`  [${f.n}] (${f.kind ?? '?'}) ${f.title}: ${f.text.replace(/\s+/g, ' ').slice(0, 160)}`);
    }
    console.log(`--- (${r.kind})\n${r.text}`);
  } catch (err) {
    console.log(`--- ОШИБКА: ${err instanceof Error ? err.message : String(err)}`);
  }
  // Пауза между вопросами — чтобы не упираться в лимиты провайдера (токен общий с ботом).
  if (i < questions.length - 1) await new Promise((r) => setTimeout(r, delaySec * 1000));
}
