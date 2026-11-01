import { POINT_RE, SECTION_RE, splitPunishment } from './rules.js';

/** Делит текст на фрагменты ~maxLen символов по абзацам/строкам/предложениям с небольшим перекрытием. */
export function chunkText(text: string, maxLen = 900, overlap = 120): string[] {
  const clean = text.trim();
  if (!clean) return [];
  if (clean.length <= maxLen) return [clean];

  // Атомы: строки; слишком длинные строки режем по предложениям, затем жёстко.
  const atoms: string[] = [];
  for (const line of clean.split('\n')) {
    if (line.length <= maxLen) {
      atoms.push(line);
      continue;
    }
    let buf = '';
    for (const sentence of line.split(/(?<=[.!?…])\s+/u)) {
      if ((buf + ' ' + sentence).trim().length > maxLen && buf) {
        atoms.push(buf.trim());
        buf = '';
      }
      if (sentence.length > maxLen) {
        for (let i = 0; i < sentence.length; i += maxLen) atoms.push(sentence.slice(i, i + maxLen));
      } else {
        buf += ' ' + sentence;
      }
    }
    if (buf.trim()) atoms.push(buf.trim());
  }

  const chunks: string[] = [];
  let cur = '';
  for (const atom of atoms) {
    const candidate = cur ? `${cur}\n${atom}` : atom;
    if (candidate.length > maxLen && cur) {
      chunks.push(cur.trim());
      const tail = cur.slice(-overlap);
      const cut = tail.indexOf(' ');
      const carry = overlap > 0 && cut >= 0 ? tail.slice(cut + 1) : '';
      cur = carry && carry.length + atom.length + 1 <= maxLen ? `${carry}\n${atom}` : atom;
    } else {
      cur = candidate;
    }
  }
  if (cur.trim()) chunks.push(cur.trim());
  return chunks.filter((c) => c.replace(/\s/g, '').length > 0);
}

/**
 * Фрагменты для тем с правилами: режем по границам пунктов, а не по длине.
 * Каждый пункт целиком (номер, текст, наказание, «Уточнение», «Примечание», «Исключение») в одном фрагменте;
 * фрагмент, начатый посреди раздела, получает заголовок раздела. Слишком длинный пункт делится,
 * и каждое продолжение подписано номером пункта и его наказанием — иначе модель не знает, к чему относится текст.
 */
export function chunkRulesText(text: string, maxLen = 1200, packLen = 600): string[] {
  const clean = text.trim();
  if (!clean) return [];
  const lines = clean.split('\n');
  if (!lines.some((l) => POINT_RE.test(l.trim()))) return chunkText(clean);

  interface Unit { text: string; point: string | null; section: string | null }
  const units: Unit[] = [];
  let section: string | null = null;
  let cur: Unit | null = null;
  const push = () => {
    if (cur && cur.text.trim()) units.push({ ...cur, text: cur.text.trim() });
    cur = null;
  };
  for (const raw of lines) {
    const line = raw.trim();
    const m = line.match(POINT_RE);
    if (m) {
      push();
      cur = { text: line, point: m[1], section };
    } else if ((SECTION_RE.test(line) || /^(Раздел|Глава)\s+\d+/iu.test(line)) && line.length <= 120) {
      push();
      section = line;
      cur = { text: line, point: null, section: null };
    } else if (cur) {
      cur.text += `\n${line}`;
    } else {
      cur = { text: line, point: null, section };
    }
  }
  push();

  // Длинные пункты — на части с подписью.
  const pieces: Unit[] = [];
  for (const u of units) {
    if (u.text.length <= maxLen) {
      pieces.push(u);
      continue;
    }
    const parts = chunkText(u.text, maxLen - 150, 0);
    const pun = u.point ? splitPunishment(parts[0].split('\n')[0]).punishment : null;
    parts.forEach((p, i) => {
      const label = i > 0 && u.point ? `Пункт ${u.point} (продолжение${pun ? `; наказание по пункту: ${pun}` : ''}):\n` : '';
      pieces.push({ text: label + p, point: u.point, section: u.section });
    });
  }

  const chunks: string[] = [];
  let buf = '';
  for (const p of pieces) {
    const candidate = buf ? `${buf}\n\n${p.text}` : p.text;
    // Пункты склеиваем только короткие (до packLen): фрагмент «один пункт» точнее находится поиском.
    if (buf && candidate.length > packLen) {
      chunks.push(buf);
      buf = p.section && p.point ? `${p.section}\n\n${p.text}` : p.text;
    } else {
      buf = candidate;
    }
  }
  if (buf.trim()) chunks.push(buf);
  return chunks;
}
