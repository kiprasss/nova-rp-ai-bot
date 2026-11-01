import { ActivityType, Client, DiscordjsErrorCodes, Events, GatewayIntentBits, Partials } from 'discord.js';
import { attachSharedToken } from './db/repo.js';
import { syncCommands } from './commands/sync.js';
import { assertRuntimeConfig, config } from './config.js';
import { initSecretKey } from './crypto.js';
import { openDatabase } from './db/database.js';
import { importSeedIfEmpty } from './kbSeed.js';
import { onInteraction, onMessage } from './discord/router.js';
import { seedGlobalSources, startScheduler } from './scheduler.js';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { setForumDebugDir } from './forum/blockDiagnostics.js';
import { acquireInstanceLock } from './util/instanceLock.js';
import { log, setLogLevel } from './util/logger.js';

setLogLevel(config.logLevel);
assertRuntimeConfig();

const runningPid = acquireInstanceLock(join(dirname(config.databasePath), 'bot.lock'));
if (runningPid) {
  log.error(
    `Бот уже запущен на этом компьютере (процесс ${runningPid}). Второй экземпляр не запускается — ` +
      'иначе каждое действие будет обрабатываться дважды. Закройте лишнее окно или используйте уже запущенный бот.',
  );
  process.exit(3); // код 3 — start.bat не перезапускает бота
}

initSecretKey(config.encryptionKey);
setForumDebugDir(dirname(config.databasePath)); // data/logs/forum.log и страница блокировки
openDatabase(config.databasePath);
importSeedIfEmpty();
seedGlobalSources();

// После неудачного login() discord.js уничтожает клиент (ws.destroyed = true навсегда): даже если следующая
// попытка подключится, isReady() остаётся false и обрыв связи больше не переподключается. Поэтому на каждую
// попытку входа — новый клиент.
function createClient(): Client {
  const c = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.DirectMessages,
    ],
    partials: [Partials.Channel, Partials.Message],
  });

  c.once(Events.ClientReady, (ready) => {
    log.info(`Бот запущен как ${ready.user.tag}. Серверов: ${ready.guilds.cache.size}`);
    ready.user.setActivity('вопросы о NOVA RP | /помощь', { type: ActivityType.Listening });
    const attached = attachSharedToken();
    if (attached) log.info(`Общий AI-токен привязан к серверам: ${attached}`);
    startScheduler(ready);
    void syncCommands(ready);
  });
  c.on(Events.InteractionCreate, (i) => void onInteraction(i));
  c.on(Events.MessageCreate, (m) => void onMessage(c, m));
  c.on(Events.Error, (err) => log.error('Ошибка клиента Discord', err));
  return c;
}

let client = createClient();

// Пульс для внешнего мониторинга (server-monitor.py): файл обновляется, только пока бот подключён к Discord.
const heartbeatFile = join(dirname(config.databasePath), 'heartbeat.json');
setInterval(() => {
  if (!client.isReady()) return;
  try {
    writeFileSync(heartbeatFile, JSON.stringify({ ts: Date.now(), ping: client.ws.ping }));
  } catch (err) {
    log.warn('Не удалось записать heartbeat', err);
  }
}, 30_000).unref();

process.on('unhandledRejection', (err) => log.error('Необработанное отклонение промиса', err));
process.on('uncaughtException', (err) => log.error('Необработанное исключение', err));

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    log.info('Остановка бота…');
    void client.destroy().finally(() => process.exit(0));
  });
}

// После включения компьютера сеть может появиться позже бота — повторяем вход, пока не получится.
for (let attempt = 1; ; attempt++) {
  try {
    await client.login(config.discordToken);
    break;
  } catch (err) {
    if (err instanceof Error && 'code' in err && err.code === DiscordjsErrorCodes.TokenInvalid) throw err;
    const delay = Math.min(60, attempt * 5);
    log.error(`Не удалось подключиться к Discord (попытка ${attempt}), повтор через ${delay} с`, err);
    await new Promise((r) => setTimeout(r, delay * 1000));
    client = createClient();
  }
}
