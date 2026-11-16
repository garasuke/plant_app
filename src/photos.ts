// 撮った写真を、写真アプリにも保存する(書き込みだけの許可)。
import * as MediaLibrary from 'expo-media-library';

let denied = false;

export async function saveToPhotos(path: string): Promise<boolean> {
  if (denied) return false;
  try {
    let p = await MediaLibrary.getPermissionsAsync(true);
    if (!p.granted) p = await MediaLibrary.requestPermissionsAsync(true);
    if (!p.granted) {
      denied = true;
      return false;
    }
    await MediaLibrary.Asset.create(path.startsWith('file://') ? path : 'file://' + path);
    return true;
  } catch {
    return false;
  }
}

export function resetPhotosDenied(): void {
  denied = false;
}
