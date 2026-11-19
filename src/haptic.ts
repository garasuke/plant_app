// 撮影の合図の振動(設定でオフにできる)。失敗しても何もしない。
import * as Haptics from 'expo-haptics';

export const tap = () => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
export const done = () => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
export const fail = () => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(() => {});
