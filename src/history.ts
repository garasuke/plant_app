// 調べもの画面の閲覧履歴(端末内のみ。最大 150 件)。
import { File, Paths } from 'expo-file-system';

export type HistEntry = { url: string; title: string; at: number };

const MAX = 150;
let mem: HistEntry[] | null = null;
const file = () => new File(Paths.document, 'browse_history.json');

export async function loadHistory(): Promise<HistEntry[]> {
  if (mem) return mem;
  try {
    const f = file();
    if (f.exists) {
      const j = JSON.parse(await f.text());
      if (Array.isArray(j)) {
        mem = j.filter((e) => e && typeof e.url === 'string').slice(0, MAX);
        return mem;
      }
    }
  } catch {
    // 読めなければ空
  }
  mem = [];
  return mem;
}

function save() {
  try {
    const f = file();
    if (!f.exists) f.create();
    f.write(JSON.stringify(mem ?? []));
  } catch {
    // 書けなくても続ける
  }
}

export async function addHistory(url: string, title: string): Promise<void> {
  if (!/^https?:\/\//i.test(url)) return;
  const l = await loadHistory();
  if (l[0] && l[0].url === url) {
    if (title && !l[0].title) l[0].title = title;
    return;
  }
  l.unshift({ url, title, at: Date.now() });
  if (l.length > MAX) l.length = MAX;
  save();
}

export async function clearHistory(): Promise<void> {
  mem = [];
  save();
}
