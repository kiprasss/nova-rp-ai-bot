import {
  ButtonStyle,
  ChannelType,
  EmbedBuilder,
  MessageFlags,
  StringSelectMenuBuilder,
  TextInputStyle,
  type AutocompleteInteraction,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type Guild,
  type Interaction,
  type ModalSubmitInteraction,
  type StringSelectMenuInteraction,
} from 'discord.js';
import { matchFaq } from '../ai/faq.js';
import { cmdClean } from './clean.js';
import { cmdPlayerIds } from './playerIds.js';
import { lookupRule } from '../ai/ruleLookup.js';
import { buildComplaint } from '../complaint.js';
import { COMPLAINTS_FORUM_URL } from '../config.js';
import { getFaq, getGuild, listFaq, searchRulePoints, type RuleRow } from '../db/repo.js';
import { askSafely, gateQuestion } from '../discord/ask.js';
import { buildDmHome } from '../discord/dmMenu.js';
import { COLORS, audit, logAnswerTrace } from '../discord/guildLog.js';
import { computePerms, fetchMember, isGuildAdmin } from '../discord/permissions.js';
import { applySetup, inspectSetup, postSettingsMenu, CHANNEL_NAMES } from '../discord/setupGuild.js';
import { startRefresh } from '../discord/settingsMenu.js';
import { button, ephemeralIfGuild, modal, row, textInput } from '../discord/ui.js';
import { UserError } from '../util/errors.js';
import { normalizeRulePoint, truncate } from '../util/text.js';

/** Сервер, на котором стоит бот, либо null (ЛС или пользовательская установка на чужом сервере). */
function botGuild(i: Interaction): Guild | null {
  if (!i.guildId) return null;
  return i.client.guilds.cache.get(i.guildId) ?? null;
}

// ---------- /setup ----------

async function cmdSetup(i: ChatInputCommandInteraction) {
  if (!i.inCachedGuild()) throw new UserError('Команда работает только на сервере, куда добавлен бот.');
  if (!isGuildAdmin(i.member)) throw new UserError('⛔ Команда доступна только администраторам сервера.');
  await i.deferReply({ flags: MessageFlags.Ephemeral });
  const inspection = await inspectSetup(i.guild);

  if (inspection.isNew) {
    const res = await applySetup(i.client, i.guild);
    await audit(i.client, i.guild.id, i.user.id, 'Выполнен /setup', res.created.join(', ') || 'всё уже было');
    startRefresh(i.client, i.guild.id, i.user.id);
    const embed = new EmbedBuilder()
      .setColor(COLORS.ok)
      .setTitle('✅ NOVA RP AI настроен')
      .setDescription(
        [
          `Создано: ${res.created.join(', ') || '—'}`,
          '',
          '**Что дальше:**',
          `1. Откройте <#${getGuild(i.guild.id)?.settings_channel_id}> → «AI-токен»: выберите провайдера и введите токен.`,
          '2. «Роли» — настройте, кто может задавать вопросы и с каким лимитом.',
          '3. «Источники» — стандартные ссылки форума уже добавлены, первичная индексация запущена в фоне.',
          `4. Игроки задают вопросы в <#${getGuild(i.guild.id)?.assistant_channel_id}> или командой /вопрос.`,
          `5. Изменения правил на форуме бот будет публиковать в <#${getGuild(i.guild.id)?.rules_channel_id}> (жалобы туда не попадают).`,
        ].join('\n'),
      );
    await i.editReply({ embeds: [embed] });
    return;
  }

  const components = [
    row(
      ...(inspection.missing.length ? [button(`setup:restore:${i.guild.id}`, 'Восстановить недостающее', ButtonStyle.Primary, '🛠')] : []),
      button(`setup:menu:${i.guild.id}`, 'Переотправить меню', ButtonStyle.Secondary, '📨'),
    ),
  ];
  const embed = new EmbedBuilder()
    .setColor(inspection.missing.length ? COLORS.warn : COLORS.ok)
    .setTitle('ℹ️ Бот уже настроен на этом сервере')
    .setDescription(
      inspection.missing.length
        ? `Дубли создаваться не будут.\n\n**Не хватает:**\n${inspection.missing.map((m) => `• ${m}`).join('\n')}\n\nНажмите «Восстановить недостающее».`
        : 'Все каналы и меню на месте. Дубли создаваться не будут.',
    );
  await i.editReply({ embeds: [embed], components });
}

async function onSetupButton(i: ButtonInteraction) {
  const [, op, guildId] = i.customId.split(':');
  if (!i.inCachedGuild() || i.guildId !== guildId) throw new UserError('Эта кнопка работает только на своём сервере.');
  const member = await i.guild.members.fetch({ user: i.user.id, force: true });
  if (!isGuildAdmin(member)) throw new UserError('⛔ Только для администраторов.');

  if (op === 'restore') {
    // Создание каналов занимает больше 3 секунд — сначала подтверждаем нажатие, потом редактируем ответ.
    await i.deferUpdate();
    const res = await applySetup(i.client, i.guild);
    await audit(i.client, guildId, i.user.id, 'Восстановление /setup', res.created.join(', ') || 'ничего');
    await i.editReply({
      embeds: [
        new EmbedBuilder()
          .setColor(COLORS.ok)
          .setTitle('🛠 Восстановлено')
          .setDescription(res.created.length ? res.created.map((c) => `• ${c}`).join('\n') : 'Всё уже было на месте.'),
      ],
      components: [],
    });
    return;
  }
  if (op === 'menu') {
    await i.deferUpdate();
    const g = getGuild(guildId);
    const ch = g?.settings_channel_id ? await i.guild.channels.fetch(g.settings_channel_id).catch(() => null) : null;
    if (ch?.type !== ChannelType.GuildText) {
      throw new UserError(`Канал #${CHANNEL_NAMES.settings} не найден — используйте «Восстановить недостающее».`);
    }
    if (g?.settings_message_id) await ch.messages.delete(g.settings_message_id).catch(() => undefined);
    await postSettingsMenu(i.guild, ch);
    await audit(i.client, guildId, i.user.id, 'Меню настроек отправлено заново');
    await i.editReply({ content: `📨 Меню отправлено в <#${ch.id}>.`, embeds: [], components: [] });
  }
}

// ---------- /setupls ----------

async function cmdSetupLs(i: ChatInputCommandInteraction) {
  if (!i.inGuild()) {
    await i.reply(buildDmHome());
    return;
  }
  try {
    await i.user.send(buildDmHome());
    await i.reply({ content: '📬 Меню отправлено вам в личные сообщения.', flags: MessageFlags.Ephemeral });
  } catch {
    throw new UserError('Не удалось написать вам в ЛС. Разрешите личные сообщения от участников сервера и повторите.');
  }
}

// ---------- /вопрос ----------

async function cmdAsk(i: ChatInputCommandInteraction) {
  const question = i.options.getString('текст', true);
  const hidden = i.options.getBoolean('скрытно') ?? false;
  const guild = botGuild(i);
  const gate = await gateQuestion(i.client, guild, i.user.id, i.channelId);
  if (!gate.ok) {
    await i.reply({ content: gate.message, flags: MessageFlags.Ephemeral });
    return;
  }
  await i.deferReply({ flags: hidden ? MessageFlags.Ephemeral : undefined });
  const res = await askSafely(i.client, gate.guildId, i.user.id, question);
  const sent = await i.editReply({ content: res.text, allowedMentions: { parse: [] } });
  // Скрытый ответ виден только игроку — ссылку на него не даём.
  void logAnswerTrace(i.client, gate.guildId, i.user.id, question, res, hidden ? undefined : sent.url);
}

// ---------- /правило и /наказание ----------

function ruleSourceLine(r: RuleRow): string {
  return `[${truncate(r.doc_title, 80)}](${r.post_url})`;
}

function findRuleOrThrow(raw: string, guild: Guild | null): { point: string; rows: RuleRow[] } {
  const point = normalizeRulePoint(raw);
  if (!point) throw new UserError('Укажите номер пункта в формате 5.4');
  const rows = lookupRule(point, guild?.id ?? null);
  if (!rows.length) {
    throw new UserError(`🔍 Пункт **${point}** не найден в базе знаний. Проверьте номер или попросите администрацию обновить базу («Источники» → «Обновить базу знаний»).`);
  }
  return { point, rows };
}

async function cmdRule(i: ChatInputCommandInteraction) {
  const { point, rows } = findRuleOrThrow(i.options.getString('номер', true), botGuild(i));
  const [best, ...others] = rows;
  const embed = new EmbedBuilder()
    .setColor(COLORS.info)
    .setTitle(`📏 Пункт ${point}`)
    .setDescription(truncate(best.text, 3500))
    .addFields({ name: '⚖️ Наказание', value: truncate(best.punishment ?? 'не указано в тексте правил', 1000) });
  if (best.repeat_warn) embed.addFields({ name: '🔁 Повторное нарушение', value: 'WARN' });
  embed.addFields({ name: '🔗 Источник', value: ruleSourceLine(best) });
  if (others.length) {
    embed.addFields({ name: 'Также встречается', value: others.slice(0, 3).map(ruleSourceLine).join('\n') });
  }
  await i.reply({ embeds: [embed] });
}

async function cmdPunishment(i: ChatInputCommandInteraction) {
  const { point, rows } = findRuleOrThrow(i.options.getString('пункт', true), botGuild(i));
  const best = rows[0];
  const repeat = best.repeat_warn
    ? '✅ Да — при повторном нарушении выдаётся **WARN**.'
    : best.punishment && /повтор/i.test(best.punishment)
      ? `ℹ️ Для повторного нарушения указано: ${truncate(best.punishment, 300)}`
      : '— В правилах отдельное наказание за повтор не указано.';
  const embed = new EmbedBuilder()
    .setColor(COLORS.warn)
    .setTitle(`⚖️ Наказание за пункт ${point}`)
    .setDescription(
      best.punishment
        ? `**${truncate(best.punishment, 1000)}**`
        : 'В тексте правил наказание для этого пункта не указано. Возможно, оно определяется администрацией по ситуации.',
    )
    .addFields(
      { name: '🔁 Повтор → WARN?', value: repeat },
      { name: '📏 Суть пункта', value: truncate(best.text, 1000) },
      { name: '🔗 Источник', value: ruleSourceLine(best) },
    );
  await i.reply({ embeds: [embed] });
}

async function autocompleteRule(i: AutocompleteInteraction) {
  const focused = String(i.options.getFocused()).trim().replace(',', '.');
  const prefix = focused.replace(/[^\d.]/g, '');
  const rows = searchRulePoints(prefix, 25);
  await i.respond(rows.map((r) => ({ name: truncate(`${r.point} — ${r.text}`, 100), value: r.point })));
}

// ---------- /жалоба ----------

async function cmdComplaint(i: ChatInputCommandInteraction) {
  await i.showModal(
    modal('complaint:m', 'Жалоба на игрока', [
      textInput('nick', 'Ник игрока', { max: 64, placeholder: 'Имя_Фамилия' }),
      textInput('id', 'ID нарушителя', { max: 10, placeholder: '54321' }),
      textInput('dt', 'Дата и время нарушения (МСК)', { max: 40, placeholder: '13.10.2026 18:30' }),
      textInput('proof', 'Доказательства (ссылки)', { style: TextInputStyle.Paragraph, max: 1000, placeholder: 'https://youtu.be/...' }),
      textInput('rule', 'Пункт правил', { max: 12, placeholder: '5.4' }),
    ]),
  );
}

async function onComplaintModal(i: ModalSubmitInteraction) {
  const guild = botGuild(i);
  const draft = buildComplaint(
    {
      nick: i.fields.getTextInputValue('nick'),
      offenderId: i.fields.getTextInputValue('id'),
      dateTime: i.fields.getTextInputValue('dt'),
      evidence: i.fields.getTextInputValue('proof'),
      rulePoint: i.fields.getTextInputValue('rule'),
    },
    (point) => {
      const r = lookupRule(point, guild?.id ?? null)[0];
      return r ? { point: r.point, text: r.text, punishment: r.punishment, url: r.post_url } : null;
    },
  );
  const ok = draft.errors.length === 0;
  const embed = new EmbedBuilder()
    .setColor(ok ? COLORS.ok : COLORS.warn)
    .setTitle(ok ? '📝 Жалоба готова — скопируйте на форум' : '📝 Черновик жалобы — исправьте ошибки')
    .setDescription(
      truncate(
        [
          '**Заголовок темы** (форма: «Пункт правил | ID нарушителя»):',
          '```',
          draft.title,
          '```',
          '**Текст жалобы:**',
          '```',
          draft.body.replace(/```/g, "'''"),
          '```',
        ].join('\n'),
        4000,
      ),
    );
  if (draft.rule) {
    embed.addFields({
      name: `✅ Пункт ${draft.rule.point} найден`,
      value: truncate(`${draft.rule.punishment ? `Наказание: **${draft.rule.punishment}**\n` : ''}[Открыть в правилах](${draft.rule.url})`, 1000),
    });
  }
  if (draft.errors.length) embed.addFields({ name: '❌ Ошибки', value: truncate(draft.errors.map((e) => `• ${e}`).join('\n'), 1000) });
  if (draft.warnings.length) embed.addFields({ name: '⚠️ Проверьте', value: truncate(draft.warnings.map((e) => `• ${e}`).join('\n'), 1000) });
  embed.addFields({
    name: '📮 Куда подавать',
    value: `Раздел «Жалобы на игроков»: ${COMPLAINTS_FORUM_URL}\nЖалоба подаётся в течение 48 часов, только участником ситуации, одна РП-ситуация — одна тема.`,
  });
  // Ник и ID видит только автор жалобы.
  await i.reply({ embeds: [embed], flags: ephemeralIfGuild(i) });
}

// ---------- /faq ----------

async function cmdFaq(i: ChatInputCommandInteraction) {
  const guild = botGuild(i);
  if (!guild) throw new UserError('FAQ доступен только на сервере с ботом.');
  const faqs = listFaq(guild.id);
  if (!faqs.length) throw new UserError('📌 Администрация ещё не добавила быстрых ответов.');
  const query = i.options.getString('вопрос');
  if (query) {
    const byId = /^#(\d+)$/.exec(query.trim());
    const f = byId ? getFaq(Number(byId[1])) : matchFaq(query, faqs);
    if (f && f.guild_id === guild.id) {
      await i.reply({ embeds: [new EmbedBuilder().setColor(COLORS.info).setTitle(`📌 ${truncate(f.question, 250)}`).setDescription(truncate(f.answer, 4000))] });
      return;
    }
  }
  const embed = new EmbedBuilder()
    .setColor(COLORS.info)
    .setTitle('📌 FAQ сервера')
    .setDescription(`${query ? 'Точного совпадения нет. ' : ''}Выберите вопрос в списке:\n\n${faqs.slice(0, 25).map((f) => `• ${truncate(f.question, 90)}`).join('\n')}`);
  const select = new StringSelectMenuBuilder()
    .setCustomId(`faq:show:${guild.id}`)
    .setPlaceholder('Выберите вопрос…')
    .addOptions(faqs.slice(0, 25).map((f) => ({ label: truncate(f.question, 100), value: String(f.id) })));
  await i.reply({ embeds: [embed], components: [row(select)], flags: MessageFlags.Ephemeral });
}

async function onFaqSelect(i: StringSelectMenuInteraction) {
  const f = getFaq(Number(i.values[0]));
  const [, , guildId] = i.customId.split(':');
  if (!f || f.guild_id !== guildId) throw new UserError('Ответ не найден (возможно, удалён).');
  await i.reply({
    embeds: [new EmbedBuilder().setColor(COLORS.info).setTitle(`📌 ${truncate(f.question, 250)}`).setDescription(truncate(f.answer, 4000))],
    flags: MessageFlags.Ephemeral,
  });
}

async function autocompleteFaq(i: AutocompleteInteraction) {
  if (!i.guildId) return i.respond([]);
  const q = String(i.options.getFocused()).toLowerCase();
  const faqs = listFaq(i.guildId).filter((f) => !q || f.question.toLowerCase().includes(q));
  await i.respond(faqs.slice(0, 25).map((f) => ({ name: truncate(f.question, 100), value: `#${f.id}` })));
}

// ---------- /помощь ----------

async function cmdHelp(i: ChatInputCommandInteraction) {
  const embed = new EmbedBuilder()
    .setColor(COLORS.info)
    .setTitle('📖 AI-помощник NOVA RP — команды')
    .setDescription(
      [
        '**Для игроков**',
        '`/вопрос <текст>` — задать вопрос AI (параметр «скрытно» — ответ увидите только вы)',
        '`/правило <номер>` — текст пункта правил и наказание, например `/правило 5.4`',
        '`/наказание <пункт>` — какое наказание и даёт ли повтор WARN',
        '`/жалоба` — помощник: оформит жалобу на игрока по форме форума',
        '`/faq` — быстрые ответы администрации',
        '`/мой-id добавить` — привязать игровой ID: бот упомянет вас, если на форуме подадут жалобу на этот ID',
        '`/setupls` — личное меню в ЛС (свой токен, длина ответа, источники)',
        '`/clean [канал] [количество]` — удалить сообщения бота в канале (нужно «Управлять сообщениями») или в ЛС; меню и важное остаются',
        '',
        `Также можно просто писать вопросы в канал #${CHANNEL_NAMES.assistant} или боту в ЛС.`,
        `Обновления правил с форума публикуются в #${CHANNEL_NAMES.rules}.`,
        '',
        '**Для администраторов**',
        '`/setup` — создать категорию «NOVA RP AI», каналы и меню настроек',
        `Меню в #${CHANNEL_NAMES.settings}: роли, AI-токен, источники, каналы, FAQ, статус`,
        '',
        '_AI отвечает только по данным форума forum.nova-rp.com и только на вопросы о NOVA RP._',
      ].join('\n'),
    );
  await i.reply({ embeds: [embed], flags: ephemeralIfGuild(i) });
}

// ---------- маршрутизация ----------

/** Запрет команд по ролям (меню «Роли» → «Команды»). /setup всегда только для администраторов. */
async function assertCommandAllowed(i: ChatInputCommandInteraction): Promise<void> {
  if (i.commandName === 'setup') return;
  const guild = botGuild(i);
  if (!guild) return;
  const member = await fetchMember(guild, i.user.id);
  if (member && computePerms(member).blockedCommands.has(i.commandName)) {
    throw new UserError(`⛔ Команда /${i.commandName} недоступна для вашей роли на этом сервере.`);
  }
}

export async function handleCommand(i: ChatInputCommandInteraction): Promise<void> {
  await assertCommandAllowed(i);
  switch (i.commandName) {
    case 'setup':
      return cmdSetup(i);
    case 'setupls':
      return cmdSetupLs(i);
    case 'вопрос':
      return cmdAsk(i);
    case 'правило':
      return cmdRule(i);
    case 'наказание':
      return cmdPunishment(i);
    case 'жалоба':
      return cmdComplaint(i);
    case 'faq':
      return cmdFaq(i);
    case 'помощь':
      return cmdHelp(i);
    case 'clean':
      return cmdClean(i);
    case 'мой-id':
      return cmdPlayerIds(i);
    default:
      throw new UserError('Неизвестная команда.');
  }
}

export async function handleAutocomplete(i: AutocompleteInteraction): Promise<void> {
  if (i.commandName === 'правило' || i.commandName === 'наказание') return autocompleteRule(i);
  if (i.commandName === 'faq') return autocompleteFaq(i);
  await i.respond([]);
}

export { onComplaintModal, onFaqSelect, onSetupButton };
