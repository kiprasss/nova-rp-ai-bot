import { EmbedBuilder, MessageFlags, type ChatInputCommandInteraction } from 'discord.js';
import { COLORS, audit } from '../discord/guildLog.js';
import { computePerms } from '../discord/permissions.js';
import { dispatchRuleUpdates } from '../discord/ruleUpdates.js';
import { formatFromFileName, importManual } from '../forum/manualImport.js';
import { UserError } from '../util/errors.js';
import { truncate } from '../util/text.js';

const MAX_BYTES = 3 * 1024 * 1024;

/** /импорт файл:<…> ссылка:<…> — ручная загрузка знаний, когда форум недоступен боту. */
export async function cmdImport(i: ChatInputCommandInteraction): Promise<void> {
  if (!i.inCachedGuild()) throw new UserError('Команда работает только на сервере с ботом.');
  const perms = computePerms(await i.guild.members.fetch({ user: i.user.id, force: true }));
  if (!perms.isAdmin && !perms.manageSources) throw new UserError('⛔ Нужно право «Управлять источниками форума» (меню «Роли»).');

  const file = i.options.getAttachment('файл', true);
  const format = formatFromFileName(file.name);
  if (!format) throw new UserError('Поддерживаются файлы .txt, .md и .html (сохранённая страница форума).');
  if (file.size > MAX_BYTES) throw new UserError('Файл больше 3 МБ. Разделите его на части или сохраните только нужную тему.');

  await i.deferReply({ flags: MessageFlags.Ephemeral });
  const res = await fetch(file.url, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new UserError('Не удалось скачать файл из Discord. Попробуйте ещё раз.');
  const content = await res.text();

  const result = importManual({
    scope: i.guild.id,
    url: i.options.getString('ссылка', true),
    title: i.options.getString('название'),
    content,
    format,
    userId: i.user.id,
  });
  await audit(
    i.client,
    i.guild.id,
    i.user.id,
    'Импорт файла',
    `${file.name} → ${result.title} (${result.url}); пунктов правил ${result.rules}, изменений ${result.ruleChanges}`,
  );
  if (result.ruleChanges) await dispatchRuleUpdates(i.client).catch(() => undefined);

  const embed = new EmbedBuilder()
    .setColor(COLORS.ok)
    .setTitle('📥 Импорт выполнен')
    .setDescription(
      [
        `**${truncate(result.title, 200)}**`,
        `Источник для ответов AI: <${result.url}>`,
        '',
        `Формат: ${result.fromSavedPage ? 'сохранённая страница форума (разобрана как тема)' : format === 'html' ? 'HTML → текст' : format === 'md' ? 'Markdown' : 'текст'}`,
        `Фрагментов: **${result.chunks}** · пунктов правил: **${result.rules}**${result.isRules ? ' (распознано как правила)' : ''}`,
        result.ruleChanges ? `Изменений в правилах: **${result.ruleChanges}** — опубликованы в #ai-правила` : '',
        '',
        'Повторный импорт той же ссылки заменяет старую версию.',
      ]
        .filter((l, idx, arr) => l || arr[idx - 1])
        .join('\n'),
    );
  await i.editReply({ embeds: [embed] });
}
