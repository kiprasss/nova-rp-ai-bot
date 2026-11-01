export interface ExtractedRule {
  point: string;
  text: string;
  punishment: string | null;
  repeatWarn: boolean;
}

/** «5.4 Текст», «2.1. Текст», «п. 3.2 Текст». */
export const POINT_RE = /^(?:п\.?\s*|пункт\s+)?(\d{1,2}(?:\.\d{1,2}){1,2})\.?(?:\s+|$)(.*)$/iu;
/** Заголовок раздела: «3. Название» — завершает текущий пункт. */
export const SECTION_RE = /^\d{1,2}\.\s+\S/u;

const PUNISH_WORDS =
  '(?:JAIL|WARN|BAN|MUTE|KICK|DEMORGAN|ДЕМОРГАН|ДЖАЙЛ|ВАРН|БАН|МУТ|КИК|ЧС|Ч\\.С\\.|Изъятие|Увольнение|Понижение|Предупреждение|Устное предупреждение|Выговор|Снятие|Обнуление|Лишение|Блокировка)';
const PUNISH_RE = new RegExp(`(^|[\\s|:—–(-])${PUNISH_WORDS}`, 'iu');

export function isRepeatWarn(punishment: string): boolean {
  return /WARN[^|]*повтор|повтор[^|]*WARN|ВАРН[^|]*повтор/iu.test(punishment);
}

/** Отделяет наказание от текста пункта: «Текст | JAIL 60 минут | WARN при повторном нарушении». */
export function splitPunishment(block: string): { text: string; punishment: string | null } {
  const parts = block.split('|').map((p) => p.trim());
  if (parts.length > 1) {
    const idx = parts.findIndex((p, i) => i > 0 && PUNISH_RE.test(p));
    if (idx > 0) {
      return {
        text: parts.slice(0, idx).join(' | ').trim(),
        punishment: parts.slice(idx).filter(Boolean).join(' | ').replace(/\.$/, '').trim(),
      };
    }
  }
  const m = block.match(/(?:Наказание|Наказания|Санкция)\s*[:—–-]\s*(.+)$/imu);
  if (m) return { text: block.slice(0, m.index).trim(), punishment: m[1].replace(/\.$/, '').trim() };
  return { text: block.trim(), punishment: null };
}

/** Ищет пункты правил вида «N.N текст | наказание» в тексте сообщения. */
export function extractRules(text: string, maxContinuationLines = 6): ExtractedRule[] {
  const rules: ExtractedRule[] = [];
  // closed = в пункте уже встретилось наказание: дальнейшие строки к нему не относятся.
  let current: { point: string; lines: string[]; extra: number; closed: boolean } | null = null;
  const hasPunishment = (line: string) => splitPunishment(line).punishment !== null;

  const flush = () => {
    if (!current) return;
    const block = current.lines.join('\n').trim();
    const { text: body, punishment } = splitPunishment(block.replace(/\n+/g, ' ').replace(/\s{2,}/g, ' '));
    if (body.length >= 8) {
      rules.push({
        point: current.point,
        text: body.slice(0, 1500),
        punishment: punishment ? punishment.slice(0, 500) : null,
        repeatWarn: punishment ? isRepeatWarn(punishment) : false,
      });
    }
    current = null;
  };

  for (const raw of text.split('\n')) {
    const line = raw.trim();
    const m = line.match(POINT_RE);
    if (m) {
      flush();
      current = { point: m[1], lines: [m[2]], extra: 0, closed: hasPunishment(m[2]) };
      continue;
    }
    if (!current) continue;
    if (SECTION_RE.test(line)) {
      flush();
      continue;
    }
    if (!line || current.closed || current.extra >= maxContinuationLines) continue;
    current.lines.push(line);
    current.extra++;
    current.closed = hasPunishment(line);
  }
  flush();
  return rules;
}
