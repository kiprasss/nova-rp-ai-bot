import {
  ButtonStyle,
  EmbedBuilder,
  StringSelectMenuBuilder,
  type BaseMessageOptions,
  type Client,
  type MessageComponentInteraction,
  type ModalSubmitInteraction,
} from 'discord.js';
import { PROVIDERS, isProviderId, verifyToken } from '../ai/providers.js';
import { maskSecret, secrets } from '../crypto.js';
import { getUserSettings, saveUserSettings } from '../db/repo.js';
import { UserError } from '../util/errors.js';
import { truncate } from '../util/text.js';
import { COLORS } from './guildLog.js';
import { buildMainMenu } from './mainMenu.js';
import { CUSTOM_MODEL, liveModels, modelSelect } from './modelSelect.js';
import { canManageAnything, computePerms, fetchMember, findDmTokenGuild } from './permissions.js';
import { button, modal, row, textInput, updateOrReply } from './ui.js';

type DmInteraction = MessageComponentInteraction | ModalSubmitInteraction;

function backHome() {
  return button('dm:open:home', 'Назад', ButtonStyle.Secondary, '⬅️');
}

export function buildDmHome(): BaseMessageOptions {
  const embed = new EmbedBuilder()
    .setColor(COLORS.info)
    .setTitle('🤖 NOVA RP AI — личное меню')
    .setDescription(
      [
        '🖥 **Мои серверы** — управление ботом на серверах, где вы администратор',
        '🔑 **Личный токен** — свой AI-токен для вопросов в ЛС',
        '⚙️ **Личные настройки** — длина ответа и показ источников',
        '',
        '💬 В личных сообщениях можно просто написать вопрос — AI ответит по данным форума NOVA RP.',
      ].join('\n'),
    );
  const select = new StringSelectMenuBuilder()
    .setCustomId('dm:main')
    .setPlaceholder('Выберите раздел…')
    .addOptions(
      { label: 'Мои серверы', value: 'servers', emoji: '🖥', description: 'Роли, токены, источники ваших серверов' },
      { label: 'Личный токен', value: 'token', emoji: '🔑', description: 'AI-токен для личного использования в ЛС' },
      { label: 'Личные настройки', value: 'prefs', emoji: '⚙️', description: 'Кратко/подробно, показ источников' },
    );
  return { embeds: [embed], components: [row(select)] };
}

async function viewServers(client: Client, userId: string): Promise<BaseMessageOptions> {
  const options: { label: string; value: string; description: string }[] = [];
  for (const guild of client.guilds.cache.values()) {
    if (options.length >= 25) break;
    const member = await fetchMember(guild, userId);
    if (!member) continue;
    const perms = computePerms(member);
    if (!canManageAnything(perms)) continue;
    options.push({
      label: truncate(guild.name, 100),
      value: guild.id,
      description: perms.isAdmin ? 'Администратор — полный доступ' : 'Ограниченный доступ по ролям',
    });
  }
  const embed = new EmbedBuilder()
    .setColor(COLORS.info)
    .setTitle('🖥 Мои серверы')
    .setDescription(
      options.length
        ? 'Выберите сервер — откроется та же панель, что и в #ai-настройки. Права проверяются при каждом действии.'
        : 'Не найдено серверов с ботом, где у вас есть права администратора или управления ботом.',
    );
  const components = [row(backHome())];
  if (options.length) {
    components.unshift(row(new StringSelectMenuBuilder().setCustomId('dm:guild').setPlaceholder('Выберите сервер…').addOptions(options)));
  }
  return { embeds: [embed], components };
}

async function viewToken(client: Client, userId: string, note?: string): Promise<BaseMessageOptions> {
  const s = getUserSettings(userId);
  let inUse: string;
  if (s.ai_token) inUse = '🔑 ваш личный токен';
  else {
    const donor = await findDmTokenGuild(client, userId);
    inUse = donor
      ? `🖥 токен сервера **${donor.guild.name}** (личный токен не нужен — можно сразу писать вопросы)`
      : '❌ нет — задайте личный токен или попросите администрацию сервера разрешить вашей роли «Бот в ЛС с токеном сервера»';
  }
  const provider = isProviderId(s.ai_provider) ? PROVIDERS[s.ai_provider] : null;
  let masked = 'не задан';
  if (s.ai_token) {
    try {
      masked = `\`${maskSecret(secrets.decrypt(s.ai_token))}\``;
    } catch {
      masked = '⚠️ не расшифровывается — введите заново';
    }
  }
  const embed = new EmbedBuilder()
    .setColor(COLORS.info)
    .setTitle('🔑 Личный AI-токен')
    .setDescription(
      [
        note ?? '',
        `**Сейчас в ЛС используется:** ${inUse}`,
        '',
        `**Провайдер:** ${provider?.label ?? 'не выбран'}`,
        `**Модель:** ${s.ai_model || (provider ? `${provider.defaultModel} (по умолчанию)` : '—')}`,
        `**Токен:** ${masked}`,
        '',
        'Личный токен необязателен и имеет приоритет над токеном сервера. Хранится зашифрованным, целиком не показывается.',
      ]
        .filter((l, i) => i !== 0 || l)
        .join('\n'),
    );
  const select = new StringSelectMenuBuilder()
    .setCustomId('dm:prov')
    .setPlaceholder('Выберите AI-провайдера…')
    .addOptions(Object.values(PROVIDERS).map((p) => ({ label: p.label, value: p.id, default: p.id === s.ai_provider })));
  return {
    embeds: [embed],
    components: [
      row(select),
      ...(provider ? [row(modelSelect('dm:modelsel', provider, s.ai_model, await liveModels(provider, s.ai_token)))] : []),
      row(
        button('dm:tok', 'Ввести токен', ButtonStyle.Primary, '🔑'),
        button('dm:tokchk', 'Проверить токен', ButtonStyle.Success, '✅'),
        button('dm:tokdel', 'Удалить', ButtonStyle.Danger, '🗑'),
        backHome(),
      ),
    ],
  };
}

function viewPrefs(userId: string, note?: string): BaseMessageOptions {
  const s = getUserSettings(userId);
  const embed = new EmbedBuilder()
    .setColor(COLORS.info)
    .setTitle('⚙️ Личные настройки')
    .setDescription(
      `${note ? `${note}\n\n` : ''}**Длина ответа:** ${s.answer_length === 'long' ? 'подробно' : s.answer_length === 'short' ? 'кратко' : 'как на сервере'}\n**Показывать источники:** ${s.show_sources ? 'да' : 'нет'}\n\nНастройки действуют для ваших вопросов везде (на серверах и в ЛС).`,
    );
  return {
    embeds: [embed],
    components: [
      row(
        button('dm:len:short', 'Кратко', s.answer_length === 'short' ? ButtonStyle.Primary : ButtonStyle.Secondary, '✂️'),
        button('dm:len:long', 'Подробно', s.answer_length === 'long' ? ButtonStyle.Primary : ButtonStyle.Secondary, '📖'),
        button('dm:len:auto', 'Как на сервере', s.answer_length === 'auto' ? ButtonStyle.Primary : ButtonStyle.Secondary, '🖥'),
        button('dm:src', s.show_sources ? 'Скрывать источники' : 'Показывать источники', ButtonStyle.Secondary, '🔗'),
        backHome(),
      ),
    ],
  };
}

export async function handleDmInteraction(i: DmInteraction): Promise<void> {
  const [, op, arg] = i.customId.split(':');
  const uid = i.user.id;
  const s = getUserSettings(uid);

  switch (op) {
    case 'main':
    case 'open': {
      const section = op === 'main' && i.isStringSelectMenu() ? i.values[0] : arg;
      if (section === 'servers') await updateOrReply(i, await viewServers(i.client, uid));
      else if (section === 'token') await updateOrReply(i, await viewToken(i.client, uid));
      else if (section === 'prefs') await updateOrReply(i, viewPrefs(uid));
      else await updateOrReply(i, buildDmHome());
      return;
    }
    case 'guild': {
      if (!i.isStringSelectMenu()) return;
      const guild = i.client.guilds.cache.get(i.values[0]);
      if (!guild) throw new UserError('Бот больше не находится на этом сервере.');
      const member = await fetchMember(guild, uid, true);
      if (!member || !canManageAnything(computePerms(member))) throw new UserError('⛔ У вас нет прав на управление ботом на этом сервере.');
      await updateOrReply(i, buildMainMenu(guild.id, guild.name));
      return;
    }
    case 'prov': {
      if (!i.isStringSelectMenu()) return;
      const p = i.values[0];
      if (!isProviderId(p)) return;
      if (s.ai_provider !== p) saveUserSettings({ ...s, ai_provider: p, ai_model: null, ai_token: null });
      await updateOrReply(i, await viewToken(i.client, uid, `✅ Провайдер: **${PROVIDERS[p].label}**. Теперь введите токен.`));
      return;
    }
    case 'tok': {
      if (!i.isButton()) return;
      if (!isProviderId(s.ai_provider)) throw new UserError('Сначала выберите AI-провайдера в списке.');
      const p = PROVIDERS[s.ai_provider];
      await i.showModal(
        modal('dm:tokm', `Личный токен ${p.label}`, [
          textInput('token', 'API-токен', { min: 10, max: 400, placeholder: p.tokenHint }),
          textInput('model', 'Модель (необязательно)', { required: false, max: 100, value: s.ai_model, placeholder: p.defaultModel }),
        ]),
      );
      return;
    }
    case 'modelsel': {
      if (!i.isStringSelectMenu() || !isProviderId(s.ai_provider)) return;
      const value = i.values[0];
      if (value === CUSTOM_MODEL) {
        await i.showModal(
          modal('dm:modelm', 'Модель AI', [
            textInput('model', 'Название модели (пусто — по умолчанию)', { required: false, max: 100, value: s.ai_model, placeholder: PROVIDERS[s.ai_provider].defaultModel }),
          ]),
        );
        return;
      }
      saveUserSettings({ ...s, ai_model: value });
      await updateOrReply(i, await viewToken(i.client, uid, `✅ Модель: **${value}**`));
      return;
    }
    case 'modelm': {
      if (!i.isModalSubmit()) return;
      saveUserSettings({ ...s, ai_model: i.fields.getTextInputValue('model').trim() || null });
      await updateOrReply(i, await viewToken(i.client, uid, '✅ Модель сохранена.'));
      return;
    }
    case 'tokm': {
      if (!i.isModalSubmit()) return;
      const token = i.fields.getTextInputValue('token').trim();
      if (/\s/.test(token)) throw new UserError('Токен не должен содержать пробелов.');
      const model = i.fields.getTextInputValue('model').trim() || null;
      saveUserSettings({ ...s, ai_token: secrets.encrypt(token), ai_model: model });
      await updateOrReply(i, await viewToken(i.client, uid, `✅ Токен сохранён: \`${maskSecret(token)}\``));
      return;
    }
    case 'tokchk': {
      if (!s.ai_token || !isProviderId(s.ai_provider)) throw new UserError('Токен ещё не задан.');
      await i.deferUpdate();
      let token: string;
      try {
        token = secrets.decrypt(s.ai_token);
      } catch {
        throw new UserError('Сохранённый токен не расшифровывается. Введите его заново.');
      }
      const res = await verifyToken(s.ai_provider, token);
      await i.editReply(await viewToken(i.client, uid, `${res.ok ? '✅' : '❌'} Проверка: ${res.message}`));
      return;
    }
    case 'tokdel': {
      saveUserSettings({ ...s, ai_token: null });
      await updateOrReply(i, await viewToken(i.client, uid, '🗑 Личный токен удалён.'));
      return;
    }
    case 'len': {
      saveUserSettings({ ...s, answer_length: arg === 'long' ? 'long' : arg === 'short' ? 'short' : 'auto' });
      await updateOrReply(i, viewPrefs(uid, '✅ Сохранено.'));
      return;
    }
    case 'src': {
      saveUserSettings({ ...s, show_sources: s.show_sources ? 0 : 1 });
      await updateOrReply(i, viewPrefs(uid, '✅ Сохранено.'));
      return;
    }
  }
}
