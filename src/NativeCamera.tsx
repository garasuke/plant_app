// ネイティブ撮影画面(写真 / ピント合成用の連写)。
// 結果は親(App)を通して WebView 内のページへ渡され、ページ側が従来どおり保存する。
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Image, Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import {
  Camera,
  type CameraRef,
  useCameraDevice,
  useCameraPermission,
  usePhotoOutput,
} from 'react-native-vision-camera';

export type CamMode = 'photo' | 'burst';
export type CamRequest = { id: string; title: string; modes: CamMode[]; mode: CamMode; keepOpen: boolean; hasWeb: boolean };
export type Taken = { path: string };
export type Msg = { text: string; error?: boolean };

type LensKey = 'wide' | 'ultra' | 'tele';
const LENSES: { key: LensKey; label: string; type: 'wide-angle' | 'ultra-wide-angle' | 'telephoto' }[] = [
  { key: 'wide', label: '標準', type: 'wide-angle' },
  { key: 'ultra', label: '超広角', type: 'ultra-wide-angle' },
  { key: 'tele', label: '望遠', type: 'telephoto' },
];
type Frame = { path: string; target: number; actual: number };

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const RANGES: [number, number][] = [[0.2, 0.8], [0.0, 1.0], [0.0, 0.5], [0.5, 1.0]];

function positions(n: number, from: number, to: number): number[] {
  if (n <= 1) return [from];
  return Array.from({ length: n }, (_, i) => Math.round((from + ((to - from) * i) / (n - 1)) * 100) / 100);
}

type Props = {
  req: CamRequest;
  message: Msg;
  sending: boolean;
  savedTick: number;
  onSend: (kind: CamMode, files: Taken[]) => void;
  onClose: () => void;
  onUseWeb: (mode: 'video' | 'qr') => void;
};

export default function NativeCamera({ req, message, sending, savedTick, onSend, onClose, onUseWeb }: Props) {
  const { hasPermission, requestPermission } = useCameraPermission();
  const [mode, setMode] = useState<CamMode>(req.mode);
  const [lens, setLens] = useState<LensKey>('wide');
  const [steps, setSteps] = useState(5);
  const [range, setRange] = useState<[number, number]>([0.2, 0.8]);
  const [busy, setBusy] = useState(false);
  const [local, setLocal] = useState('');
  const [frames, setFrames] = useState<Frame[]>([]);
  const camRef = useRef<CameraRef>(null);

  const lensType = LENSES.find((l) => l.key === lens)!.type;
  const device = useCameraDevice('back', { physicalDevices: [lensType] });
  const photoOutput = usePhotoOutput({ qualityPrioritization: 'quality', containerFormat: 'jpeg', quality: 0.9 });
  const pos = useMemo(() => positions(steps, range[0], range[1]), [steps, range]);

  // 保存できたら連写の一覧を空にする
  useEffect(() => {
    if (savedTick > 0) setFrames([]);
  }, [savedTick]);

  const physTypes = device ? device.physicalDevices.map((d) => d.type) : [];
  const lensMatches = !!device && physTypes.includes(lensType);

  const shootPhoto = useCallback(async () => {
    if (!device) return;
    setBusy(true);
    setLocal('');
    try {
      const pf = await photoOutput.capturePhotoToFile({}, {});
      onSend('photo', [{ path: pf.filePath }]);
    } catch (e) {
      setLocal('撮影に失敗: ' + (e instanceof Error ? e.message : String(e)));
    } finally {
      setBusy(false);
    }
  }, [device, photoOutput, onSend]);

  const shootBurst = useCallback(async () => {
    const c = camRef.current?.controller;
    if (!c || !device) {
      setLocal('カメラの準備中です。');
      return;
    }
    if (!device.supportsFocusLocking) {
      setLocal('このレンズはレンズ位置の固定に対応していません。別のレンズを選んでください。');
      return;
    }
    setBusy(true);
    setFrames([]);
    try {
      const out: Frame[] = [];
      for (let i = 0; i < pos.length; i++) {
        setLocal(`ピントを動かして撮影中 ${i + 1} / ${pos.length}`);
        await c.setFocusLocked(pos[i]);
        await sleep(450);
        const actual = c.lensPosition;
        const pf = await photoOutput.capturePhotoToFile({}, {});
        out.push({ path: pf.filePath, target: pos[i], actual });
      }
      setFrames(out);
      setLocal(`${out.length}枚撮れました。よければ「ピント合成して保存」を押してください。`);
    } catch (e) {
      setLocal('連写に失敗: ' + (e instanceof Error ? e.message : String(e)));
    } finally {
      try {
        await c.resetFocus();
      } catch {
        // 無視
      }
      setBusy(false);
    }
  }, [device, photoOutput, pos]);

  const disabled = busy || sending;

  return (
    <Modal visible animationType="slide" presentationStyle="fullScreen" onRequestClose={onClose}>
      <SafeAreaProvider>
        <SafeAreaView style={s.root}>
          <View style={s.top}>
            <Text style={s.title}>{req.title}</Text>
            <Pressable onPress={onClose} style={s.closeBtn}>
              <Text style={s.closeT}>閉じる</Text>
            </Pressable>
          </View>

          {!hasPermission ? (
            <View style={s.center}>
              <Text style={s.w}>カメラの許可が必要です</Text>
              <Btn label="許可する" onPress={() => requestPermission()} />
            </View>
          ) : (
            <>
              <View style={s.preview}>
                {device ? (
                  <Camera ref={camRef} style={StyleSheet.absoluteFill} device={device} isActive outputs={[photoOutput]} />
                ) : (
                  <View style={s.center}>
                    <Text style={s.w}>このレンズは使えません</Text>
                  </View>
                )}
              </View>
              <Text style={s.diag}>
                使用中: {device ? device.localizedName : '-'}({physTypes.join(' / ') || '-'}){'\n'}
                {device && !lensMatches ? '※選んだレンズが無いため、別のレンズを使っています。' : ''}
                {device ? (device.supportsFocusLocking ? '' : '※このレンズはピント位置の固定に非対応') : ''}
              </Text>

              <ScrollView style={s.panel} contentContainerStyle={{ padding: 12, gap: 10 }}>
                {req.modes.length > 1 && (
                  <View style={s.row}>
                    {req.modes.map((m) => (
                      <Chip key={m} label={m === 'photo' ? '写真' : 'ピント合成'} on={mode === m} onPress={() => !disabled && setMode(m)} />
                    ))}
                  </View>
                )}
                <Text style={s.label}>レンズ</Text>
                <View style={s.row}>
                  {LENSES.map((l) => (
                    <Chip key={l.key} label={l.label} on={lens === l.key} onPress={() => !disabled && setLens(l.key)} />
                  ))}
                </View>

                {mode === 'burst' && (
                  <>
                    <Text style={s.label}>枚数 / ピントの範囲(0=近い 1=遠い)</Text>
                    <View style={s.row}>
                      {[3, 5, 7, 9].map((n) => (
                        <Chip key={n} label={`${n}枚`} on={steps === n} onPress={() => !disabled && setSteps(n)} />
                      ))}
                    </View>
                    <View style={s.row}>
                      {RANGES.map((r) => (
                        <Chip
                          key={r.join('-')}
                          label={`${r[0]}〜${r[1]}`}
                          on={range[0] === r[0] && range[1] === r[1]}
                          onPress={() => !disabled && setRange(r)}
                        />
                      ))}
                    </View>
                    <Text style={s.hint}>撮る位置: {pos.join(' → ')}</Text>
                  </>
                )}

                {mode === 'photo' ? (
                  <Btn label={disabled ? '処理中…' : '撮影して保存'} onPress={shootPhoto} disabled={disabled} />
                ) : (
                  <>
                    <Btn label={busy ? '撮影中…' : `ピントをずらして ${steps}枚 撮る`} onPress={shootBurst} disabled={disabled} />
                    {frames.length > 0 && (
                      <>
                        <View style={s.row}>
                          {frames.map((f, i) => (
                            <View key={f.path} style={s.thumbBox}>
                              <Image source={{ uri: 'file://' + f.path }} style={s.thumb} />
                              <Text style={s.cap}>
                                {i + 1}: 指定{f.target}/実測{f.actual.toFixed(2)}
                              </Text>
                            </View>
                          ))}
                        </View>
                        <Btn label="ピント合成して保存" onPress={() => onSend('burst', frames.map((f) => ({ path: f.path })))} disabled={disabled} />
                      </>
                    )}
                  </>
                )}

                {(busy || sending) && <ActivityIndicator />}
                {!!local && <Text style={s.msg}>{local}</Text>}
                {!!message.text && <Text style={[s.msg, message.error && { color: '#b00020' }]}>{message.text}</Text>}

                {req.hasWeb && (
                  <View style={s.row}>
                    <Chip label="動画(Web版カメラ)" on={false} onPress={() => !disabled && onUseWeb('video')} />
                    <Chip label="QR(Web版カメラ)" on={false} onPress={() => !disabled && onUseWeb('qr')} />
                  </View>
                )}
              </ScrollView>
            </>
          )}
        </SafeAreaView>
      </SafeAreaProvider>
    </Modal>
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
  top: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: 10 },
  title: { color: '#fff', fontWeight: '700', fontSize: 16, flex: 1 },
  closeBtn: { paddingVertical: 6, paddingHorizontal: 12, borderRadius: 14, backgroundColor: '#333' },
  closeT: { color: '#fff' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12 },
  preview: { height: '34%', backgroundColor: '#000' },
  diag: { color: '#9fd', fontSize: 11, paddingHorizontal: 10, paddingVertical: 4 },
  panel: { flex: 1, backgroundColor: '#f4f6f4' },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  label: { fontWeight: '700', color: '#233' },
  hint: { color: '#455', fontSize: 12 },
  msg: { color: '#124', fontSize: 13 },
  w: { color: '#fff' },
  btn: { backgroundColor: '#2e7d32', padding: 14, borderRadius: 10, alignItems: 'center' },
  btnT: { color: '#fff', fontWeight: '700', fontSize: 15 },
  chip: { paddingVertical: 8, paddingHorizontal: 12, borderRadius: 18, borderWidth: 1, borderColor: '#2e7d32', backgroundColor: '#fff' },
  chipOn: { backgroundColor: '#2e7d32' },
  chipT: { color: '#2e7d32', fontWeight: '600' },
  thumbBox: { width: '23%' },
  thumb: { width: '100%', aspectRatio: 3 / 4, borderRadius: 6, backgroundColor: '#ddd' },
  cap: { fontSize: 9, color: '#344' },
});
