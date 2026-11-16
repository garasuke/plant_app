// ネイティブ撮影画面: 写真 / ピント合成(写真または動画から)/ QR読み取り。
// ・レンズは倍率(0.5x・1x・2x・望遠)で切り替える
// ・ピント範囲は「近い所」「遠い所」をタップして自動で決められる
// ・三脚モード(セルフタイマー+ピント移動後の待ち時間を長く)
// ・順番待ち(圏外用)として使うときは、結果を端末内へ貯める(親が処理)
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Image, Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { getThumbnailAsync } from 'expo-video-thumbnails';
import {
  Camera,
  CommonResolutions,
  type CameraRef,
  useCameraDevices,
  useCameraPermission,
  useObjectOutput,
  usePhotoOutput,
  useVideoOutput,
} from 'react-native-vision-camera';

export type CamMode = 'photo' | 'burst' | 'qr';
export type CamRequest = {
  id: string;
  title: string;
  modes: CamMode[];
  mode: CamMode;
  keepOpen: boolean;
  hasWeb: boolean;
  queue?: boolean; // 圏外用(端末内に貯める)
};
export type Taken = { path: string };
export type Msg = { text: string; error?: boolean };
export type SendMeta = { name?: string; qr?: string };

type Frame = { path: string; label: string };

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
const r2 = (v: number) => Math.round(v * 100) / 100;
const fmtZ = (x: number) => `${Math.round(x * 10) / 10}x`;

function positions(n: number, from: number, to: number): number[] {
  if (n <= 1) return [r2(from)];
  return Array.from({ length: n }, (_, i) => r2(from + ((to - from) * i) / (n - 1)));
}

type Props = {
  req: CamRequest;
  message: Msg;
  sending: boolean;
  savedTick: number;
  target: string;
  forceMode: { mode: CamMode; tick: number } | null;
  titleText: string;
  geoText: string;
  onSend: (kind: 'photo' | 'burst', files: Taken[], meta: SendMeta) => void;
  onQR: (text: string) => void;
  onClose: () => void;
  onUseWeb: () => void;
};

export default function NativeCamera({
  req,
  message,
  sending,
  savedTick,
  target,
  forceMode,
  titleText,
  geoText,
  onSend,
  onQR,
  onClose,
  onUseWeb,
}: Props) {
  const { hasPermission, requestPermission } = useCameraPermission();
  const [mode, setMode] = useState<CamMode>(req.mode);
  const [method, setMethod] = useState<'photo' | 'video'>('photo');
  const [steps, setSteps] = useState(5);
  const [vframes, setVframes] = useState(12);
  const [range, setRange] = useState<[number, number]>([0.2, 0.8]);
  const [zoom, setZoom] = useState<number | null>(null);
  const [tripod, setTripod] = useState(false);
  const [timer, setTimer] = useState(0);
  const [pick, setPick] = useState(false);
  const [picks, setPicks] = useState<number[]>([]);
  const [busy, setBusy] = useState(false);
  const [local, setLocal] = useState('');
  const [frames, setFrames] = useState<Frame[]>([]);
  const [qrLast, setQrLast] = useState('');
  const [name, setName] = useState('');
  const camRef = useRef<CameraRef>(null);
  const lastQr = useRef({ v: '', at: 0 });
  const qrHandler = useRef<(v: string) => void>(() => {});

  // 背面カメラを全部調べ、レンズが一番多い(超広角・広角・望遠をまとめた)カメラを標準にする
  const allDevices = useCameraDevices();
  const backs = useMemo(
    () => allDevices.filter((d) => d.position === 'back').sort((a, b) => b.physicalDevices.length - a.physicalDevices.length),
    [allDevices],
  );
  const [devId, setDevId] = useState<string | null>(null);
  // 写真・QR: レンズが一番多いカメラ(0.5x〜望遠をまとめて切り替えられる)。ピント合成: ピント位置の固定に対応しているカメラを優先
  const lockable = backs.filter((d) => d.supportsFocusLocking);
  const autoDev = mode === 'burst' ? (lockable[0] ?? backs[0]) : backs[0];
  const device = backs.find((d) => d.id === devId) ?? autoDev ?? undefined;
  const photoOutput = usePhotoOutput({ qualityPrioritization: 'quality', containerFormat: 'jpeg', quality: 0.9 });
  const videoOutput = useVideoOutput({ targetResolution: CommonResolutions.UHD_16_9, enableAudio: false });
  const objectOutput = useObjectOutput({
    types: ['qr'],
    onObjectsScanned: (objs) => {
      for (const o of objs) {
        const v = (o as unknown as { value?: string }).value;
        if (v) {
          qrHandler.current(v);
          break;
        }
      }
    },
  });

  // 倍率ボタン(0.5x / 1x / 2x / 望遠)
  const lenses = useMemo(() => {
    if (!device) return [] as { label: string; z: number }[];
    const sw = device.zoomLensSwitchFactors ?? [];
    const base = sw.length ? sw[0] : device.minZoom;
    const out: { label: string; z: number }[] = [];
    if (sw.length && device.minZoom < base - 0.01) out.push({ label: fmtZ(device.minZoom / base), z: device.minZoom });
    out.push({ label: '1x', z: base });
    if (base * 2 <= device.maxZoom) out.push({ label: '2x', z: base * 2 });
    for (let i = 1; i < sw.length; i++) if (sw[i] > base * 2.01 && sw[i] <= device.maxZoom) out.push({ label: fmtZ(sw[i] / base), z: sw[i] });
    return out;
  }, [device]);
  const baseZoom = lenses.find((l) => l.label === '1x')?.z ?? device?.minZoom ?? 1;
  const curZoom = zoom ?? baseZoom;

  const pos = useMemo(() => positions(steps, range[0], range[1]), [steps, range]);

  useEffect(() => {
    if (savedTick > 0) {
      setFrames([]);
      if (req.queue) {
        setQrLast('');
        setName('');
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [savedTick]);
  useEffect(() => {
    if (forceMode && req.modes.includes(forceMode.mode)) setMode(forceMode.mode);
  }, [forceMode, req.modes]);

  const disabled = busy || sending;
  const outputs = useMemo(
    () => (mode === 'qr' ? [objectOutput] : mode === 'burst' && method === 'video' ? [videoOutput] : [photoOutput]),
    [mode, method, objectOutput, videoOutput, photoOutput],
  );

  // QR: 同じ文字は2.5秒間は無視。順番待ち用は自分で持ち、通常は親(ページ)へ渡す
  qrHandler.current = (v: string) => {
    const now = Date.now();
    if (lastQr.current.v === v && now - lastQr.current.at < 2500) return;
    lastQr.current = { v, at: now };
    setQrLast(v);
    if (req.queue) {
      setMode('photo');
      setLocal('QRを読み取りました。撮影すると、このQRの記録に紐づけて送ります。');
    } else {
      onQR(v);
    }
  };

  const countdown = useCallback(async () => {
    const sec = timer;
    for (let i = sec; i > 0; i--) {
      setLocal(`${i}秒後に撮影します…`);
      await sleep(1000);
    }
  }, [timer]);

  const settle = tripod ? 900 : 450;
  const meta: SendMeta = { name: name.trim() || undefined, qr: qrLast || undefined };

  const shootPhoto = useCallback(async () => {
    if (!device) return;
    setBusy(true);
    setLocal('');
    try {
      await countdown();
      const pf = await photoOutput.capturePhotoToFile({}, {});
      onSend('photo', [{ path: pf.filePath }], meta);
    } catch (e) {
      setLocal('撮影に失敗: ' + (e instanceof Error ? e.message : String(e)));
    } finally {
      setBusy(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [device, photoOutput, onSend, countdown, name, qrLast]);

  const shootBurst = useCallback(async () => {
    const c = camRef.current?.controller;
    if (!c || !device) {
      setLocal('カメラの準備中です。');
      return;
    }
    if (!device.supportsFocusLocking) {
      setLocal('このカメラはレンズ位置の固定に対応していません。');
      return;
    }
    setBusy(true);
    setFrames([]);
    try {
      await countdown();
      const out: Frame[] = [];
      for (let i = 0; i < pos.length; i++) {
        setLocal(`ピントを動かして撮影中 ${i + 1} / ${pos.length}`);
        await c.setFocusLocked(pos[i]);
        await sleep(settle);
        const pf = await photoOutput.capturePhotoToFile({}, {});
        out.push({ path: pf.filePath, label: `${i + 1}: ${pos[i]}` });
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
  }, [device, photoOutput, pos, countdown, settle]);

  // 動画で撮りながらピントを動かし、あとでコマを取り出す(実験)
  const shootVideo = useCallback(async () => {
    const c = camRef.current?.controller;
    if (!c || !device) {
      setLocal('カメラの準備中です。');
      return;
    }
    if (!device.supportsFocusLocking) {
      setLocal('このカメラはレンズ位置の固定に対応していません。');
      return;
    }
    setBusy(true);
    setFrames([]);
    try {
      await countdown();
      const rec = await videoOutput.createRecorder({});
      let resolveFile!: (p: string) => void;
      let rejectFile!: (e: Error) => void;
      const fileP = new Promise<string>((res, rej) => {
        resolveFile = res;
        rejectFile = rej;
      });
      await rec.startRecording(
        (fp) => resolveFile(fp),
        (e) => rejectFile(e),
      );
      const t0 = Date.now();
      setLocal('動画を撮りながらピントを動かしています…');
      const n = 24;
      const sweep = positions(n, range[0], range[1]);
      for (let i = 0; i < n; i++) {
        await c.setFocusLocked(sweep[i]);
        await sleep(tripod ? 90 : 60);
      }
      const dur = Date.now() - t0;
      await rec.stopRecording();
      const file = await fileP;
      const uri = file.startsWith('file://') ? file : 'file://' + file;
      const out: Frame[] = [];
      const from = 250;
      const to = Math.max(from + 100, dur - 100);
      for (let i = 0; i < vframes; i++) {
        setLocal(`動画からコマを取り出しています ${i + 1} / ${vframes}`);
        const t = Math.round(from + ((to - from) * i) / Math.max(1, vframes - 1));
        const th = await getThumbnailAsync(uri, { time: t, quality: 0.95 });
        out.push({ path: th.uri.replace(/^file:\/\//, ''), label: `${i + 1}: ${t}ms` });
      }
      setFrames(out);
      setLocal(`${out.length}コマ取り出せました(動画 ${(dur / 1000).toFixed(1)}秒)。よければ「ピント合成して保存」を押してください。`);
    } catch (e) {
      setLocal('動画での連続撮影に失敗: ' + (e instanceof Error ? e.message : String(e)));
    } finally {
      try {
        await c.resetFocus();
      } catch {
        // 無視
      }
      setBusy(false);
    }
  }, [device, videoOutput, range, vframes, countdown, tripod]);

  // ピント範囲をタップで決める(近い所 → 遠い所)
  const onPreviewTap = useCallback(
    async (x: number, y: number) => {
      const cam = camRef.current;
      const c = cam?.controller;
      if (!cam || !c || disabled) return;
      try {
        await cam.focusTo({ x, y });
        await sleep(700);
        const lp = r2(c.lensPosition);
        const next = [...picks, lp].slice(-2);
        setPicks(next);
        if (next.length === 2) {
          const lo = Math.min(next[0], next[1]);
          const hi = Math.max(next[0], next[1]);
          setRange([r2(clamp(lo - 0.03, 0, 1)), r2(clamp(hi + 0.03, 0, 1))]);
          setLocal(`ピント範囲を ${r2(clamp(lo - 0.03, 0, 1))}〜${r2(clamp(hi + 0.03, 0, 1))} にしました。`);
          setPick(false);
        } else {
          setLocal(`1点目(位置 ${lp})を記録しました。もう1点(反対側の端)をタップしてください。`);
        }
      } catch (e) {
        setLocal('ピントを合わせられませんでした: ' + (e instanceof Error ? e.message : String(e)));
      }
    },
    [picks, disabled],
  );

  const startPick = () => {
    setPicks([]);
    setPick(true);
    setLocal('手前の端(一番近くで合わせたい所)をタップしてください。次に奥の端をタップします。');
  };

  const mainLabel =
    mode === 'photo'
      ? disabled
        ? '処理中…'
        : req.queue
          ? '撮影して端末に保存'
          : '撮影して保存'
      : '';

  return (
    <Modal visible animationType="slide" presentationStyle="fullScreen" onRequestClose={onClose}>
      <SafeAreaProvider>
        <SafeAreaView style={s.root}>
          <View style={s.top}>
            <Text style={s.title} numberOfLines={1}>
              {titleText || req.title}
            </Text>
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
                  <Camera ref={camRef} style={StyleSheet.absoluteFill} device={device} isActive outputs={outputs} zoom={curZoom} />
                ) : (
                  <View style={s.center}>
                    <Text style={s.w}>カメラが見つかりません</Text>
                  </View>
                )}
                {pick && (
                  <Pressable
                    style={StyleSheet.absoluteFill}
                    onPress={(e) => onPreviewTap(e.nativeEvent.locationX, e.nativeEvent.locationY)}
                  >
                    <View style={s.pickHint}>
                      <Text style={s.pickT}>{picks.length === 0 ? '手前の端をタップ' : '奥の端をタップ'}</Text>
                    </View>
                  </Pressable>
                )}
                {mode === 'qr' && (
                  <View style={s.pickHint} pointerEvents="none">
                    <Text style={s.pickT}>QRコードを写してください</Text>
                  </View>
                )}
              </View>
              <Text style={s.diag}>
                {device ? `${device.localizedName} / 倍率 ${fmtZ(curZoom / baseZoom)}` : '-'}
                {device ? ` [レンズ${device.physicalDevices.length} 切替${(device.zoomLensSwitchFactors ?? []).join(',') || 'なし'} ズーム${device.minZoom}〜${device.maxZoom}]` : ''}
                {target ? `  撮影先: ${target}` : ''}
                {qrLast ? `  QR: ${qrLast.slice(0, 40)}` : ''}
                {geoText ? `  ${geoText}` : ''}
              </Text>

              <ScrollView style={s.panel} contentContainerStyle={{ padding: 12, gap: 10 }}>
                {req.modes.length > 1 && (
                  <View style={s.row}>
                    {req.modes.map((m) => (
                      <Chip
                        key={m}
                        label={m === 'photo' ? '写真' : m === 'burst' ? 'ピント合成' : 'QR読み取り'}
                        on={mode === m}
                        onPress={() => !disabled && setMode(m)}
                      />
                    ))}
                  </View>
                )}

                {mode !== 'qr' && (
                  <>
                    <Text style={s.label}>レンズ(倍率)</Text>
                    <View style={s.row}>
                      {lenses.map((l) => (
                        <Chip key={l.label} label={l.label} on={Math.abs(curZoom - l.z) < 0.01} onPress={() => !disabled && setZoom(l.z)} />
                      ))}
                    </View>
                    {backs.length > 1 && (
                      <>
                        <Text style={s.label}>カメラ(◎=ピント合成に対応 ×=非対応。切り替わらないときはここで直接選べます)</Text>
                        <View style={s.row}>
                          {backs.map((d) => (
                            <Chip
                              key={d.id}
                              label={`${d.localizedName.replace('Back ', '')}(${d.physicalDevices.length})${d.supportsFocusLocking ? ' ◎' : ' ×'}`}
                              on={device?.id === d.id}
                              onPress={() => {
                                if (disabled) return;
                                setDevId(d.id);
                                setZoom(null);
                              }}
                            />
                          ))}
                        </View>
                      </>
                    )}
                    <View style={s.row}>
                      <Chip label={tripod ? '三脚モード: オン' : '三脚モード: オフ'} on={tripod} onPress={() => !disabled && setTripod(!tripod)} />
                      {[0, 3, 10].map((t) => (
                        <Chip key={t} label={t === 0 ? 'タイマーなし' : `${t}秒`} on={timer === t} onPress={() => !disabled && setTimer(t)} />
                      ))}
                    </View>
                  </>
                )}

                {req.queue && mode !== 'qr' && (
                  <>
                    <Text style={s.label}>ファイル名(任意)</Text>
                    <TextInput value={name} onChangeText={setName} style={s.input} placeholder="例: ○○の株元" />
                  </>
                )}

                {mode === 'burst' && (
                  <>
                    <Text style={s.label}>撮り方</Text>
                    <View style={s.row}>
                      <Chip label="写真で(高画質)" on={method === 'photo'} onPress={() => !disabled && setMethod('photo')} />
                      <Chip label="動画から(短時間・実験)" on={method === 'video'} onPress={() => !disabled && setMethod('video')} />
                    </View>
                    <Text style={s.label}>ピントの範囲(0=近い 1=遠い): {range[0]}〜{range[1]}</Text>
                    <View style={s.row}>
                      <Chip label="タップで自動指定" on={pick} onPress={() => !disabled && startPick()} />
                      {[[0.2, 0.8], [0, 1], [0, 0.5], [0.5, 1]].map((r) => (
                        <Chip
                          key={r.join('-')}
                          label={`${r[0]}〜${r[1]}`}
                          on={range[0] === r[0] && range[1] === r[1]}
                          onPress={() => !disabled && setRange([r[0], r[1]])}
                        />
                      ))}
                    </View>
                    {method === 'photo' ? (
                      <>
                        <Text style={s.label}>枚数</Text>
                        <View style={s.row}>
                          {[3, 5, 7, 9].map((n) => (
                            <Chip key={n} label={`${n}枚`} on={steps === n} onPress={() => !disabled && setSteps(n)} />
                          ))}
                        </View>
                        <Text style={s.hint}>撮る位置: {pos.join(' → ')}</Text>
                      </>
                    ) : (
                      <>
                        <Text style={s.label}>取り出すコマ数</Text>
                        <View style={s.row}>
                          {[8, 12, 16].map((n) => (
                            <Chip key={n} label={`${n}コマ`} on={vframes === n} onPress={() => !disabled && setVframes(n)} />
                          ))}
                        </View>
                      </>
                    )}
                  </>
                )}

                {mode === 'photo' && <Btn label={mainLabel} onPress={shootPhoto} disabled={disabled || !device} />}
                {mode === 'burst' && (
                  <>
                    <Btn
                      label={busy ? '撮影中…' : method === 'photo' ? `ピントをずらして ${steps}枚 撮る` : '動画で撮ってコマを取り出す'}
                      onPress={method === 'photo' ? shootBurst : shootVideo}
                      disabled={disabled || !device}
                    />
                    {frames.length > 0 && (
                      <>
                        <View style={s.row}>
                          {frames.map((f) => (
                            <View key={f.path} style={s.thumbBox}>
                              <Image source={{ uri: 'file://' + f.path }} style={s.thumb} />
                              <Text style={s.cap}>{f.label}</Text>
                            </View>
                          ))}
                        </View>
                        <Btn
                          label={req.queue ? 'ピント合成用に端末へ保存' : 'ピント合成して保存'}
                          onPress={() => onSend('burst', frames.map((f) => ({ path: f.path })), meta)}
                          disabled={disabled}
                        />
                      </>
                    )}
                  </>
                )}

                {(busy || sending) && <ActivityIndicator />}
                {!!local && <Text style={s.msg}>{local}</Text>}
                {!!message.text && <Text style={[s.msg, message.error && { color: '#b00020' }]}>{message.text}</Text>}

                {req.hasWeb && !req.queue && (
                  <View style={s.row}>
                    <Chip label="動画(Web版カメラ)" on={false} onPress={() => !disabled && onUseWeb()} />
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
  title: { color: '#fff', fontWeight: '700', fontSize: 16, flex: 1, marginRight: 8 },
  closeBtn: { paddingVertical: 6, paddingHorizontal: 12, borderRadius: 14, backgroundColor: '#333' },
  closeT: { color: '#fff' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12 },
  preview: { height: '34%', backgroundColor: '#000' },
  pickHint: { position: 'absolute', left: 0, right: 0, top: 8, alignItems: 'center' },
  pickT: { color: '#fff', backgroundColor: 'rgba(0,0,0,0.6)', paddingHorizontal: 10, paddingVertical: 4, borderRadius: 10, overflow: 'hidden' },
  diag: { color: '#9fd', fontSize: 11, paddingHorizontal: 10, paddingVertical: 4 },
  panel: { flex: 1, backgroundColor: '#f4f6f4' },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  label: { fontWeight: '700', color: '#233' },
  hint: { color: '#455', fontSize: 12 },
  msg: { color: '#124', fontSize: 13 },
  w: { color: '#fff' },
  input: { borderWidth: 1, borderColor: '#9ab', borderRadius: 8, padding: 10, fontSize: 15, backgroundColor: '#fff' },
  btn: { backgroundColor: '#2e7d32', padding: 14, borderRadius: 10, alignItems: 'center' },
  btnT: { color: '#fff', fontWeight: '700', fontSize: 15 },
  chip: { paddingVertical: 8, paddingHorizontal: 12, borderRadius: 18, borderWidth: 1, borderColor: '#2e7d32', backgroundColor: '#fff' },
  chipOn: { backgroundColor: '#2e7d32' },
  chipT: { color: '#2e7d32', fontWeight: '600' },
  thumbBox: { width: '23%' },
  thumb: { width: '100%', aspectRatio: 3 / 4, borderRadius: 6, backgroundColor: '#ddd' },
  cap: { fontSize: 9, color: '#344' },
});
