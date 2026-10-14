import { REST, Routes } from 'discord.js';
import { commandDefinitions } from './commands/definitions.js';
import { config } from './config.js';

/**
 * Регистрация slash-команд.
 *   npm run deploy              — глобально (нужно для /setupls в ЛС; появляется в течение нескольких минут)
 *   npm run deploy -- --guild   — только на DEV_GUILD_ID (мгновенно, для тестов)
 *   npm run deploy -- --clear-guild — удалить команды с DEV_GUILD_ID (чтобы не было дублей)
 */
if (!config.discordToken || !config.clientId) {
  console.error('Заполните DISCORD_TOKEN и DISCORD_CLIENT_ID в .env');
  process.exit(1);
}

const rest = new REST({ version: '10' }).setToken(config.discordToken);
const args = new Set(process.argv.slice(2));

if (args.has('--guild') || args.has('--clear-guild')) {
  if (!config.devGuildId) {
    console.error('Укажите DEV_GUILD_ID в .env');
    process.exit(1);
  }
  const body = args.has('--clear-guild') ? [] : commandDefinitions;
  await rest.put(Routes.applicationGuildCommands(config.clientId, config.devGuildId), { body });
  console.log(`✅ Команды на сервере ${config.devGuildId}: ${body.length}`);
} else {
  await rest.put(Routes.applicationCommands(config.clientId), { body: commandDefinitions });
  console.log(`✅ Глобально зарегистрировано команд: ${commandDefinitions.length}. Обновление в Discord может занять несколько минут.`);
}
