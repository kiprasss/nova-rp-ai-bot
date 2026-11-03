export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, Math.max(0, max - 1));
  // Длинный список режем по последней целой строке, а не посреди пункта.
  const nl = cut.lastIndexOf('\n');
  if (nl > max * 0.6) return cut.slice(0, nl).trimEnd() + '\n…';
  return cut.trimEnd() + '…';
}

/** Нормализует номер пункта правил: «п. 5.4.» → «5.4». Возвращает null, если формат неверный. */
export function normalizeRulePoint(input: string): string | null {
  const m = input.trim().match(/(\d{1,2}(?:[.,]\d{1,2}){1,2})/);
  if (!m) return null;
  return m[1].replace(/,/g, '.');
}

export function formatDateTime(ts: number | null | undefined): string {
  if (!ts) return 'никогда';
  return `<t:${Math.floor(ts / 1000)}:f> (<t:${Math.floor(ts / 1000)}:R>)`;
}

export function plural(n: number, one: string, few: string, many: string): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}

export function minutesText(ms: number): string {
  const sec = Math.ceil(ms / 1000);
  if (sec < 60) return `${sec} ${plural(sec, 'секунду', 'секунды', 'секунд')}`;
  const min = Math.ceil(sec / 60);
  return `${min} ${plural(min, 'минуту', 'минуты', 'минут')}`;
}
