import { ActivityType, Client, Events, GatewayIntentBits, Partials } from 'discord.js';
import { syncCommands } from './commands/sync.js';
import { assertRuntimeConfig, config } from './config.js';
import { initSecretKey } from './crypto.js';
import { openDatabase } from './db/database.js';
import { onInteraction, onMessage } from './discord/router.js';
import { seedGlobalSources, startScheduler } from './scheduler.js';
import { log, setLogLevel } from './util/logger.js';

setLogLevel(config.logLevel);
assertRuntimeConfig();
initSecretKey(config.encryptionKey);
openDatabase(config.databasePath);
seedGlobalSources();

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
  ],
  partials: [Partials.Channel, Partials.Message],
});

client.once(Events.ClientReady, (c) => {
  log.info(`Бот запущен как ${c.user.tag}. Серверов: ${c.guilds.cache.size}`);
  c.user.setActivity('вопросы о NOVA RP | /помощь', { type: ActivityType.Listening });
  startScheduler(c);
  void syncCommands(c);
});

client.on(Events.InteractionCreate, (i) => void onInteraction(i));
client.on(Events.MessageCreate, (m) => void onMessage(client, m));
client.on(Events.Error, (err) => log.error('Ошибка клиента Discord', err));

process.on('unhandledRejection', (err) => log.error('Необработанное отклонение промиса', err));
process.on('uncaughtException', (err) => log.error('Необработанное исключение', err));

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    log.info('Остановка бота…');
    void client.destroy().finally(() => process.exit(0));
  });
}

await client.login(config.discordToken);
