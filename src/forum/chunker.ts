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
