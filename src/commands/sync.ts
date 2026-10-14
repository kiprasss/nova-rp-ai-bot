import type { Client } from 'discord.js';
import { log } from '../util/logger.js';
import { commandDefinitions } from './definitions.js';

/** Краткий «отпечаток» команды: имя, описание и параметры — чтобы понять, изменилась ли она. */
function fingerprint(c: { name: string; description: string; options?: readonly { name: string; type: number }[] }): string {
  return `${c.name}|${c.description}|${(c.options ?? []).map((o) => `${o.name}:${o.type}`).join(',')}`;
}

/**
 * При запуске сверяет глобальные slash-команды с кодом и перерегистрирует их, если что-то
 * добавилось или изменилось. Так новые команды (например, /clean) появляются без ручного `npm run deploy`.
 */
export async function syncCommands(client: Client<true>): Promise<void> {
  try {
    const existing = await client.application.commands.fetch();
    const have = new Set(existing.map((c) => fingerprint({ name: c.name, description: c.description, options: c.options })));
    const want = commandDefinitions.map((c) => fingerprint({ name: c.name, description: c.description, options: c.options }));
    const same = have.size === want.length && want.every((f) => have.has(f));
    if (same) {
      log.info(`Slash-команды актуальны (${want.length})`);
      return;
    }
    await client.application.commands.set(commandDefinitions);
    log.info(`Slash-команды обновлены: ${commandDefinitions.map((c) => `/${c.name}`).join(', ')}. В Discord они появятся в течение нескольких минут (или после перезапуска Discord: Ctrl+R).`);
  } catch (err) {
    log.warn('Не удалось синхронизировать slash-команды — выполните npm run deploy вручную', err);
  }
}
