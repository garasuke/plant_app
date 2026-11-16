// 動作の記録(診断画面用)。新しい順に最大 80 件を端末内のファイルに残す。
// 個人情報(パスワード・写真の中身)は入れない。時刻と短い説明だけ。
import { File, Paths } from 'expo-file-system';

export type LogEntry = { at: number; level: 'info' | 'error'; msg: string };

const MAX = 80;
let mem: LogEntry[] | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
const file = () => new File(Paths.document, 'diag_log.json');

function load(): LogEntry[] {
  if (!mem) {
    mem = [];
    // 前回までの記録は、読めたら後ろにつなぐ
    (async () => {
      try {
        const f = file();
        if (f.exists) {
          const j = JSON.parse(await f.text());
          if (Array.isArray(j) && mem) mem.push(...j.slice(0, MAX));
          if (mem && mem.length > MAX) mem.length = MAX;
        }
      } catch {
        // 読めなければ空
      }
    })();
  }
  return mem;
}

function flushSoon() {
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    try {
      const f = file();
      if (!f.exists) f.create();
      f.write(JSON.stringify(mem ?? []));
    } catch {
      // 書けなくても続ける
    }
  }, 1500);
}

export function logInfo(msg: string): void {
  const l = load();
  l.unshift({ at: Date.now(), level: 'info', msg: msg.slice(0, 300) });
  if (l.length > MAX) l.length = MAX;
  flushSoon();
}
export function logError(msg: string): void {
  const l = load();
  l.unshift({ at: Date.now(), level: 'error', msg: msg.slice(0, 300) });
  if (l.length > MAX) l.length = MAX;
  flushSoon();
}
export function readLog(): LogEntry[] {
  return [...load()];
}
export function clearLog(): void {
  mem = [];
  flushSoon();
}
