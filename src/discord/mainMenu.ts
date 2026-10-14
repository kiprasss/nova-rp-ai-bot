import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  StringSelectMenuBuilder,
  type BaseMessageOptions,
} from 'discord.js';
import { COLORS } from './guildLog.js';
import { canOpenSection, type ActorPerms, type Section } from './permissions.js';

/** perms — показать только разделы, доступные пользователю (в ЛС и эфемерных меню). */
export function buildMainMenu(guildId: string, guildName?: string, perms?: ActorPerms): BaseMessageOptions {
  const embed = new EmbedBuilder()
    .setColor(COLORS.info)
    .setTitle('⚙️ Панель управления NOVA RP AI')
    .setDescription(
      [
        guildName ? `Сервер: **${guildName}**\n` : '',
        'Выберите раздел в меню ниже:',
        '🪄 **Мастер настройки** — проверить сервер и применить рекомендации одним нажатием',
        '👥 **Роли** — кто и как может пользоваться ботом',
        '🔑 **AI-токен** — провайдер, токен и модель',
        '🧠 **Настройки AI** — длина и точность ответов, умный поиск, свои инструкции',
        '📚 **Источники** — ссылки форума и автообновление базы знаний',
        '📺 **Каналы** — назначение каналов бота',
        '📌 **FAQ** — быстрые ответы (приоритет над AI)',
        '📊 **Статус** — состояние базы знаний и статистика',
        '',
        '_Права проверяются при каждом действии. Все изменения записываются в #ai-логи._',
      ]
        .filter((l, i) => i !== 0 || l)
        .join('\n'),
    );

  const select = new StringSelectMenuBuilder()
    .setCustomId(`cfg:main:${guildId}`)
    .setPlaceholder('Выберите раздел настроек…')
    .addOptions(
      ...[
      { label: 'Мастер настройки', value: 'wizard', emoji: '🪄', description: 'Проверка сервера и рекомендуемые настройки' },
      { label: 'Роли', value: 'roles', emoji: '👥', description: 'Создать или выбрать роль и задать права' },
      { label: 'AI-токен', value: 'ai', emoji: '🔑', description: 'Провайдер, токен, модель, проверка токена' },
      { label: 'Настройки AI', value: 'aiset', emoji: '🧠', description: 'Длина, точность, контекст, свои инструкции' },
      { label: 'Источники', value: 'sources', emoji: '📚', description: 'Ссылки форума и интервал обновления' },
      { label: 'Каналы', value: 'channels', emoji: '📺', description: 'Какой канал для чего используется' },
      { label: 'FAQ', value: 'faq', emoji: '📌', description: 'Быстрые ответы администраторов' },
      { label: 'Статус', value: 'status', emoji: '📊', description: 'Индексация, обновления, запросы AI' },
      ].filter((o) => !perms || canOpenSection(perms, o.value as Section)),
    );

  const components: (ActionRowBuilder<StringSelectMenuBuilder> | ActionRowBuilder<ButtonBuilder>)[] = [
    new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select),
  ];
  // guildName передаётся только в ЛС (/setupls → «Мои серверы») — там нужен путь назад.
  if (guildName) {
    components.push(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId('dm:open:servers').setLabel('К серверам').setStyle(ButtonStyle.Secondary).setEmoji('⬅️'),
        new ButtonBuilder().setCustomId('dm:open:home').setLabel('Главное меню').setStyle(ButtonStyle.Secondary).setEmoji('🏠'),
      ),
    );
  }
  return { embeds: [embed], components };
}
