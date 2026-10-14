import {
  ApplicationIntegrationType,
  ChannelType,
  InteractionContextType,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type RESTPostAPIChatInputApplicationCommandsJSONBody,
} from 'discord.js';

const BOTH_INSTALLS = [ApplicationIntegrationType.GuildInstall, ApplicationIntegrationType.UserInstall];
const GUILD_AND_DM = [InteractionContextType.Guild, InteractionContextType.BotDM];

export const commandDefinitions: RESTPostAPIChatInputApplicationCommandsJSONBody[] = [
  new SlashCommandBuilder()
    .setName('setup')
    .setDescription('Создать категорию «NOVA RP AI» с каналами и меню настроек (только администраторы)')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .setContexts(InteractionContextType.Guild)
    .setIntegrationTypes(ApplicationIntegrationType.GuildInstall)
    .toJSON(),

  new SlashCommandBuilder()
    .setName('setupls')
    .setDescription('Личное меню бота в ЛС: мои серверы, личный токен, личные настройки')
    .setContexts(InteractionContextType.BotDM, InteractionContextType.Guild)
    .setIntegrationTypes(...BOTH_INSTALLS)
    .toJSON(),

  new SlashCommandBuilder()
    .setName('вопрос')
    .setDescription('Задать вопрос AI-помощнику NOVA RP')
    .addStringOption((o) => o.setName('текст').setDescription('Ваш вопрос о NOVA RP').setRequired(true).setMaxLength(1000))
    .addBooleanOption((o) => o.setName('скрытно').setDescription('Показать ответ только вам'))
    .setContexts(...GUILD_AND_DM)
    .setIntegrationTypes(...BOTH_INSTALLS)
    .toJSON(),

  new SlashCommandBuilder()
    .setName('правило')
    .setDescription('Показать пункт правил и наказание (например, 5.4)')
    .addStringOption((o) => o.setName('номер').setDescription('Номер пункта, например 5.4').setRequired(true).setAutocomplete(true).setMaxLength(12))
    .setContexts(...GUILD_AND_DM)
    .setIntegrationTypes(...BOTH_INSTALLS)
    .toJSON(),

  new SlashCommandBuilder()
    .setName('наказание')
    .setDescription('Какое наказание за пункт правил и даёт ли повтор WARN')
    .addStringOption((o) => o.setName('пункт').setDescription('Номер пункта, например 5.4').setRequired(true).setAutocomplete(true).setMaxLength(12))
    .setContexts(...GUILD_AND_DM)
    .setIntegrationTypes(...BOTH_INSTALLS)
    .toJSON(),

  new SlashCommandBuilder()
    .setName('жалоба')
    .setDescription('Помощник: составить жалобу на игрока по форме форума')
    .setContexts(...GUILD_AND_DM)
    .setIntegrationTypes(...BOTH_INSTALLS)
    .toJSON(),

  new SlashCommandBuilder()
    .setName('faq')
    .setDescription('Быстрые ответы от администрации сервера')
    .addStringOption((o) => o.setName('вопрос').setDescription('Найти ответ по вопросу').setAutocomplete(true).setMaxLength(200))
    .setContexts(InteractionContextType.Guild)
    .setIntegrationTypes(ApplicationIntegrationType.GuildInstall)
    .toJSON(),

  new SlashCommandBuilder()
    .setName('мой-id')
    .setDescription('Привязать игровой ID: бот сообщит, если на форуме подадут жалобу на этот ID')
    .addSubcommand((s) =>
      s
        .setName('добавить')
        .setDescription('Привязать свой игровой ID (до 3)')
        .addStringOption((o) => o.setName('id').setDescription('Ваш игровой ID (только цифры)').setRequired(true).setMaxLength(7)),
    )
    .addSubcommand((s) =>
      s
        .setName('удалить')
        .setDescription('Отвязать игровой ID')
        .addStringOption((o) => o.setName('id').setDescription('Игровой ID').setRequired(true).setMaxLength(7)),
    )
    .addSubcommand((s) => s.setName('список').setDescription('Мои привязанные ID и последние жалобы на них'))
    .addSubcommand((s) => s.setName('проверить').setDescription('Проверить форум прямо сейчас (новые и существующие жалобы на мои ID)'))
    .setContexts(...GUILD_AND_DM)
    .setIntegrationTypes(...BOTH_INSTALLS)
    .toJSON(),

  new SlashCommandBuilder()
    .setName('импорт')
    .setDescription('Загрузить знания из файла (.txt/.md или сохранённая страница форума .html)')
    .addAttachmentOption((o) => o.setName('файл').setDescription('Файл .txt, .md, .html (до 3 МБ)').setRequired(true))
    .addStringOption((o) =>
      o.setName('ссылка').setDescription('Ссылка на оригинал на форуме — AI покажет её как источник').setRequired(true).setMaxLength(300),
    )
    .addStringOption((o) => o.setName('название').setDescription('Название (необязательно)').setMaxLength(150))
    .setContexts(InteractionContextType.Guild)
    .setIntegrationTypes(ApplicationIntegrationType.GuildInstall)
    .toJSON(),

  new SlashCommandBuilder()
    .setName('clean')
    .setDescription('Удалить сообщения бота в канале или в ЛС (меню и важное не трогает)')
    .addChannelOption((o) =>
      o
        .setName('канал')
        .setDescription('Канал для очистки (по умолчанию — текущий)')
        .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.PublicThread, ChannelType.PrivateThread),
    )
    .addIntegerOption((o) => o.setName('количество').setDescription('Сколько последних сообщений удалить (1–1000, по умолчанию 100)').setMinValue(1).setMaxValue(1000))
    .addStringOption((o) =>
      o.setName('сообщение').setDescription('ID или ссылка на одно сообщение — удалить именно его (даже меню и защищённые)').setMaxLength(200),
    )
    .setContexts(...GUILD_AND_DM)
    .setIntegrationTypes(...BOTH_INSTALLS)
    .toJSON(),

  new SlashCommandBuilder()
    .setName('помощь')
    .setDescription('Список команд AI-помощника NOVA RP')
    .setContexts(...GUILD_AND_DM)
    .setIntegrationTypes(...BOTH_INSTALLS)
    .toJSON(),
];
