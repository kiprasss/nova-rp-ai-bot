import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0); // сигнал 0 только проверяет, что процесс существует
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Не даёт запустить второй экземпляр бота с той же базой на этом компьютере.
 * Возвращает PID уже запущенного экземпляра или null, если блокировка получена.
 */
export function acquireInstanceLock(lockPath: string): number | null {
  mkdirSync(dirname(lockPath), { recursive: true });
  if (existsSync(lockPath)) {
    const pid = Number(readFileSync(lockPath, 'utf8').trim());
    if (Number.isInteger(pid) && pid > 0 && pid !== process.pid && isAlive(pid)) return pid;
  }
  writeFileSync(lockPath, String(process.pid));
  const release = () => {
    try {
      if (existsSync(lockPath) && readFileSync(lockPath, 'utf8').trim() === String(process.pid)) unlinkSync(lockPath);
    } catch {
      // ничего страшного: устаревшая блокировка будет перезаписана
    }
  };
  process.on('exit', release);
  return null;
}
