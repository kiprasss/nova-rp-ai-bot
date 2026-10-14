import { normalizeRulePoint } from './util/text.js';

export interface ComplaintInput {
  nick: string;
  offenderId: string;
  dateTime: string;
  evidence: string;
  rulePoint: string;
}

export interface RuleInfo {
  point: string;
  text: string;
  punishment: string | null;
  url: string;
}

export interface ComplaintDraft {
  title: string;
  body: string;
  date: string | null;
  time: string | null;
  rule: RuleInfo | null;
  errors: string[];
  warnings: string[];
}

/** Разрешённые хостинги доказательств (по «Правилам подачи жалоб на игроков»). */
export const ALLOWED_EVIDENCE_HOSTS = [
  'youtube.com', 'youtu.be', 'twitch.tv', 'disk.yandex.ru', 'disk.yandex.com', 'yadi.sk', 'drive.google.com',
  'trovo.live', 'rutube.ru', 'vk.com', 'vkvideo.ru', 'imgur.com', 'yapx.ru', 'yapx.cc', 'imgbb.com', 'ibb.co',
];

function hostAllowed(url: string): boolean {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '').replace(/^m\./, '');
    return ALLOWED_EVIDENCE_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
  } catch {
    return false;
  }
}

const pad = (n: number) => String(n).padStart(2, '0');

/** «13.10.2026 00:05», «13.10.2026 в 0,05», «13/10/26 18.30». Время — московское (как в игре). */
export function parseDateTime(raw: string): { date: string; time: string; utcMs: number } | null {
  const m = raw.trim().match(/(\d{1,2})[./-](\d{1,2})[./-](\d{2}|\d{4})\s*(?:г\.?)?\s*(?:в\s*)?(\d{1,2})[:.,](\d{2})/iu);
  if (!m) return null;
  const [d, mo, yRaw, h, mi] = m.slice(1).map(Number);
  const y = yRaw < 100 ? 2000 + yRaw : yRaw;
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59) return null;
  const utcMs = Date.UTC(y, mo - 1, d, h - 3, mi); // МСК = UTC+3
  const check = new Date(Date.UTC(y, mo - 1, d));
  if (check.getUTCDate() !== d) return null; // 31.02 и т.п.
  return { date: `${pad(d)}.${pad(mo)}.${y}`, time: `${pad(h)}:${pad(mi)}`, utcMs };
}

export function buildComplaint(input: ComplaintInput, findRule: (point: string) => RuleInfo | null, now = Date.now()): ComplaintDraft {
  const errors: string[] = [];
  const warnings: string[] = [];

  const nick = input.nick.trim();
  if (nick.length < 3) errors.push('Ник игрока слишком короткий.');
  else if (!/^[A-Za-z]+[ _][A-Za-z]+$/.test(nick)) warnings.push('Ник обычно имеет формат «Имя_Фамилия» или «Имя Фамилия» латиницей — проверьте написание.');

  const id = input.offenderId.trim();
  if (!/^\d{1,7}$/.test(id)) errors.push('ID нарушителя должен состоять только из цифр.');

  const dt = parseDateTime(input.dateTime);
  if (!dt) {
    errors.push('Не удалось распознать дату и время. Формат: ДД.ММ.ГГГГ ЧЧ:ММ (по МСК), например 13.10.2026 18:30.');
  } else if (dt.utcMs > now + 10 * 60_000) {
    errors.push('Дата нарушения в будущем — проверьте дату и время (указывайте время по МСК).');
  } else if (now - dt.utcMs > 48 * 3600_000) {
    warnings.push('С момента нарушения прошло больше 48 часов — по правилам подачи жалоба может быть отклонена.');
  }

  const urls = input.evidence.match(/https?:\/\/[^\s<>"]+/g) ?? [];
  if (!urls.length) errors.push('Добавьте ссылку на доказательства (видео или скриншоты).');
  const badHosts = urls.filter((u) => !hostAllowed(u));
  if (badHosts.length) {
    warnings.push(
      'Доказательства принимаются только с разрешённых ресурсов (YouTube, Twitch, Яндекс Диск, Google Drive, Trovo, Rutube, VK Video, Imgur, Yapx, Imgbb). Проверьте: ' +
        badHosts.join(', '),
    );
  }
  if (urls.some((u) => /youtu|twitch|rutube|vk|trovo/i.test(u))) {
    warnings.push('Видео: не менее 30 секунд, с началом ситуации, качество от 480p, с HUD игры и без монтажа.');
  }

  const point = normalizeRulePoint(input.rulePoint);
  let rule: RuleInfo | null = null;
  if (!point) {
    errors.push('Укажите номер пункта правил, например 5.4.');
  } else {
    rule = findRule(point);
    if (!rule) errors.push(`Пункт ${point} не найден в базе правил. Проверьте номер (или администрации нужно обновить базу знаний).`);
  }

  const ruleLine = rule ? `${rule.point} — ${rule.text}` : (point ?? input.rulePoint.trim());
  const body = [
    `Ник игрока: ${nick}`,
    `ID нарушителя: ${id}`,
    `Дата нарушения: ${dt?.date ?? input.dateTime.trim()}`,
    `Время нарушения: ${dt?.time ?? '—'}`,
    `Доказательства: ${urls.length ? urls.join(' ') : input.evidence.trim()}`,
    `Нарушенный пункт правил: ${ruleLine}`,
    ...(rule?.punishment ? [`Наказание по правилам: ${rule.punishment}`] : []),
  ].join('\n');

  return {
    title: `${point ?? 'Пункт'} / ID ${id || '—'}`,
    body,
    date: dt?.date ?? null,
    time: dt?.time ?? null,
    rule,
    errors,
    warnings,
  };
}
