// ピント連写テスト(ステップ1: 実現性の確認用)
// 目的: レンズ位置(0.0 近い 〜 1.0 遠い)を段階的に固定しながら連続撮影し、端末内に保存できるかを確かめる。
import { Directory, File, Paths } from 'expo-file-system';
import { Asset } from 'expo-media-library';
import * as MediaLibrary from 'expo-media-library';
import { StatusBar } from 'expo-status-bar';
import React, { useCallback, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Image,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import {
  Camera,
  type CameraRef,
  useCameraDevice,
  useCameraPermission,
  usePhotoOutput,
} from 'react-native-vision-camera';

type LensKey = 'wide' | 'ultra' | 'tele';
const LENSES: { key: LensKey; label: string; type: 'wide-angle' | 'ultra-wide-angle' | 'telephoto' }[] = [
  { key: 'wide', label: '標準(広角)', type: 'wide-angle' },
  { key: 'ultra', label: '超広角(マクロ)', type: 'ultra-wide-angle' },
  { key: 'tele', label: '望遠', type: 'telephoto' },
];

type Shot = { n: number; target: number; actual: number; uri: string; w: number; h: number };

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// 段階数 n のとき、from〜to を等間隔に分けた位置を返す
function makePositions(n: number, from: number, to: number): number[] {
  if (n <= 1) return [from];
  return Array.from({ length: n }, (_, i) => Math.round((from + ((to - from) * i) / (n - 1)) * 100) / 100);
}

export default function App() {
  const { hasPermission, requestPermission } = useCameraPermission();
  const [lens, setLens] = useState<LensKey>('wide');
  const [steps, setSteps] = useState(3);
  const [range, setRange] = useState<[number, number]>([0.2, 0.8]);
  const [settleMs, setSettleMs] = useState(400);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [shots, setShots] = useState<Shot[]>([]);
  const [folder, setFolder] = useState('');
  const camRef = useRef<CameraRef>(null);

  const lensType = LENSES.find((l) => l.key === lens)!.type;
  const device = useCameraDevice('back', { physicalDevices: [lensType] });
  const photoOutput = usePhotoOutput({ qualityPrioritization: 'quality' });
  const positions = useMemo(() => makePositions(steps, range[0], range[1]), [steps, range]);

  const shoot = useCallback(async () => {
    const controller = camRef.current?.controller;
    if (!controller || !device) {
      setMsg('カメラの準備中です。少し待ってからもう一度押してください。');
      return;
    }
    if (!device.supportsFocusLocking) {
      setMsg('このレンズはレンズ位置の固定に対応していません。別のレンズを選んでください。');
      return;
    }
    setBusy(true);
    setShots([]);
    try {
      const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
      const dir = new Directory(Paths.document, 'focus_test', stamp);
      dir.create({ intermediates: true, idempotent: true });
      setFolder(`focus_test/${stamp}`);

      const out: Shot[] = [];
      for (let i = 0; i < positions.length; i++) {
        const target = positions[i];
        setMsg(`${i + 1}/${positions.length} 枚目: レンズ位置 ${target} に合わせています…`);
        await controller.setFocusLocked(target);
        await sleep(settleMs); // レンズが動き終わるのを待つ
        const actual = controller.lensPosition;
        const photo = await photoOutput.capturePhotoToFile({}, {});
        const dest = new File(dir, `shot_${i + 1}_pos${String(target).replace('.', '')}.jpg`);
        new File('file://' + photo.filePath).copy(dest);
        out.push({ n: i + 1, target, actual, uri: dest.uri, w: photo.width, h: photo.height });
        setShots([...out]);
      }
      setMsg(`完了: ${out.length}枚を保存しました(アプリ内 focus_test/${stamp})`);
    } catch (e) {
      setMsg('失敗: ' + (e instanceof Error ? e.message : String(e)));
    } finally {
      try {
        await controller.resetFocus();
      } catch {}
      setBusy(false);
    }
  }, [device, photoOutput, positions, settleMs]);

  const saveToPhotos = useCallback(async () => {
    try {
      const perm = await MediaLibrary.requestPermissionsAsync(true);
      if (!perm.granted) {
        setMsg('写真アプリへの保存が許可されていません。');
        return;
      }
      for (const s of shots) await Asset.create(s.uri);
      setMsg(`${shots.length}枚を写真アプリに保存しました。`);
    } catch (e) {
      setMsg('写真アプリへの保存に失敗: ' + (e instanceof Error ? e.message : String(e)));
    }
  }, [shots]);

  if (!hasPermission) {
    return (
      <SafeAreaView style={s.center}>
        <Text style={s.h}>カメラの許可が必要です</Text>
        <Btn label="許可する" onPress={() => requestPermission()} />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={s.root}>
      <StatusBar style="light" />
      <View style={s.preview}>
        {device ? (
          <Camera ref={camRef} style={StyleSheet.absoluteFill} device={device} isActive outputs={[photoOutput]} />
        ) : (
          <View style={s.center}>
            <Text style={s.w}>このレンズは使えません(機種に無い可能性)</Text>
          </View>
        )}
      </View>
      <ScrollView style={s.panel} contentContainerStyle={{ padding: 12, gap: 10 }}>
        <Text style={s.label}>レンズ</Text>
        <View style={s.row}>
          {LENSES.map((l) => (
            <Chip key={l.key} label={l.label} on={lens === l.key} onPress={() => !busy && setLens(l.key)} />
          ))}
        </View>
        <Text style={s.label}>枚数</Text>
        <View style={s.row}>
          {[3, 5, 7].map((n) => (
            <Chip key={n} label={`${n}枚`} on={steps === n} onPress={() => !busy && setSteps(n)} />
          ))}
        </View>
        <Text style={s.label}>ピントの範囲(0=近い / 1=遠い)</Text>
        <View style={s.row}>
          {([[0.2, 0.8], [0.0, 1.0], [0.0, 0.5], [0.5, 1.0]] as [number, number][]).map((r) => (
            <Chip
              key={r.join('-')}
              label={`${r[0]}〜${r[1]}`}
              on={range[0] === r[0] && range[1] === r[1]}
              onPress={() => !busy && setRange(r)}
            />
          ))}
        </View>
        <Text style={s.label}>レンズ停止待ち</Text>
        <View style={s.row}>
          {[200, 400, 800].map((m) => (
            <Chip key={m} label={`${m}ms`} on={settleMs === m} onPress={() => !busy && setSettleMs(m)} />
          ))}
        </View>
        <Text style={s.hint}>撮影するピント位置: {positions.join(' → ')}</Text>
        <Btn label={busy ? '撮影中…' : `ピントをずらして ${steps}枚 撮影`} onPress={shoot} disabled={busy} />
        {busy && <ActivityIndicator />}
        {!!msg && <Text style={s.msg}>{msg}</Text>}
        {shots.length > 0 && (
          <>
            <View style={s.row}>
              {shots.map((sh) => (
                <View key={sh.n} style={s.thumbBox}>
                  <Image source={{ uri: sh.uri }} style={s.thumb} />
                  <Text style={s.cap}>
                    {sh.n}: 指定{sh.target} / 実測{sh.actual.toFixed(2)}
                  </Text>
                  <Text style={s.cap}>{sh.w}×{sh.h}</Text>
                </View>
              ))}
            </View>
            <Text style={s.hint}>保存先(アプリ内): {folder}。「ファイル」アプリ → このiPhone内 → このアプリ からも開けます。</Text>
            <Btn label="写真アプリにも保存(拡大して確認用)" onPress={saveToPhotos} />
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

function Btn({ label, onPress, disabled }: { label: string; onPress: () => void; disabled?: boolean }) {
  return (
    <Pressable onPress={onPress} disabled={disabled} style={[s.btn, disabled && { opacity: 0.5 }]}>
      <Text style={s.btnT}>{label}</Text>
    </Pressable>
  );
}
function Chip({ label, on, onPress }: { label: string; on: boolean; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} style={[s.chip, on && s.chipOn]}>
      <Text style={[s.chipT, on && { color: '#fff' }]}>{label}</Text>
    </Pressable>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#111' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12, backgroundColor: '#111' },
  preview: { height: '38%', backgroundColor: '#000' },
  panel: { flex: 1, backgroundColor: '#f4f6f4' },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  label: { fontWeight: '700', color: '#233' },
  hint: { color: '#455', fontSize: 12 },
  msg: { color: '#124', fontSize: 13 },
  h: { color: '#fff', fontSize: 18 },
  w: { color: '#fff' },
  btn: { backgroundColor: '#2e7d32', padding: 14, borderRadius: 10, alignItems: 'center' },
  btnT: { color: '#fff', fontWeight: '700', fontSize: 15 },
  chip: { paddingVertical: 8, paddingHorizontal: 12, borderRadius: 18, borderWidth: 1, borderColor: '#2e7d32', backgroundColor: '#fff' },
  chipOn: { backgroundColor: '#2e7d32' },
  chipT: { color: '#2e7d32', fontWeight: '600' },
  thumbBox: { width: '31%' },
  thumb: { width: '100%', aspectRatio: 3 / 4, borderRadius: 6, backgroundColor: '#ddd' },
  cap: { fontSize: 10, color: '#344' },
});
