// 電波がないときの撮影を、端末内に順番待ちで貯めておく。
// 1件 = フォルダ1つ(meta.json + 写真 / 動画から取り出したコマ)。
import { Directory, File, Paths } from 'expo-file-system';

export type QItem = {
  id: string;
  kind: 'photo' | 'burst';
  at: number; // 撮影した時刻(ミリ秒)
  files: string[]; // フォルダ内のファイル名(順番どおり)
  name: string; // 登録時のファイル名(任意)
  qr: string; // 撮影先を指すQRの文字(任意。送るときに記録を探す)
  geo?: { lat: number; lng: number; acc: number };
  tries: number;
  error?: string;
};

const root = () => new Directory(Paths.document, 'queue');
const dirOf = (id: string) => new Directory(root(), id);

export function itemFileUri(it: QItem, i: number): string {
  return new File(dirOf(it.id), it.files[i]).uri;
}

export async function queueList(): Promise<QItem[]> {
  const out: QItem[] = [];
  try {
    const r = root();
    if (!r.exists) return out;
    for (const e of r.list()) {
      if (!(e instanceof Directory)) continue;
      try {
        const m = new File(e, 'meta.json');
        if (m.exists) out.push(JSON.parse(await m.text()) as QItem);
      } catch {
        // 壊れた1件は飛ばす
      }
    }
  } catch {
    // 空として扱う
  }
  return out.sort((a, b) => a.at - b.at);
}

export async function queueAdd(
  kind: QItem['kind'],
  srcPaths: string[],
  extra: { name?: string; qr?: string; geo?: QItem['geo'] },
): Promise<QItem> {
  const id = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const d = dirOf(id);
  d.create({ intermediates: true, idempotent: true });
  const files: string[] = [];
  srcPaths.forEach((p, i) => {
    const nm = `${i + 1}.jpg`;
    const src = new File(p.startsWith('file://') ? p : 'file://' + p);
    src.copy(new File(d, nm));
    files.push(nm);
  });
  const it: QItem = { id, kind, at: Date.now(), files, name: extra.name || '', qr: extra.qr || '', geo: extra.geo, tries: 0 };
  const m = new File(d, 'meta.json');
  m.create();
  m.write(JSON.stringify(it));
  return it;
}

export async function queueUpdate(it: QItem): Promise<void> {
  const m = new File(dirOf(it.id), 'meta.json');
  if (!m.exists) m.create();
  m.write(JSON.stringify(it));
}

export function queueRemove(id: string): void {
  try {
    const d = dirOf(id);
    if (d.exists) d.delete();
  } catch {
    // 消せなくても続ける
  }
}
