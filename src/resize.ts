// 送る前に写真を小さくする(VPN で遅いとき用)。元の写真はそのまま残る。
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';

export type SendSize = 'orig' | '2048' | '1280';

// 戻り値: 送る写真のパス(縮小したときは新しいファイル、しないときは元のまま)
export async function shrinkIfNeeded(path: string, size: SendSize): Promise<string> {
  if (size === 'orig') return path;
  const long = size === '2048' ? 2048 : 1280;
  const uri = path.startsWith('file://') ? path : 'file://' + path;
  try {
    const ctx = ImageManipulator.manipulate(uri);
    // 幅・高さのどちらが長いか分からないので、いったん読んで大きさを見る
    const first = await ctx.renderAsync();
    const w = first.width;
    const h = first.height;
    if (Math.max(w, h) <= long) return path;
    const ctx2 = ImageManipulator.manipulate(uri);
    ctx2.resize(w >= h ? { width: long } : { height: long });
    const out = await (await ctx2.renderAsync()).saveAsync({ format: SaveFormat.JPEG, compress: 0.85 });
    return out.uri.replace(/^file:\/\//, '');
  } catch {
    return path; // 縮小できなければ、元の写真を送る
  }
}
