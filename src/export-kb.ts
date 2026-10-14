import { config } from './config.js';
import { openDatabase } from './db/database.js';
import { SEED_FILE, exportSeed } from './kbSeed.js';

/** npm run kb:export — сохранить темы правил из data/bot.db в seed/knowledge.json (для нового хостинга). */
openDatabase(config.databasePath);
const n = exportSeed();
console.log(`✅ Экспортировано тем правил: ${n} → ${SEED_FILE}`);
