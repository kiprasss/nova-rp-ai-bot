/**
 * Скрытие персональных данных игроков (ники, ID, контакты) из текста жалоб.
 * Бот отвечает о правилах и процедурах, а не о конкретных людях.
 */
const SENSITIVE_LABEL =
  /(ник|nick|никнейм|\bid\b|айди|static|статик|discord|дискорд|\bvk\b|telegram|телеграм|steam|\bip\b)/iu;

export const HIDDEN = '[скрыто]';

export function isSensitiveLabel(label: string): boolean {
  return SENSITIVE_LABEL.test(label);
}

export function sanitizeField(label: string, value: string): string {
  return isSensitiveLabel(label) ? HIDDEN : value;
}

const LINE_RE =
  /^([^\S\n]*[^\n:]{0,40}?(?:ник|nick|никнейм|\bid\b|айди|static ?id|статик|discord|дискорд)[^\n:]{0,30}?[:—–-][^\S\n]*)(\S.*)$/gimu;

/** Маскирует строки вида «Ник игрока: John Doe», «ID нарушителя - 12345». */
export function sanitizeText(text: string): string {
  return text.replace(LINE_RE, (_all, head: string) => `${head}${HIDDEN}`);
}

/** «5.4 ОП / ID 54321» → «5.4 ОП / ID [скрыто]»; одиночные ID из 3–7 цифр тоже скрываются. */
export function sanitizeComplaintTitle(title: string): string {
  return title.replace(/(?<![\d.])\d{3,7}(?![\d.])/g, HIDDEN);
}
