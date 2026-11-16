import { File, Paths } from 'expo-file-system';

export const DEFAULT_URL = 'https://192.168.0.143:8001';

export type Settings = {
  url: string;
  geo: boolean; // 撮影場所を記録する
  notify: boolean; // 予定・期限の通知
  notifyHour: number; // 通知する時刻(時)
  notifyDays: number; // 何日先まで通知するか
};

export const DEFAULT_SETTINGS: Settings = { url: DEFAULT_URL, geo: true, notify: false, notifyHour: 8, notifyDays: 14 };

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
