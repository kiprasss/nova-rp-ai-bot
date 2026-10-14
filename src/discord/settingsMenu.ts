import {
  ButtonStyle,
  ChannelSelectMenuBuilder,
  ChannelType,
  EmbedBuilder,
  MessageFlags,
  StringSelectMenuBuilder,
  TextInputStyle,
  type BaseMessageOptions,
  type Client,
  type Guild,
  type MessageComponentInteraction,
  type ModalSubmitInteraction,
} from 'discord.js';
import { PROVIDERS, isProviderId, verifyToken, type ProviderId } from '../ai/providers.js';
import { invalidateSearchIndex } from '../ai/search.js';
import { config } from '../config.js';
import { maskSecret, secrets } from '../crypto.js';
import {
  PERM_FLAGS,
  ACCESS_FLAGS,
  BOT_COMMANDS,
  blockedCommandsOf,
  newRolePerm,
  addFaq,
  addSource,
  aiRequestStats,
  deleteFaq,
  deleteRolePerm,
  deleteSource,
  ensureGuildRow,
  getFaq,
  getGuild,
  getRolePerm,
  getRolePerms,
  getSource,
  kbStats,
  listFaq,
  listSources,
  updateGuild,
  upsertRolePerm,
  type PermFlag,
  type AccessFlag,
  type RolePerm,
} from '../db/repo.js';
import { isRefreshing, refreshScope, type RefreshReport } from '../forum/refresh.js';
import { normalizeForumUrl } from '../forum/url.js';
import { UserError } from '../util/errors.js';
import { formatDateTime, truncate } from '../util/text.js';
import { COLORS, audit, logToGuild } from './guildLog.js';
import { buildMainMenu } from './mainMenu.js';
import { clearDmTokenCache, requireSection, type ActorPerms, type Section } from './permissions.js';
import {
  CHANNEL_NAMES,
  PURPOSES,
  PURPOSE_LABELS,
  applySetup,
  channelIdFor,
  postSettingsMenu,
  setChannelFor,
  syncAllRoleAccess,
  type Purpose,
} from './setupGuild.js';
import { log } from '../util/logger.js';
import { CUSTOM_MODEL, liveModels, modelSelect, promptStyleLabel } from './modelSelect.js';
import { dispatchRuleUpdates } from './ruleUpdates.js';
import { analyzeGuild, applyPlan } from './wizard.js';
import { button, ephemeralIfGuild, modal, row, textInput, updateOrReply, type Row } from './ui.js';

type CfgInteraction = MessageComponentInteraction | ModalSubmitInteraction;

const PERM_LABELS: Record<PermFlag, { label: string; description: string; emoji: string }> = {
  can_ask: { label: 'Задавать вопросы AI', description: 'Разрешить вопросы боту', emoji: '💬' },
  any_channel: { label: 'В любом канале', description: 'Иначе — только в #ai-помощник', emoji: '🌐' },
  manage_sources: { label: 'Управлять источниками форума', description: 'Источники, обновление базы, FAQ', emoji: '📚' },
  manage_ai: { label: 'Менять AI-токен и модель', description: 'Раздел «AI-токен»', emoji: '🔑' },
  view_logs: { label: 'Просматривать логи', description: 'Доступ к #ai-логи и статусу', emoji: '📜' },
};

const ACCESS_LABELS: Record<AccessFlag, { label: string; description: string; emoji: string }> = {
  see_channels: { label: 'Видит каналы бота', description: '#ai-помощник и #ai-правила', emoji: '👁' },
  can_write: { label: 'Может писать в #ai-помощник', description: 'Иначе канал только для чтения', emoji: '✍️' },
  see_settings: { label: 'Видит #ai-настройки', description: 'Меню; разделы — по правам роли', emoji: '⚙️' },
  dm_access: { label: 'Бот в ЛС с токеном сервера', description: 'Вопросы в ЛС без личного токена', emoji: '📨' },
};

const COMMAND_LABELS: Record<(typeof BOT_COMMANDS)[number], string> = {
  вопрос: 'Задать вопрос AI',
  правило: 'Текст пункта правил',
  наказание: 'Наказание за пункт',
  жалоба: 'Помощник жалоб',
  faq: 'Быстрые ответы',
  помощь: 'Список команд',
  setupls: 'Личное меню в ЛС',
  'мой-id': 'Уведомления о жалобах на свой ID',
};

const OP_SECTION: Record<string, Section> = {
  rolesel: 'roles', rolenew: 'roles', rolenewm: 'roles', roleperm: 'roles', roleaccess: 'roles', rolecmd: 'roles', rolelim: 'roles', rolelimm: 'roles', roledel: 'roles',
  prov: 'ai', tok: 'ai', tokm: 'ai', modelsel: 'ai', modelm: 'ai', tokchk: 'ai', tokdel: 'ai',
  srcadd: 'sources', srcaddm: 'sources', srcdel: 'sources', srcint: 'sources', srcintm: 'sources', srcref: 'sources',
  chan: 'channels', chanp: 'channels', chanfix: 'channels',
  faqadd: 'faq', faqaddm: 'faq', faqdel: 'faq',
  ailen: 'aiset', aitemp: 'aiset', aictx: 'aiset', airew: 'aiset', aisrc: 'aiset', aiinst: 'aiset', aiinstm: 'aiset',
  aipage2: 'aiset', aitone: 'aiset', aimax: 'aiset', aifb: 'aiset',
  aicmp: 'aiset', aiauto: 'aiset', aithr: 'aiset', aimdl: 'aiset', aifaq: 'aiset',
  wizapply: 'wizard',
};

// ---------- Представления разделов ----------

function back(guildId: string) {
  return button(`cfg:open:${guildId}:home`, 'Назад', ButtonStyle.Secondary, '⬅️');
}

function permSummary(p: RolePerm | undefined): string {
  if (!p) return 'не настроена';
  const parts = [
    ...PERM_FLAGS.filter((f) => p[f]).map((f) => PERM_LABELS[f].emoji),
    ...ACCESS_FLAGS.filter((f) => p[f]).map((f) => ACCESS_LABELS[f].emoji),
  ];
  const blocked = blockedCommandsOf(p).size;
  return `${parts.join(' ') || '—'} · ${p.hourly_limit === 0 ? 'без лимита' : `${p.hourly_limit}/ч`}${blocked ? ` · 🚫 ${blocked} ком.` : ''}`;
}

function viewRoles(guild: Guild, note?: string): BaseMessageOptions {
  const perms = getRolePerms(guild.id);
  const configured = perms
    .map((p) => `• ${p.role_id === guild.id ? '@everyone' : `<@&${p.role_id}>`} — ${permSummary(p)}`)
    .join('\n');
  const embed = new EmbedBuilder()
    .setColor(COLORS.info)
    .setTitle('👥 Роли и права')
    .setDescription(
      [
        note ?? '',
        '**Настроенные роли:**',
        configured || '_Пока нет — все участники могут спрашивать в #ai-помощник с лимитом по умолчанию._',
        '',
        'Легенда: 💬 вопросы · 🌐 любой канал · 📚 источники · 🔑 AI-токен · 📜 логи · 👁 видит каналы · ✍️ пишет · ⚙️ видит настройки · 📨 ЛС · 🚫 запрещённые команды',
        'Выберите роль в списке или создайте новую.',
      ]
        .filter((l, i) => i !== 0 || l)
        .join('\n'),
    );

  const configuredIds = new Set(perms.map((p) => p.role_id));
  const roles = [...guild.roles.cache.values()]
    .filter((r) => !r.managed)
    .sort((a, b) => Number(configuredIds.has(b.id)) - Number(configuredIds.has(a.id)) || b.position - a.position)
    .slice(0, 25);
  const select = new StringSelectMenuBuilder()
    .setCustomId(`cfg:rolesel:${guild.id}`)
    .setPlaceholder('Выберите существующую роль…')
    .addOptions(
      roles.map((r) => ({
        label: truncate(r.id === guild.id ? '@everyone (все участники)' : r.name, 100),
        value: r.id,
        description: truncate(permSummary(perms.find((p) => p.role_id === r.id)), 100),
      })),
    );
  return {
    embeds: [embed],
    components: [row(select), row(button(`cfg:rolenew:${guild.id}`, 'Создать роль', ButtonStyle.Success, '➕'), back(guild.id))],
  };
}

function defaultPerm(guildId: string, roleId: string): RolePerm {
  return newRolePerm(guildId, roleId, config.defaultUserHourlyLimit);
}

function viewRole(guild: Guild, roleId: string, note?: string): BaseMessageOptions {
  const stored = getRolePerm(guild.id, roleId);
  const p = stored ?? defaultPerm(guild.id, roleId);
  const isEveryone = roleId === guild.id;
  const name = isEveryone ? '@everyone' : (guild.roles.cache.get(roleId)?.name ?? roleId);
  const blocked = blockedCommandsOf(p);

  const lines = [
    '**AI и настройки**',
    ...PERM_FLAGS.map((f) => `${p[f] ? '✅' : '❌'} ${PERM_LABELS[f].label}`),
    `⏱ Лимит вопросов в час: **${p.hourly_limit === 0 ? 'без лимита' : p.hourly_limit}**`,
    '',
    '**Каналы и ЛС**',
    ...ACCESS_FLAGS.filter((f) => !(isEveryone && f === 'see_settings')).map((f) => `${p[f] ? '✅' : '❌'} ${ACCESS_LABELS[f].label}`),
    '',
    '**Команды**',
    blocked.size ? `🚫 Запрещены: ${[...blocked].map((c) => `/${c}`).join(', ')}` : '✅ Все команды разрешены',
  ];
  const embed = new EmbedBuilder()
    .setColor(COLORS.info)
    .setTitle(`👥 Роль: ${name}`)
    .setDescription(`${note ? `${note}\n\n` : ''}${stored ? '' : '_Роль ещё не настроена — ниже значения по умолчанию._\n\n'}${lines.join('\n')}`)
    .setFooter({
      text:
        'Отметьте нужное в списках (можно несколько). Если у человека несколько ролей — действует самое широкое разрешение. ' +
        'Администраторы видят и могут всё.',
    });

  const permSelect = new StringSelectMenuBuilder()
    .setCustomId(`cfg:roleperm:${guild.id}:${roleId}`)
    .setPlaceholder('💬 Права AI и настроек…')
    .setMinValues(0)
    .setMaxValues(PERM_FLAGS.length)
    .addOptions(
      PERM_FLAGS.map((f) => ({
        label: PERM_LABELS[f].label,
        description: PERM_LABELS[f].description,
        emoji: PERM_LABELS[f].emoji,
        value: f,
        default: !!p[f],
      })),
    );
  const accessFlags = ACCESS_FLAGS.filter((f) => !(isEveryone && f === 'see_settings'));
  const accessSelect = new StringSelectMenuBuilder()
    .setCustomId(`cfg:roleaccess:${guild.id}:${roleId}`)
    .setPlaceholder('👁 Каналы бота и ЛС…')
    .setMinValues(0)
    .setMaxValues(accessFlags.length)
    .addOptions(
      accessFlags.map((f) => ({
        label: ACCESS_LABELS[f].label,
        description: ACCESS_LABELS[f].description,
        emoji: ACCESS_LABELS[f].emoji,
        value: f,
        default: !!p[f],
      })),
    );
  const cmdSelect = new StringSelectMenuBuilder()
    .setCustomId(`cfg:rolecmd:${guild.id}:${roleId}`)
    .setPlaceholder('⌨️ Разрешённые команды…')
    .setMinValues(0)
    .setMaxValues(BOT_COMMANDS.length)
    .addOptions(
      BOT_COMMANDS.map((c) => ({
        label: `/${c}`,
        description: COMMAND_LABELS[c],
        value: c,
        default: !blocked.has(c),
      })),
    );
  return {
    embeds: [embed],
    components: [
      row(permSelect),
      row(accessSelect),
      row(cmdSelect),
      row(
        button(`cfg:rolelim:${guild.id}:${roleId}`, 'Лимит в час', ButtonStyle.Primary, '⏱'),
        button(`cfg:roledel:${guild.id}:${roleId}`, 'Сбросить права', ButtonStyle.Danger, '🗑'),
        button(`cfg:open:${guild.id}:roles`, 'К ролям', ButtonStyle.Secondary, '⬅️'),
      ),
    ],
  };
}

async function viewAi(guild: Guild, note?: string): Promise<BaseMessageOptions> {
  const g = ensureGuildRow(guild.id, config.defaultRefreshHours);
  const provider = isProviderId(g.ai_provider) ? PROVIDERS[g.ai_provider] : null;
  let masked = 'не задан';
  if (g.ai_token) {
    try {
      masked = `\`${maskSecret(secrets.decrypt(g.ai_token))}\``;
    } catch {
      masked = '⚠️ не расшифровывается (сменился ENCRYPTION_KEY?) — введите заново';
    }
  }
  const embed = new EmbedBuilder()
    .setColor(COLORS.info)
    .setTitle('🔑 AI-токен')
    .setDescription(
      [
        note ?? '',
        `**Провайдер:** ${provider?.label ?? 'не выбран'}`,
        `**Модель:** ${g.ai_model || (provider ? `${provider.defaultModel} (по умолчанию)` : '—')}`,
        provider ? `**Промпт:** ${promptStyleLabel(provider, g.ai_model)}` : '',
        `**Токен:** ${masked}`,
        '',
        'Токен вводится только через защищённое окно (Modal), хранится зашифрованным (AES-256-GCM) и никогда не показывается целиком.',
      ]
        .filter((l, i) => !!l || i > 3)
        .join('\n'),
    );
  const select = new StringSelectMenuBuilder()
    .setCustomId(`cfg:prov:${guild.id}`)
    .setPlaceholder('Выберите AI-провайдера…')
    .addOptions(
      Object.values(PROVIDERS).map((p) => ({
        label: p.label,
        value: p.id,
        description: `Модель по умолчанию: ${p.defaultModel}`,
        default: p.id === g.ai_provider,
      })),
    );
  const rows: Row[] = [row(select)];
  if (provider) rows.push(row(modelSelect(`cfg:modelsel:${guild.id}`, provider, g.ai_model, await liveModels(provider, g.ai_token))));
  return {
    embeds: [embed],
    components: [
      ...rows,
      row(
        button(`cfg:tok:${guild.id}`, 'Ввести токен', ButtonStyle.Primary, '🔑'),
        button(`cfg:tokchk:${guild.id}`, 'Проверить токен', ButtonStyle.Success, '✅'),
        button(`cfg:tokdel:${guild.id}`, 'Удалить токен', ButtonStyle.Danger, '🗑'),
        back(guild.id),
      ),
    ],
  };
}

function viewSources(guild: Guild, note?: string): BaseMessageOptions {
  const g = ensureGuildRow(guild.id, config.defaultRefreshHours);
  const sources = listSources(guild.id);
  const list = sources
    .slice(0, 20)
    .map((s) => {
      const kind = s.kind === 'forum' ? '📁' : '📄';
      const status = s.last_error ? `⚠️ ${truncate(s.last_error, 60)}` : s.last_fetched_at ? `✅ <t:${Math.floor(s.last_fetched_at / 1000)}:R>` : '⏳ ещё не загружен';
      return `\`#${s.id}\` ${kind} [${truncate(s.title ?? s.url, 50)}](${s.url}) — ${status}`;
    })
    .join('\n');
  const embed = new EmbedBuilder()
    .setColor(COLORS.info)
    .setTitle('📚 Источники базы знаний')
    .setDescription(
      [
        note ?? '',
        list || '_Источников нет._',
        sources.length > 20 ? `…и ещё ${sources.length - 20}` : '',
        '',
        `🔁 Автообновление: каждые **${g.refresh_hours} ч**`,
        `🕒 Последнее обновление: ${formatDateTime(g.last_refresh_at)}`,
        isRefreshing(guild.id) ? '⏳ **Идёт обновление…**' : '',
        '',
        '📁 — раздел форума (берутся темы раздела и подразделов), 📄 — отдельная тема.',
      ]
        .filter((l, i) => (i === 0 ? !!l : true))
        .join('\n')
        .replace(/\n{3,}/g, '\n\n'),
    );
  const rows: Row[] = [
    row(
      button(`cfg:srcadd:${guild.id}`, 'Добавить', ButtonStyle.Success, '➕'),
      button(`cfg:srcint:${guild.id}`, 'Интервал', ButtonStyle.Secondary, '⏱'),
      button(`cfg:srcref:${guild.id}`, 'Обновить базу знаний', ButtonStyle.Primary, '🔄'),
      back(guild.id),
    ),
  ];
  if (sources.length) {
    rows.unshift(
      row(
        new StringSelectMenuBuilder()
          .setCustomId(`cfg:srcdel:${guild.id}`)
          .setPlaceholder('🗑 Удалить источник…')
          .addOptions(
            sources.slice(0, 25).map((s) => ({
              label: truncate(`#${s.id} ${s.title ?? s.url}`, 100),
              description: truncate(s.url, 100),
              value: String(s.id),
            })),
          ),
      ),
    );
  }
  return { embeds: [embed], components: rows };
}

/** Сначала выбирается назначение, затем канал для него (назначений больше, чем строк в сообщении Discord). */
function viewChannels(guild: Guild, inGuild: boolean, note?: string, purpose?: Purpose): BaseMessageOptions {
  const lines = PURPOSES.map((p) => {
    const id = channelIdFor(guild.id, p);
    return `${p === purpose ? '▶️ ' : ''}**${PURPOSE_LABELS[p]}:** ${id ? `<#${id}>` : '❌ не назначен'}`;
  });
  const embed = new EmbedBuilder()
    .setColor(COLORS.info)
    .setTitle('📺 Каналы')
    .setDescription(
      `${note ? `${note}\n\n` : ''}${lines.join('\n')}\n\n${purpose ? `Выберите канал для: **#${CHANNEL_NAMES[purpose]}**` : 'Выберите назначение, чтобы сменить канал, или восстановите недостающие.'}`,
    );

  const rows: Row[] = [
    row(
      new StringSelectMenuBuilder()
        .setCustomId(`cfg:chanp:${guild.id}`)
        .setPlaceholder('Какой канал изменить?')
        .addOptions(PURPOSES.map((p) => ({ label: truncate(PURPOSE_LABELS[p], 100), value: p, default: p === purpose }))),
    ),
  ];
  if (purpose) {
    const current = channelIdFor(guild.id, purpose);
    if (inGuild) {
      const sel = new ChannelSelectMenuBuilder()
        .setCustomId(`cfg:chan:${guild.id}:${purpose}`)
        .setPlaceholder(`Канал для: #${CHANNEL_NAMES[purpose]}`)
        .setChannelTypes(ChannelType.GuildText);
      if (current) sel.setDefaultChannels(current);
      rows.push(row(sel));
    } else {
      const textChannels = [...guild.channels.cache.values()]
        .filter((c) => c.type === ChannelType.GuildText)
        .sort((a, b) => ('position' in a && 'position' in b ? a.position - b.position : 0))
        .slice(0, 25);
      rows.push(
        row(
          new StringSelectMenuBuilder()
            .setCustomId(`cfg:chan:${guild.id}:${purpose}`)
            .setPlaceholder(`Канал для: #${CHANNEL_NAMES[purpose]}`)
            .addOptions(
              textChannels.length
                ? textChannels.map((c) => ({ label: truncate(`#${c.name}`, 100), value: c.id, default: c.id === current }))
                : [{ label: 'Нет текстовых каналов', value: 'none' }],
            ),
        ),
      );
    }
  }
  rows.push(row(button(`cfg:chanfix:${guild.id}`, 'Восстановить недостающие', ButtonStyle.Primary, '🛠'), back(guild.id)));
  return { embeds: [embed], components: rows };
}

function viewFaq(guild: Guild, note?: string): BaseMessageOptions {
  const faqs = listFaq(guild.id);
  const embed = new EmbedBuilder()
    .setColor(COLORS.info)
    .setTitle('📌 FAQ — быстрые ответы')
    .setDescription(
      `${note ? `${note}\n\n` : ''}${
        faqs.length
          ? faqs.slice(0, 25).map((f) => `\`#${f.id}\` ${truncate(f.question, 80)}${f.keywords ? ` _(ключи: ${truncate(f.keywords, 40)})_` : ''}`).join('\n')
          : '_Пока пусто._'
      }\n\nFAQ-ответы имеют приоритет над AI: если вопрос совпадает с FAQ, бот сразу отвечает из FAQ.`,
    );
  const rows: Row[] = [row(button(`cfg:faqadd:${guild.id}`, 'Добавить', ButtonStyle.Success, '➕'), back(guild.id))];
  if (faqs.length) {
    rows.unshift(
      row(
        new StringSelectMenuBuilder()
          .setCustomId(`cfg:faqdel:${guild.id}`)
          .setPlaceholder('🗑 Удалить ответ…')
          .addOptions(faqs.slice(0, 25).map((f) => ({ label: truncate(`#${f.id} ${f.question}`, 100), value: String(f.id) }))),
      ),
    );
  }
  return { embeds: [embed], components: rows };
}

function viewStatus(guild: Guild): BaseMessageOptions {
  const g = ensureGuildRow(guild.id, config.defaultRefreshHours);
  const kb = kbStats(guild.id);
  const ai = aiRequestStats(guild.id);
  const next = g.last_refresh_at ? g.last_refresh_at + g.refresh_hours * 3600_000 : null;
  const provider = isProviderId(g.ai_provider) ? PROVIDERS[g.ai_provider] : null;
  const embed = new EmbedBuilder()
    .setColor(COLORS.info)
    .setTitle('📊 Статус NOVA RP AI')
    .addFields(
      { name: '📚 Источников', value: String(kb.sources), inline: true },
      { name: '📄 Тем проиндексировано', value: String(kb.documents), inline: true },
      { name: '🧩 Фрагментов', value: String(kb.chunks), inline: true },
      { name: '📏 Пунктов правил', value: String(kb.rules), inline: true },
      { name: '🔁 Интервал', value: `${g.refresh_hours} ч`, inline: true },
      { name: '⏳ Сейчас', value: isRefreshing(guild.id) ? 'идёт обновление' : 'ожидание', inline: true },
      { name: '🕒 Последнее обновление', value: formatDateTime(g.last_refresh_at) },
      { name: '⏭ Следующее обновление', value: next ? formatDateTime(next) : 'после первого обновления' },
      {
        name: '🤖 AI',
        value: `${provider?.label ?? 'провайдер не выбран'} · ${g.ai_model || provider?.defaultModel || '—'} · токен ${g.ai_token ? 'задан' : 'не задан'}`,
      },
      { name: '💬 Запросов к AI', value: `всего: **${ai.total}** · за 24 ч: **${ai.day}** · ошибок: **${ai.failed}**` },
    );
  return {
    embeds: [embed],
    components: [row(button(`cfg:open:${guild.id}:status`, 'Обновить', ButtonStyle.Secondary, '🔄'), back(guild.id))],
  };
}

const TEMPERATURES: { value: string; label: string; temp: number | null; description: string }[] = [
  { value: 'auto', label: 'Авто (под модель)', temp: null, description: 'Рекомендуется: бот сам подбирает под провайдера' },
  { value: '0.1', label: 'Строго по правилам', temp: 0.1, description: 'Минимум свободы, максимально точно' },
  { value: '0.3', label: 'Сбалансировано', temp: 0.3, description: 'Чуть живее формулировки' },
  { value: '0.6', label: 'Свободнее', temp: 0.6, description: 'Разнообразнее текст, выше риск неточностей' },
];

function viewAiSettings(guild: Guild, note?: string): BaseMessageOptions {
  const g = ensureGuildRow(guild.id, config.defaultRefreshHours);
  const temp = TEMPERATURES.find((t) => t.temp === g.ai_temperature) ?? TEMPERATURES[0];
  const embed = new EmbedBuilder()
    .setColor(COLORS.info)
    .setTitle('🧠 Настройки AI')
    .setDescription(
      [
        note ? `${note}\n` : '',
        `📏 **Длина ответа по умолчанию:** ${g.ai_answer_length === 'long' ? 'подробно' : 'кратко'} _(игрок может изменить для себя в /setupls)_`,
        `🎯 **Точность:** ${temp.label}`,
        `📚 **Объём контекста:** ${g.ai_context_size} фрагментов форума на ответ`,
        `🔍 **Умный поиск:** ${g.ai_rewrite ? 'вкл — AI исправляет опечатки и сленг перед поиском (+1 короткий запрос к AI)' : 'выкл'}`,
        `🔗 **Источники в ответах:** ${g.ai_show_sources ? 'показывать' : 'скрывать'}`,
        `📝 **Свои инструкции:** ${g.ai_instructions ? `\n> ${truncate(g.ai_instructions, 600).replace(/\n/g, '\n> ')}` : 'нет'}`,
        '',
        '_Свои инструкции дополняют основные правила бота (только русский, только NOVA RP, только данные форума) и не могут их отменить._',
      ]
        .filter((l, i) => i !== 0 || l)
        .join('\n'),
    );
  const lengthSel = new StringSelectMenuBuilder()
    .setCustomId(`cfg:ailen:${guild.id}`)
    .addOptions(
      { label: 'Кратко (2–5 предложений)', value: 'short', emoji: '✂️', default: g.ai_answer_length !== 'long' },
      { label: 'Подробно (до 15 предложений)', value: 'long', emoji: '📖', default: g.ai_answer_length === 'long' },
    );
  const tempSel = new StringSelectMenuBuilder()
    .setCustomId(`cfg:aitemp:${guild.id}`)
    .addOptions(TEMPERATURES.map((t) => ({ label: t.label, value: t.value, description: t.description, default: t === temp })));
  const ctxSel = new StringSelectMenuBuilder()
    .setCustomId(`cfg:aictx:${guild.id}`)
    .addOptions(
      [4, 6, 8, 12].map((n) => ({
        label: `${n} фрагментов контекста`,
        value: String(n),
        description: n <= 4 ? 'Дешевле и быстрее' : n >= 10 ? 'Полнее ответы, больше токенов' : 'Баланс',
        default: g.ai_context_size === n,
      })),
    );
  return {
    embeds: [embed],
    components: [
      row(lengthSel),
      row(tempSel),
      row(ctxSel),
      row(
        button(`cfg:airew:${guild.id}`, g.ai_rewrite ? 'Умный поиск: вкл' : 'Умный поиск: выкл', g.ai_rewrite ? ButtonStyle.Success : ButtonStyle.Secondary, '🔍'),
        button(`cfg:aisrc:${guild.id}`, g.ai_show_sources ? 'Источники: вкл' : 'Источники: выкл', g.ai_show_sources ? ButtonStyle.Success : ButtonStyle.Secondary, '🔗'),
        button(`cfg:aiinst:${guild.id}`, 'Свои инструкции', ButtonStyle.Primary, '📝'),
        button(`cfg:aipage2:${guild.id}`, 'Ещё настройки', ButtonStyle.Primary, '➡️'),
        back(guild.id),
      ),
    ],
  };
}

const TONES: { value: 'neutral' | 'official' | 'friendly' | 'strict'; label: string; description: string; emoji: string }[] = [
  { value: 'neutral', label: 'Нейтральный', description: 'По умолчанию', emoji: '😐' },
  { value: 'official', label: 'Официальный', description: 'На «вы», как администрация проекта', emoji: '🎩' },
  { value: 'friendly', label: 'Дружелюбный', description: 'Проще, можно на «ты», немного эмодзи', emoji: '😊' },
  { value: 'strict', label: 'Строгий', description: 'Только ответ, пункт и наказание', emoji: '📏' },
];

const MAX_TOKENS: { value: string; label: string; tokens: number | null }[] = [
  { value: 'auto', label: 'Авто (по длине ответа)', tokens: null },
  { value: '300', label: '300 токенов — очень коротко', tokens: 300 },
  { value: '600', label: '600 токенов', tokens: 600 },
  { value: '1000', label: '1000 токенов', tokens: 1000 },
  { value: '1500', label: '1500 токенов — максимум подробностей', tokens: 1500 },
];

/** Вторая страница «Настройки AI»: тон, лимит токенов, резервная модель, поведение в Discord. */
async function viewAiSettings2(guild: Guild, note?: string): Promise<BaseMessageOptions> {
  const g = ensureGuildRow(guild.id, config.defaultRefreshHours);
  const provider = isProviderId(g.ai_provider) ? PROVIDERS[g.ai_provider] : null;
  const tone = TONES.find((t) => t.value === g.ai_tone) ?? TONES[0];
  const maxTok = MAX_TOKENS.find((m) => m.tokens === g.ai_max_tokens) ?? MAX_TOKENS[0];
  const onOff = (v: number) => (v ? 'вкл' : 'выкл');
  const embed = new EmbedBuilder()
    .setColor(COLORS.info)
    .setTitle('🧠 Настройки AI — ещё')
    .setDescription(
      [
        note ? `${note}\n` : '',
        `🎭 **Тон ответов:** ${tone.label}`,
        `🔢 **Лимит длины ответа:** ${maxTok.label}`,
        `🛟 **Резервная модель:** ${g.ai_fallback_model ?? 'нет'} _(используется, если основная модель недоступна или упёрлась в лимит)_`,
        '',
        `📂 **Искать и в жалобах:** ${onOff(g.ai_search_complaints)} _(выкл — только правила, меньше «шума»)_`,
        `💬 **Автоответ в #ai-помощник:** ${onOff(g.ai_auto_reply)} _(выкл — только /вопрос и упоминание бота)_`,
        `🧵 **Ответ в отдельной ветке:** ${onOff(g.ai_threads)} _(канал остаётся чистым)_`,
        `🤖 **Подпись с моделью:** ${onOff(g.ai_show_model)}`,
        `📌 **FAQ раньше AI:** ${onOff(g.ai_faq_first)}`,
      ]
        .filter((l, i) => i !== 0 || l)
        .join('\n'),
    );
  const toneSel = new StringSelectMenuBuilder()
    .setCustomId(`cfg:aitone:${guild.id}`)
    .addOptions(TONES.map((t) => ({ label: t.label, value: t.value, description: t.description, emoji: t.emoji, default: t === tone })));
  const maxSel = new StringSelectMenuBuilder()
    .setCustomId(`cfg:aimax:${guild.id}`)
    .addOptions(MAX_TOKENS.map((m) => ({ label: m.label, value: m.value, default: m === maxTok })));
  const live = provider ? await liveModels(provider, g.ai_token) : null;
  const models = [...new Set([...(g.ai_fallback_model ? [g.ai_fallback_model] : []), ...(live ?? provider?.models ?? [])])].slice(0, 23);
  const fbSel = new StringSelectMenuBuilder()
    .setCustomId(`cfg:aifb:${guild.id}`)
    .setPlaceholder('Резервная модель…')
    .addOptions(
      { label: 'Без резервной модели', value: '__none', emoji: '🚫', default: !g.ai_fallback_model },
      ...(models.length
        ? models.map((m) => ({ label: truncate(m, 100), value: m, default: m === g.ai_fallback_model }))
        : [{ label: 'Сначала выберите провайдера', value: '__none2' }]),
    );
  const toggle = (op: string, label: string, v: number, emoji: string) =>
    button(`cfg:${op}:${guild.id}`, label, v ? ButtonStyle.Success : ButtonStyle.Secondary, emoji);
  return {
    embeds: [embed],
    components: [
      row(toneSel),
      row(maxSel),
      row(fbSel),
      row(
        toggle('aicmp', 'Жалобы в поиске', g.ai_search_complaints, '📂'),
        toggle('aiauto', 'Автоответ', g.ai_auto_reply, '💬'),
        toggle('aithr', 'Ветки', g.ai_threads, '🧵'),
        toggle('aimdl', 'Подпись модели', g.ai_show_model, '🤖'),
        toggle('aifaq', 'FAQ первым', g.ai_faq_first, '📌'),
      ),
      row(button(`cfg:open:${guild.id}:aiset`, 'Основные настройки AI', ButtonStyle.Secondary, '⬅️'), back(guild.id)),
    ],
  };
}

async function viewWizard(client: Client, guild: Guild, note?: string): Promise<BaseMessageOptions> {
  const plan = await analyzeGuild(client, guild);
  const embed = new EmbedBuilder()
    .setColor(plan.actions.length || plan.manual.length > 1 ? COLORS.warn : COLORS.ok)
    .setTitle('🪄 Мастер настройки')
    .setDescription(
      truncate(
        [
          note ? `${note}\n` : '',
          '**Проверка сервера:**',
          ...plan.checks.map((c) => `${c.ok ? '✅' : '⚠️'} ${c.text}`),
          '',
          plan.actions.length
            ? `**Рекомендации (${plan.actions.length}) — применятся кнопкой ниже:**\n${plan.actions.map((a) => `• ${a.text}`).join('\n')}`
            : '**Рекомендаций нет — всё настроено оптимально.**',
          plan.needsRefresh ? '• После применения будет запущено обновление базы знаний' : '',
          '',
          '**Вручную:**',
          ...plan.manual.map((m) => `• ${m}`),
        ]
          .filter((l, i) => i !== 0 || l)
          .join('\n'),
        4000,
      ),
    );
  const apply = button(`cfg:wizapply:${guild.id}`, `Применить рекомендации (${plan.actions.length})`, ButtonStyle.Success, '✅');
  if (!plan.actions.length && !plan.needsRefresh) apply.setDisabled(true);
  return {
    embeds: [embed],
    components: [
      row(
        apply,
        button(`cfg:open:${guild.id}:ai`, 'AI-токен', ButtonStyle.Primary, '🔑'),
        button(`cfg:open:${guild.id}:wizard`, 'Проверить снова', ButtonStyle.Secondary, '🔄'),
        back(guild.id),
      ),
    ],
  };
}

async function viewFor(client: Client, section: Section | 'home', guild: Guild, inGuild: boolean, perms: ActorPerms): Promise<BaseMessageOptions> {
  switch (section) {
    case 'home':
      return buildMainMenu(guild.id, inGuild ? undefined : guild.name, perms);
    case 'wizard':
      return await viewWizard(client, guild);
    case 'roles':
      return viewRoles(guild);
    case 'ai':
      return await viewAi(guild);
    case 'aiset':
      return viewAiSettings(guild);
    case 'sources':
      return viewSources(guild);
    case 'channels':
      return viewChannels(guild, inGuild);
    case 'faq':
      return viewFaq(guild);
    case 'status':
      return viewStatus(guild);
  }
}

// ---------- Обновление базы знаний ----------

export function describeReport(r: RefreshReport): string {
  const lines = [
    `Источников: **${r.sources}**, тем скачано: **${r.threadsFetched}**, из кэша: **${r.threadsCached}**, документов: **${r.documents}**`,
    `Изменений в правилах: **${r.ruleChanges}**`,
    `Время: ${Math.round(r.durationMs / 1000)} с`,
  ];
  if (r.errors.length) lines.push(`Ошибок: **${r.errors.length}**\n${r.errors.slice(0, 5).map((e) => `• ${truncate(e, 150)}`).join('\n')}`);
  return lines.join('\n');
}

export function startRefresh(client: Client, guildId: string, initiator: string | null, notify?: (text: string) => Promise<unknown>): void {
  refreshScope(guildId)
    .then(async (report) => {
      const text = describeReport(report);
      await logToGuild(
        client,
        guildId,
        new EmbedBuilder()
          .setColor(report.errors.length ? COLORS.warn : COLORS.ok)
          .setTitle('🔄 База знаний обновлена')
          .setDescription(`${initiator ? `Запустил: <@${initiator}>\n` : 'Автообновление\n'}${text}`),
      );
      await notify?.(`✅ База знаний обновлена.\n${text}`).catch(() => undefined);
      await dispatchRuleUpdates(client).catch((err) => log.warn('Ошибка рассылки обновлений правил', err));
    })
    .catch(async (err) => {
      await logToGuild(
        client,
        guildId,
        new EmbedBuilder().setColor(COLORS.error).setTitle('❌ Ошибка обновления базы знаний').setDescription(String(err)),
      );
      await notify?.('❌ Не удалось обновить базу знаний. Подробности — в #ai-логи.').catch(() => undefined);
    });
}

// ---------- Обработчик ----------

export async function handleSettingsInteraction(i: CfgInteraction): Promise<void> {
  const [, op, guildId, arg] = i.customId.split(':');
  const client = i.client;
  const inGuild = i.inGuild();

  if (op === 'main' || op === 'open') {
    const section = (op === 'main' && i.isStringSelectMenu() ? i.values[0] : arg) as Section | 'home';
    const { guild, perms } = await requireSection(client, guildId, i.user.id, section === 'home' ? 'status' : section).catch((err) => {
      // «Домой» доступно любому, кто вообще может что-то настраивать
      if (section === 'home') return requireAny(client, guildId, i.user.id);
      throw err;
    });
    const persistent = i.isMessageComponent() && i.message.id === getGuild(guildId)?.settings_message_id;
    // Мастер и AI-токен обращаются к провайдеру — заранее подтверждаем взаимодействие (лимит Discord 3 с).
    const slow = section === 'wizard' || section === 'ai';
    if (slow && i.isMessageComponent()) {
      if (persistent) await i.deferReply({ flags: MessageFlags.Ephemeral });
      else await i.deferUpdate();
    }
    const payload = await viewFor(client, section, guild, inGuild, perms);
    if (persistent && i.isMessageComponent()) {
      if (i.deferred) await i.editReply(payload);
      else await i.reply({ ...payload, flags: MessageFlags.Ephemeral });
      // Сбрасываем выбор в постоянном меню, чтобы раздел можно было открыть повторно.
      await i.message.edit(buildMainMenu(guildId)).catch(() => undefined);
    } else {
      await updateOrReply(i, payload);
    }
    return;
  }

  const section = OP_SECTION[op];
  if (!section) throw new Error(`Неизвестное действие меню: ${i.customId}`);
  const { guild } = await requireSection(client, guildId, i.user.id, section);
  const uid = i.user.id;

  switch (op) {
    // ----- роли -----
    case 'rolesel': {
      if (!i.isStringSelectMenu()) return;
      await updateOrReply(i, viewRole(guild, i.values[0]));
      return;
    }
    case 'rolenew': {
      if (!i.isButton()) return;
      await i.showModal(
        modal(`cfg:rolenewm:${guildId}`, 'Новая роль', [textInput('name', 'Название роли', { min: 1, max: 100, placeholder: 'Например: AI Модератор' })]),
      );
      return;
    }
    case 'rolenewm': {
      if (!i.isModalSubmit()) return;
      const name = i.fields.getTextInputValue('name').trim();
      if (!name) throw new UserError('Название роли не может быть пустым.');
      if (guild.roles.cache.some((r) => r.name.toLowerCase() === name.toLowerCase())) {
        throw new UserError(`Роль «${name}» уже существует — выберите её в списке.`);
      }
      const role = await guild.roles.create({ name, reason: `NOVA RP AI: создано ${i.user.tag}` }).catch(() => {
        throw new UserError('Не удалось создать роль. Проверьте, что у бота есть право «Управлять ролями».');
      });
      upsertRolePerm(defaultPerm(guildId, role.id));
      await audit(client, guildId, uid, 'Создана роль', `<@&${role.id}> (${role.name})`);
      await updateOrReply(i, viewRole(guild, role.id, `✅ Роль <@&${role.id}> создана. Настройте права ниже.`));
      return;
    }
    case 'roleperm':
    case 'roleaccess':
    case 'rolecmd': {
      if (!i.isStringSelectMenu()) return;
      await i.deferUpdate(); // права каналов меняются несколькими запросами к Discord
      const roleId = arg;
      const label = roleId === guildId ? '@everyone' : `<@&${roleId}>`;
      const next: RolePerm = { ...(getRolePerm(guildId, roleId) ?? defaultPerm(guildId, roleId)) };
      let details: string;
      if (op === 'roleperm') {
        for (const f of PERM_FLAGS) next[f] = i.values.includes(f) ? 1 : 0;
        details = PERM_FLAGS.filter((f) => next[f]).map((f) => PERM_LABELS[f].label).join(', ') || 'нет прав';
      } else if (op === 'roleaccess') {
        for (const f of ACCESS_FLAGS) {
          if (roleId === guildId && f === 'see_settings') continue;
          next[f] = i.values.includes(f) ? 1 : 0;
        }
        details = ACCESS_FLAGS.filter((f) => next[f]).map((f) => ACCESS_LABELS[f].label).join(', ') || 'нет доступа';
      } else {
        next.blocked_commands = BOT_COMMANDS.filter((c) => !i.values.includes(c)).join(',');
        details = next.blocked_commands ? `запрещены: ${next.blocked_commands.split(',').map((c) => `/${c}`).join(', ')}` : 'все команды разрешены';
      }
      upsertRolePerm(next);
      clearDmTokenCache();
      const problems = op === 'rolecmd' ? [] : await syncAllRoleAccess(guild);
      await audit(client, guildId, uid, 'Изменены права роли', `${label}: ${details}`);
      const warn = problems.length ? `\n⚠️ Не удалось изменить права каналов для: ${problems.join(', ')} (роль бота должна быть выше).` : '';
      await updateOrReply(i, viewRole(guild, roleId, `✅ Сохранено.${warn}`));
      return;
    }
    case 'rolelim': {
      if (!i.isButton()) return;
      const p = getRolePerm(guildId, arg) ?? defaultPerm(guildId, arg);
      await i.showModal(
        modal(`cfg:rolelimm:${guildId}:${arg}`, 'Лимит вопросов в час', [
          textInput('limit', 'Вопросов в час (0 — без лимита)', { value: String(p.hourly_limit), min: 1, max: 4 }),
        ]),
      );
      return;
    }
    case 'rolelimm': {
      if (!i.isModalSubmit()) return;
      const n = Number(i.fields.getTextInputValue('limit').trim());
      if (!Number.isInteger(n) || n < 0 || n > 1000) throw new UserError('Введите целое число от 0 до 1000.');
      const p = getRolePerm(guildId, arg) ?? defaultPerm(guildId, arg);
      upsertRolePerm({ ...p, hourly_limit: n });
      await audit(client, guildId, uid, 'Изменён лимит роли', `${arg === guildId ? '@everyone' : `<@&${arg}>`}: ${n === 0 ? 'без лимита' : `${n}/ч`}`);
      await updateOrReply(i, viewRole(guild, arg, '✅ Лимит сохранён.'));
      return;
    }
    case 'roledel': {
      if (i.isButton()) await i.deferUpdate();
      deleteRolePerm(guildId, arg);
      clearDmTokenCache();
      await syncAllRoleAccess(guild, [arg]);
      await audit(client, guildId, uid, 'Сброшены права роли', arg === guildId ? '@everyone' : `<@&${arg}>`);
      await updateOrReply(i, viewRoles(guild, '🗑 Права роли сброшены.'));
      return;
    }

    // ----- AI -----
    case 'prov': {
      if (!i.isStringSelectMenu()) return;
      const provider = i.values[0];
      if (!isProviderId(provider)) return;
      const g = getGuild(guildId);
      if (g?.ai_provider === provider) {
        await updateOrReply(i, await viewAi(guild));
        return;
      }
      // Токен одного провайдера не подходит другому — сбрасываем.
      updateGuild(guildId, { ai_provider: provider, ai_model: null, ai_token: null });
      clearDmTokenCache();
      await audit(client, guildId, uid, 'Выбран AI-провайдер', PROVIDERS[provider].label);
      await updateOrReply(i, await viewAi(guild, `✅ Провайдер: **${PROVIDERS[provider].label}**. Теперь введите токен.`));
      return;
    }
    case 'tok': {
      if (!i.isButton()) return;
      const g = getGuild(guildId);
      if (!isProviderId(g?.ai_provider)) throw new UserError('Сначала выберите AI-провайдера в списке.');
      const p = PROVIDERS[g!.ai_provider as ProviderId];
      await i.showModal(
        modal(`cfg:tokm:${guildId}`, `Токен ${p.label}`, [
          textInput('token', 'API-токен', { min: 10, max: 400, placeholder: p.tokenHint }),
          textInput('model', 'Модель (необязательно)', { required: false, max: 100, value: g!.ai_model, placeholder: p.defaultModel }),
        ]),
      );
      return;
    }
    case 'tokm': {
      if (!i.isModalSubmit()) return;
      const g = getGuild(guildId);
      if (!isProviderId(g?.ai_provider)) throw new UserError('Сначала выберите AI-провайдера.');
      const token = i.fields.getTextInputValue('token').trim();
      const model = i.fields.getTextInputValue('model').trim() || null;
      if (/\s/.test(token)) throw new UserError('Токен не должен содержать пробелов.');
      updateGuild(guildId, { ai_token: secrets.encrypt(token), ai_model: model });
      clearDmTokenCache();
      await audit(client, guildId, uid, 'Обновлён AI-токен', `${PROVIDERS[g!.ai_provider as ProviderId].label}, токен ${maskSecret(token)}${model ? `, модель ${model}` : ''}`);
      await updateOrReply(i, await viewAi(guild, `✅ Токен сохранён: \`${maskSecret(token)}\`. Нажмите «Проверить токен».`));
      return;
    }
    case 'modelsel': {
      if (!i.isStringSelectMenu()) return;
      const g = getGuild(guildId);
      const p = isProviderId(g?.ai_provider) ? PROVIDERS[g!.ai_provider as ProviderId] : null;
      const value = i.values[0];
      if (value !== CUSTOM_MODEL) {
        updateGuild(guildId, { ai_model: value });
        await audit(client, guildId, uid, 'Изменена модель AI', value);
        await updateOrReply(i, await viewAi(guild, `✅ Модель: **${value}**`));
        return;
      }
      await i.showModal(
        modal(`cfg:modelm:${guildId}`, 'Модель AI', [
          textInput('model', 'Название модели (пусто — по умолчанию)', { required: false, max: 100, value: g?.ai_model, placeholder: p?.defaultModel ?? 'gpt-4.1-mini' }),
        ]),
      );
      return;
    }
    case 'modelm': {
      if (!i.isModalSubmit()) return;
      const model = i.fields.getTextInputValue('model').trim() || null;
      updateGuild(guildId, { ai_model: model });
      await audit(client, guildId, uid, 'Изменена модель AI', model ?? 'по умолчанию');
      await updateOrReply(i, await viewAi(guild, '✅ Модель сохранена.'));
      return;
    }
    case 'tokchk': {
      if (!i.isButton()) return;
      const g = getGuild(guildId);
      if (!g?.ai_token || !isProviderId(g.ai_provider)) throw new UserError('Токен ещё не задан.');
      await i.deferUpdate();
      let token: string;
      try {
        token = secrets.decrypt(g.ai_token);
      } catch {
        throw new UserError('Сохранённый токен не расшифровывается (сменился ENCRYPTION_KEY?). Введите токен заново.');
      }
      const res = await verifyToken(g.ai_provider, token);
      await i.editReply(await viewAi(guild, `${res.ok ? '✅' : '❌'} Проверка: ${res.message}`));
      return;
    }
    case 'tokdel': {
      updateGuild(guildId, { ai_token: null });
      clearDmTokenCache();
      await audit(client, guildId, uid, 'Удалён AI-токен');
      await updateOrReply(i, await viewAi(guild, '🗑 Токен удалён.'));
      return;
    }

    // ----- источники -----
    case 'srcadd': {
      if (!i.isButton()) return;
      await i.showModal(
        modal(`cfg:srcaddm:${guildId}`, 'Добавить источник', [
          textInput('url', 'Ссылка на тему или раздел форума', { placeholder: `${config.forumBaseUrl}/forums/1010/`, max: 300 }),
        ]),
      );
      return;
    }
    case 'srcaddm': {
      if (!i.isModalSubmit()) return;
      const raw = i.fields.getTextInputValue('url');
      const norm = normalizeForumUrl(raw, config.forumBaseUrl);
      if (!norm) throw new UserError(`Нужна ссылка на тему (/threads/…) или раздел (/forums/…) форума ${config.forumBaseUrl}`);
      if (listSources(guildId).length >= 50) throw new UserError('Достигнут предел: 50 источников на сервер.');
      const added = addSource(guildId, norm.url, norm.kind, uid);
      if (!added) throw new UserError('Этот источник уже добавлен.');
      await audit(client, guildId, uid, 'Добавлен источник', norm.url);
      startRefresh(client, guildId, uid);
      await updateOrReply(i, viewSources(guild, `✅ Добавлено: ${norm.url}\n⏳ Индексация запущена в фоне — результат появится в #ai-логи.`));
      return;
    }
    case 'srcdel': {
      if (!i.isStringSelectMenu()) return;
      const src = getSource(Number(i.values[0]));
      if (!src || src.scope !== guildId) throw new UserError('Источник не найден.');
      deleteSource(src.id);
      invalidateSearchIndex();
      await audit(client, guildId, uid, 'Удалён источник', src.url);
      await updateOrReply(i, viewSources(guild, `🗑 Удалено: ${src.url}`));
      return;
    }
    case 'srcint': {
      if (!i.isButton()) return;
      const g = ensureGuildRow(guildId, config.defaultRefreshHours);
      await i.showModal(
        modal(`cfg:srcintm:${guildId}`, 'Интервал автообновления', [
          textInput('hours', 'Каждые N часов (1–168)', { value: String(g.refresh_hours), min: 1, max: 3 }),
        ]),
      );
      return;
    }
    case 'srcintm': {
      if (!i.isModalSubmit()) return;
      const n = Number(i.fields.getTextInputValue('hours').trim());
      if (!Number.isInteger(n) || n < 1 || n > 168) throw new UserError('Введите целое число часов от 1 до 168.');
      updateGuild(guildId, { refresh_hours: n });
      await audit(client, guildId, uid, 'Изменён интервал обновления', `${n} ч`);
      await updateOrReply(i, viewSources(guild, `✅ Автообновление каждые ${n} ч.`));
      return;
    }
    case 'srcref': {
      if (isRefreshing(guildId)) {
        await updateOrReply(i, viewSources(guild, '⏳ Обновление уже идёт.'));
        return;
      }
      await audit(client, guildId, uid, 'Запущено обновление базы знаний');
      startRefresh(client, guildId, uid, (text) => i.followUp({ content: text, flags: ephemeralIfGuild(i) }));
      await updateOrReply(i, viewSources(guild, '🔄 Обновление запущено. Это может занять несколько минут (бот делает паузы между запросами к форуму).'));
      return;
    }

    // ----- каналы -----
    case 'chanp': {
      if (!i.isStringSelectMenu()) return;
      const purpose = i.values[0] as Purpose;
      if (!PURPOSES.includes(purpose)) return;
      await updateOrReply(i, viewChannels(guild, inGuild, undefined, purpose));
      return;
    }
    case 'chan': {
      const purpose = arg as Purpose;
      if (!PURPOSES.includes(purpose)) return;
      let channelId: string | undefined;
      if (i.isChannelSelectMenu()) channelId = i.values[0];
      else if (i.isStringSelectMenu()) channelId = i.values[0];
      if (!channelId || channelId === 'none') return;
      const ch = await guild.channels.fetch(channelId).catch(() => null);
      if (ch?.type !== ChannelType.GuildText) throw new UserError('Нужно выбрать текстовый канал.');
      setChannelFor(guildId, purpose, ch.id);
      let note = `✅ ${PURPOSE_LABELS[purpose]} → <#${ch.id}>`;
      if (purpose === 'settings') {
        await postSettingsMenu(guild, ch).catch(() => {
          note += '\n⚠️ Не удалось отправить меню в этот канал (нет прав).';
        });
      }
      await audit(client, guildId, uid, 'Изменён канал', `${PURPOSE_LABELS[purpose]} → <#${ch.id}>`);
      if (purpose !== 'assistant' && purpose !== 'settings') await syncAllRoleAccess(guild).catch(() => []);
      await updateOrReply(i, viewChannels(guild, inGuild, note, purpose));
      return;
    }
    case 'chanfix': {
      if (i.isButton()) await i.deferUpdate(); // создание каналов дольше 3 секунд
      const res = await applySetup(client, guild);
      if (res.created.length) await audit(client, guildId, uid, 'Восстановлены каналы', res.created.join(', '));
      await updateOrReply(i, viewChannels(guild, inGuild, res.created.length ? `🛠 Восстановлено: ${res.created.join(', ')}` : '✅ Всё на месте, восстанавливать нечего.'));
      return;
    }

    // ----- Настройки AI -----
    case 'ailen':
    case 'aitemp':
    case 'aictx': {
      if (!i.isStringSelectMenu()) return;
      const v = i.values[0];
      let details: string;
      if (op === 'ailen') {
        updateGuild(guildId, { ai_answer_length: v === 'long' ? 'long' : 'short' });
        details = `длина ответа: ${v === 'long' ? 'подробно' : 'кратко'}`;
      } else if (op === 'aitemp') {
        const t = TEMPERATURES.find((x) => x.value === v) ?? TEMPERATURES[0];
        updateGuild(guildId, { ai_temperature: t.temp });
        details = `точность: ${t.label}`;
      } else {
        const n = Math.min(Math.max(Number(v) || 6, 2), 12);
        updateGuild(guildId, { ai_context_size: n });
        details = `контекст: ${n} фрагментов`;
      }
      await audit(client, guildId, uid, 'Изменены настройки AI', details);
      await updateOrReply(i, viewAiSettings(guild, '✅ Сохранено.'));
      return;
    }
    case 'airew':
    case 'aisrc': {
      const g = ensureGuildRow(guildId, config.defaultRefreshHours);
      if (op === 'airew') updateGuild(guildId, { ai_rewrite: g.ai_rewrite ? 0 : 1 });
      else updateGuild(guildId, { ai_show_sources: g.ai_show_sources ? 0 : 1 });
      const label = op === 'airew' ? `умный поиск: ${g.ai_rewrite ? 'выкл' : 'вкл'}` : `источники: ${g.ai_show_sources ? 'скрывать' : 'показывать'}`;
      await audit(client, guildId, uid, 'Изменены настройки AI', label);
      await updateOrReply(i, viewAiSettings(guild, '✅ Сохранено.'));
      return;
    }
    case 'aiinst': {
      if (!i.isButton()) return;
      const g = ensureGuildRow(guildId, config.defaultRefreshHours);
      await i.showModal(
        modal(`cfg:aiinstm:${guildId}`, 'Свои инструкции для AI', [
          textInput('text', 'Инструкции (пусто — удалить)', {
            style: TextInputStyle.Paragraph,
            required: false,
            max: 1000,
            value: g.ai_instructions,
            placeholder: 'Например: обращайся на «вы»; в конце предлагай открыть тикет в #поддержка; сервер — NOVA RP New Era.',
          }),
        ]),
      );
      return;
    }
    case 'aipage2': {
      if (i.isButton()) await i.deferUpdate(); // список моделей запрашивается у провайдера
      await updateOrReply(i, await viewAiSettings2(guild));
      return;
    }
    case 'aitone':
    case 'aimax':
    case 'aifb': {
      if (!i.isStringSelectMenu()) return;
      const v = i.values[0];
      let details: string;
      if (op === 'aitone') {
        const t = TONES.find((x) => x.value === v) ?? TONES[0];
        updateGuild(guildId, { ai_tone: t.value });
        details = `тон: ${t.label}`;
      } else if (op === 'aimax') {
        const m = MAX_TOKENS.find((x) => x.value === v) ?? MAX_TOKENS[0];
        updateGuild(guildId, { ai_max_tokens: m.tokens });
        details = `лимит ответа: ${m.label}`;
      } else {
        const model = v.startsWith('__none') ? null : v;
        updateGuild(guildId, { ai_fallback_model: model });
        details = `резервная модель: ${model ?? 'нет'}`;
      }
      await i.deferUpdate();
      await audit(client, guildId, uid, 'Изменены настройки AI', details);
      await updateOrReply(i, await viewAiSettings2(guild, '✅ Сохранено.'));
      return;
    }
    case 'aicmp':
    case 'aiauto':
    case 'aithr':
    case 'aimdl':
    case 'aifaq': {
      const col = ({ aicmp: 'ai_search_complaints', aiauto: 'ai_auto_reply', aithr: 'ai_threads', aimdl: 'ai_show_model', aifaq: 'ai_faq_first' } as const)[op];
      const label = { aicmp: 'жалобы в поиске', aiauto: 'автоответ в #ai-помощник', aithr: 'ответ в ветке', aimdl: 'подпись модели', aifaq: 'FAQ первым' }[op];
      const g = ensureGuildRow(guildId, config.defaultRefreshHours);
      const next = g[col] ? 0 : 1;
      updateGuild(guildId, { [col]: next });
      if (i.isButton()) await i.deferUpdate();
      await audit(client, guildId, uid, 'Изменены настройки AI', `${label}: ${next ? 'вкл' : 'выкл'}`);
      await updateOrReply(i, await viewAiSettings2(guild, '✅ Сохранено.'));
      return;
    }
    case 'aiinstm': {
      if (!i.isModalSubmit()) return;
      const text = i.fields.getTextInputValue('text').trim() || null;
      updateGuild(guildId, { ai_instructions: text });
      await audit(client, guildId, uid, 'Изменены инструкции AI', text ? truncate(text, 500) : 'удалены');
      await updateOrReply(i, viewAiSettings(guild, text ? '✅ Инструкции сохранены.' : '🗑 Инструкции удалены.'));
      return;
    }

    // ----- Мастер настройки -----
    case 'wizapply': {
      if (!i.isButton()) return;
      await i.deferUpdate();
      const plan = await analyzeGuild(client, guild);
      const { done, failed } = await applyPlan(guild, plan);
      clearDmTokenCache();
      if (plan.needsRefresh) startRefresh(client, guildId, uid);
      if (done.length) await audit(client, guildId, uid, 'Мастер настройки: применены рекомендации', done.map((d) => `• ${d}`).join('\n'));
      const note = [
        done.length ? `✅ Применено: ${done.length}` : 'Нечего применять.',
        plan.needsRefresh ? '🔄 Запущено обновление базы знаний — результат появится в #ai-логи.' : '',
        failed.length ? `⚠️ Не удалось:\n${failed.map((f) => `• ${truncate(f, 200)}`).join('\n')}` : '',
      ]
        .filter(Boolean)
        .join('\n');
      await updateOrReply(i, await viewWizard(client, guild, note));
      return;
    }

    // ----- FAQ -----
    case 'faqadd': {
      if (!i.isButton()) return;
      await i.showModal(
        modal(`cfg:faqaddm:${guildId}`, 'Новый быстрый ответ', [
          textInput('q', 'Вопрос', { max: 200, placeholder: 'Как подать жалобу на игрока?' }),
          textInput('a', 'Ответ', { style: TextInputStyle.Paragraph, max: 1500 }),
          textInput('k', 'Ключевые фразы через запятую (необяз.)', { required: false, max: 300, placeholder: 'подать жалобу, жалоба на игрока' }),
        ]),
      );
      return;
    }
    case 'faqaddm': {
      if (!i.isModalSubmit()) return;
      if (listFaq(guildId).length >= 100) throw new UserError('Достигнут предел: 100 FAQ-ответов.');
      const q = i.fields.getTextInputValue('q').trim();
      const a = i.fields.getTextInputValue('a').trim();
      const k = i.fields.getTextInputValue('k').trim() || null;
      const id = addFaq(guildId, q, a, k, uid);
      await audit(client, guildId, uid, 'Добавлен FAQ', `#${id}: ${q}`);
      await updateOrReply(i, viewFaq(guild, `✅ Добавлено: #${id}`));
      return;
    }
    case 'faqdel': {
      if (!i.isStringSelectMenu()) return;
      const f = getFaq(Number(i.values[0]));
      if (!f || f.guild_id !== guildId) throw new UserError('Ответ не найден.');
      deleteFaq(f.id);
      await audit(client, guildId, uid, 'Удалён FAQ', `#${f.id}: ${f.question}`);
      await updateOrReply(i, viewFaq(guild, `🗑 Удалено: #${f.id}`));
      return;
    }
  }
}

async function requireAny(client: Client, guildId: string, userId: string) {
  for (const s of ['ai', 'sources', 'status'] as Section[]) {
    try {
      return await requireSection(client, guildId, userId, s);
    } catch {
      // пробуем следующий раздел
    }
  }
  throw new UserError('⛔ У вас нет прав на управление ботом на этом сервере.');
}
