// 温室に着いたら、今日の作業を通知する(場所の出入りは、iPhone が見張るので、アプリを閉じていても動く)。
// 通知の中身は、アプリを開いたときに保存した「予定の一覧」から作る(圏外・サーバー停止中でも出せる)。
import { File, Paths } from 'expo-file-system';
import * as Location from 'expo-location';
import * as Notifications from 'expo-notifications';
import * as TaskManager from 'expo-task-manager';

export const GF_TASK = 'plant-greenhouse';
const cacheFile = () => new File(Paths.document, 'today_cache.json');
const stampFile = () => new File(Paths.document, 'gf_last.txt');

const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

export function saveTodayCache(items: { title: string; date: string }[]): void {
  try {
    const f = cacheFile();
    if (!f.exists) f.create();
    f.write(JSON.stringify(items.slice(0, 300)));
  } catch {
    // 保存できなくても続ける
  }
}

TaskManager.defineTask(GF_TASK, async ({ data, error }) => {
  if (error) return;
  const ev = (data as { eventType?: Location.GeofencingEventType } | undefined)?.eventType;
  if (ev !== Location.GeofencingEventType.Enter) return;
  try {
    // 3時間以内に出したばかりなら、重ねて出さない
    const sf = stampFile();
    if (sf.exists) {
      const last = Number(await sf.text());
      if (last && Date.now() - last < 3 * 3600 * 1000) return;
    }
    let lines: string[] = [];
    try {
      const cf = cacheFile();
      if (cf.exists) {
        const all = JSON.parse(await cf.text()) as { title: string; date: string }[];
        const today = ymd(new Date());
        lines = all.filter((i) => i.date <= today).map((i) => i.title);
      }
    } catch {
      // 一覧が読めなければ、定型の文にする
    }
    const body = lines.length ? `今日の作業 ${lines.length}件: ` + lines.slice(0, 4).join(' / ') + (lines.length > 4 ? ' ほか' : '') : '温室に着きました。アプリで今日の作業を確認してください。';
    await Notifications.scheduleNotificationAsync({ content: { title: '温室に着きました', body }, trigger: null });
    if (!sf.exists) sf.create();
    sf.write(String(Date.now()));
  } catch {
    // 通知できなくても何もしない
  }
});

export async function startGreenhouse(lat: number, lng: number): Promise<string | null> {
  const fg = await Location.requestForegroundPermissionsAsync();
  if (!fg.granted) return '位置情報の許可が必要です';
  const bg = await Location.requestBackgroundPermissionsAsync();
  if (!bg.granted) return '「常に許可」が必要です(iPhoneの設定 → 植物管理 → 位置情報 → 常に)';
  await Location.startGeofencingAsync(GF_TASK, [{ identifier: 'greenhouse', latitude: lat, longitude: lng, radius: 150, notifyOnEnter: true, notifyOnExit: false }]);
  return null;
}

export async function stopGreenhouse(): Promise<void> {
  try {
    if (await Location.hasStartedGeofencingAsync(GF_TASK)) await Location.stopGeofencingAsync(GF_TASK);
  } catch {
    // 動いていなければ何もしない
  }
}
