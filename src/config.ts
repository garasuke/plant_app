import { File, Paths } from 'expo-file-system';

export const DEFAULT_URL = 'https://192.168.0.143:8001';

export type Settings = {
  url: string;
  geo: boolean; // 撮影場所を記録する
  notify: boolean; // 予定・期限の通知
  notifyHour: number; // 通知する時刻(時)
  notifyDays: number; // 何日先まで通知するか
  sendSize: 'orig' | '2048' | '1280'; // 送る写真の大きさ(長辺。orig=そのまま)
  savePhotos: boolean; // 撮った写真を、写真アプリにも保存する
  review: boolean; // 撮ったあと、送る前に確認する(1枚撮影のとき)
  grid: boolean; // 撮影画面にグリッド線と水準器を出す
  faceLock: boolean; // アプリを開くとき Face ID(または passcode)で確認する
  expiryNotify: boolean; // 署名の期限の前日に通知する
  keyShutter: boolean; // 外部キーボードのスペース / Enter で撮影する
  lockExposure: boolean; // ピント合成の撮影中、明るさ・色を固定する
  haptics: boolean; // 撮影の合図で短く振動する
  shotWatch: boolean; // iPhone のスクリーンショットを撮ったとき、取り込むか尋ねる
  gfOn: boolean; // 温室に着いたとき通知する
  gfLat: number | null; // 温室の場所
  gfLng: number | null;
};

export const DEFAULT_SETTINGS: Settings = {
  url: DEFAULT_URL,
  geo: true,
  notify: false,
  notifyHour: 8,
  notifyDays: 14,
  sendSize: 'orig',
  savePhotos: false,
  review: false,
  grid: false,
  faceLock: false,
  expiryNotify: true,
  keyShutter: false,
  lockExposure: true,
  haptics: true,
  shotWatch: true,
  gfOn: false,
  gfLat: null,
  gfLng: null,
};

const cfgFile = () => new File(Paths.document, 'client_config.json');

export async function loadSettings(): Promise<Settings> {
  try {
    const f = cfgFile();
    if (f.exists) {
      const j = JSON.parse(await f.text());
      const s = { ...DEFAULT_SETTINGS };
      if (j && typeof j.url === 'string' && j.url.startsWith('http')) s.url = j.url;
      if (typeof j.geo === 'boolean') s.geo = j.geo;
      if (typeof j.notify === 'boolean') s.notify = j.notify;
      if (typeof j.notifyHour === 'number') s.notifyHour = Math.max(0, Math.min(23, Math.round(j.notifyHour)));
      if (typeof j.notifyDays === 'number') s.notifyDays = Math.max(1, Math.min(60, Math.round(j.notifyDays)));
      if (j.sendSize === 'orig' || j.sendSize === '2048' || j.sendSize === '1280') s.sendSize = j.sendSize;
      for (const k of ['savePhotos', 'review', 'grid', 'faceLock', 'expiryNotify', 'keyShutter', 'lockExposure', 'haptics', 'shotWatch', 'gfOn'] as const) if (typeof j[k] === 'boolean') s[k] = j[k];
      if (typeof j.gfLat === 'number' && typeof j.gfLng === 'number') {
        s.gfLat = j.gfLat;
        s.gfLng = j.gfLng;
      }
      return s;
    }
  } catch {
    // 読めなければ既定値
  }
  return { ...DEFAULT_SETTINGS };
}

export function saveSettings(s: Settings): void {
  const f = cfgFile();
  if (!f.exists) f.create();
  f.write(JSON.stringify(s));
}
