const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
type Level = keyof typeof LEVELS;

let threshold: number = LEVELS.info;

export function setLogLevel(level: string): void {
  threshold = LEVELS[(level as Level)] ?? LEVELS.info;
}

function write(level: Level, msg: string, extra?: unknown): void {
  if (LEVELS[level] < threshold) return;
  const line = `[${new Date().toISOString()}] ${level.toUpperCase().padEnd(5)} ${msg}`;
  const out = level === 'error' || level === 'warn' ? console.error : console.log;
  if (extra === undefined) out(line);
  else out(line, extra instanceof Error ? (extra.stack ?? extra.message) : extra);
}

export const log = {
  debug: (msg: string, extra?: unknown) => write('debug', msg, extra),
  info: (msg: string, extra?: unknown) => write('info', msg, extra),
  warn: (msg: string, extra?: unknown) => write('warn', msg, extra),
  error: (msg: string, extra?: unknown) => write('error', msg, extra),
};
