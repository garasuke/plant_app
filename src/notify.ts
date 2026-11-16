// 予定・期限の通知(端末内で予約する通知)。
// システムの notify_api.php の一覧を取り、日付ごとに「設定した時刻」に1回ずつ通知を予約する。
// 予約はアプリを開いたとき(または前面に戻ったとき)に作り直す。圏外のあいだは、前回の予約がそのまま鳴る。
import * as Notifications from 'expo-notifications';

export type NotifyItem = { title: string; date: string; level?: string; kind_label?: string; sub?: string };

Notifications.setNotificationHandler({
  handleNotification: async () => ({ shouldShowBanner: true, shouldShowList: true, shouldPlaySound: false, shouldSetBadge: false }),
});

export async function ensureNotifyPermission(): Promise<boolean> {
  const cur = await Notifications.getPermissionsAsync();
  if (cur.granted) return true;
  const r = await Notifications.requestPermissionsAsync();
  return r.granted;
}

const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

export async function scheduleFromItems(items: NotifyItem[], hour: number, days: number): Promise<number> {
  await Notifications.cancelAllScheduledNotificationsAsync();
  const now = new Date();
  const today = ymd(now);
  const groups = new Map<string, NotifyItem[]>();
  for (const it of items) {
    if (!it.date) continue;
    // 期限が過ぎているもの・今日のものは、次に来る通知の時刻にまとめる
    let key = it.date;
    if (key <= today) {
      const t = new Date(now);
      if (now.getHours() >= hour) t.setDate(t.getDate() + 1);
      key = ymd(t);
    }
    const end = new Date(now);
    end.setDate(end.getDate() + days + 1);
    if (key > ymd(end)) continue;
    const a = groups.get(key) ?? [];
    a.push(it);
    groups.set(key, a);
  }
  const keys = [...groups.keys()].sort().slice(0, 60);
  let n = 0;
  for (const k of keys) {
    const list = groups.get(k)!;
    const [y, m, d] = k.split('-').map((v) => parseInt(v, 10));
    const at = new Date(y, m - 1, d, hour, 0, 0);
    if (at.getTime() <= Date.now() + 5000) continue;
    const head = list
      .slice(0, 3)
      .map((i) => i.title)
      .join('、');
    await Notifications.scheduleNotificationAsync({
      content: { title: `植物管理: ${list.length}件のお知らせ`, body: head + (list.length > 3 ? ` ほか${list.length - 3}件` : '') },
      trigger: { type: Notifications.SchedulableTriggerInputTypes.DATE, date: at },
    });
    n++;
  }
  return n;
}

export async function cancelAllNotify(): Promise<void> {
  await Notifications.cancelAllScheduledNotificationsAsync();
}
