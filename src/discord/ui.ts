import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  type BaseMessageOptions,
  type MessageActionRowComponentBuilder,
  type MessageComponentInteraction,
  type ModalSubmitInteraction,
  type RepliableInteraction,
} from 'discord.js';

export type Row = ActionRowBuilder<MessageActionRowComponentBuilder>;

export function row(...components: MessageActionRowComponentBuilder[]): Row {
  return new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(...components);
}

export function button(customId: string, label: string, style: ButtonStyle = ButtonStyle.Secondary, emoji?: string): ButtonBuilder {
  const b = new ButtonBuilder().setCustomId(customId).setLabel(label).setStyle(style);
  if (emoji) b.setEmoji(emoji);
  return b;
}

export interface InputOptions {
  style?: TextInputStyle;
  required?: boolean;
  value?: string | null;
  placeholder?: string;
  min?: number;
  max?: number;
}

export function textInput(customId: string, label: string, o: InputOptions = {}): TextInputBuilder {
  const t = new TextInputBuilder()
    .setCustomId(customId)
    .setLabel(label)
    .setStyle(o.style ?? TextInputStyle.Short)
    .setRequired(o.required ?? true);
  if (o.value) t.setValue(o.value);
  if (o.placeholder) t.setPlaceholder(o.placeholder);
  if (o.min !== undefined) t.setMinLength(o.min);
  if (o.max !== undefined) t.setMaxLength(o.max);
  return t;
}

export function modal(customId: string, title: string, inputs: TextInputBuilder[]): ModalBuilder {
  return new ModalBuilder()
    .setCustomId(customId)
    .setTitle(title)
    .addComponents(...inputs.map((t) => new ActionRowBuilder<TextInputBuilder>().addComponents(t)));
}

/** На сервере — эфемерно (видно только автору), в ЛС — обычным сообщением. */
export function ephemeralIfGuild(i: { inGuild(): boolean }): MessageFlags.Ephemeral | undefined {
  return i.inGuild() ? MessageFlags.Ephemeral : undefined;
}

/** Обновляет сообщение с меню (кнопки/селекты/модалки из сообщения) либо отвечает новым. */
export async function updateOrReply(i: MessageComponentInteraction | ModalSubmitInteraction, payload: BaseMessageOptions): Promise<void> {
  const body = { content: payload.content ?? '', embeds: payload.embeds ?? [], components: payload.components ?? [] };
  if (i.deferred || i.replied) {
    await i.editReply(body);
  } else if (i.isMessageComponent()) {
    await i.update(body);
  } else if (i.isFromMessage()) {
    await i.update(body);
  } else {
    await i.reply({ ...body, flags: ephemeralIfGuild(i) });
  }
}

/** Безопасно сообщает об ошибке пользователю, в каком бы состоянии ни было взаимодействие. */
export async function replyText(i: RepliableInteraction, content: string): Promise<void> {
  try {
    // После deferUpdate() у кнопок не затираем меню, а отправляем отдельное сообщение.
    if (i.deferred && !i.replied && !i.isMessageComponent()) await i.editReply({ content, embeds: [], components: [] });
    else if (i.replied || i.deferred) await i.followUp({ content, flags: ephemeralIfGuild(i) });
    else await i.reply({ content, flags: ephemeralIfGuild(i) });
  } catch {
    // взаимодействие могло истечь — ничего не поделать
  }
}
