// お世話・予定を、iPhone のカレンダー(「植物管理」という専用のカレンダー)へ書き出す。
// 書き出すたびに、専用カレンダーの中身を入れ替えるので、重複しない。
import * as Calendar from 'expo-calendar/legacy';

export async function exportToCalendar(items: { title: string; date: string }[]): Promise<number> {
  const p = await Calendar.requestCalendarPermissionsAsync();
  if (!p.granted) throw new Error('カレンダーの許可が必要です(iPhoneの設定 → 植物管理 → カレンダー)');
  const cals = await Calendar.getCalendarsAsync(Calendar.EntityTypes.EVENT);
  let id = cals.find((c) => c.title === '植物管理' && c.allowsModifications)?.id;
  if (!id) {
    const def = await Calendar.getDefaultCalendarAsync();
    id = await Calendar.createCalendarAsync({
      title: '植物管理',
      color: '#2e7d32',
      entityType: Calendar.EntityTypes.EVENT,
      sourceId: def.source.id,
      source: def.source,
      name: 'plant',
      ownerAccount: 'personal',
      accessLevel: Calendar.CalendarAccessLevel.OWNER,
    });
  }
  const from = new Date();
  from.setHours(0, 0, 0, 0);
  const to = new Date(from.getTime() + 400 * 86400000);
  for (const e of await Calendar.getEventsAsync([id], from, to)) await Calendar.deleteEventAsync(e.id);
  let n = 0;
  for (const it of items) {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(it.date);
    if (!m) continue;
    const start = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    if (start.getTime() < from.getTime()) continue;
    await Calendar.createEventAsync(id, { title: it.title, startDate: start, endDate: new Date(start.getTime() + 86400000), allDay: true, notes: '植物管理アプリから書き出し' });
    n++;
    if (n >= 300) break;
  }
  return n;
}
