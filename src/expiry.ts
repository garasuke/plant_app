// 無料の Apple ID で入れたアプリは、署名から7日で動かなくなる。
// アプリの中に入っている署名情報(embedded.mobileprovision)から、期限の日時を読む。
// 読めなかったときは null(画面には「不明」と出す)。
import { File, Paths } from 'expo-file-system';
import * as Notifications from 'expo-notifications';

export async function readExpiry(): Promise<Date | null> {
  try {
    const f = new File(Paths.bundle, 'embedded.mobileprovision');
    if (!f.exists) return null;
    const b64 = await f.base64();
    const bin = atob(b64);
    // 署名の中に XML の plist がそのまま入っているので、文字として探す
    const m = /<key>ExpirationDate<\/key>\s*<date>([^<]+)<\/date>/.exec(bin);
    if (!m) return null;
    const d = new Date(m[1]);
    return Number.isNaN(d.getTime()) ? null : d;
  } catch {
    return null;
  }
}

export function daysLeft(d: Date, now = Date.now()): number {
  return Math.floor((d.getTime() - now) / 86400000);
}

const ID = 'plant-expiry';

// 期限の前日(の 9 時。過ぎていれば、すぐ後)に通知する。1件だけ予約し、毎回作り直す
export async function scheduleExpiry(d: Date | null, on: boolean): Promise<void> {
  try {
    await Notifications.cancelScheduledNotificationAsync(ID);
  } catch {
    // 無ければ何もしない
  }
  if (!on || !d) return;
  const at = new Date(d.getTime() - 24 * 3600 * 1000);
  at.setHours(9, 0, 0, 0);
  if (at.getTime() <= Date.now() + 60000) return;
  await Notifications.scheduleNotificationAsync({
    identifier: ID,
    content: {
      title: '植物管理アプリの期限が近づいています',
      body: 'あす期限が切れます。パソコンの Sideloadly で入れ直してください(撮影データは残ります)。',
    },
    trigger: { type: Notifications.SchedulableTriggerInputTypes.DATE, date: at },
  });
}

export const EXPIRY_ID = ID;
