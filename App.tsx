// 植物管理(iPhone / iPad クライアント)
// 既存の植物管理システムを WebView で表示し、次の機能をアプリ側で足す。
//  ・カメラ(写真 / ピント合成 / QR)をネイティブ撮影に差し替え
//  ・圏外でも撮れる「クイック撮影」(端末に貯めて、つながったら自動で送信)
//  ・撮影場所の記録 / 予定・期限の通知 / ホーム画面アイコン長押しからの起動
//  ・調べもの画面(iPad は分割表示)と、長押しメニュー(一時メモ・ファイル管理へ保存)
import { Directory, File, Paths } from 'expo-file-system';
import * as DocumentPicker from 'expo-document-picker';
import * as LocalAuthentication from 'expo-local-authentication';
import * as Location from 'expo-location';
import * as QuickActions from 'expo-quick-actions';
import { StatusBar } from 'expo-status-bar';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActionSheetIOS,
  ActivityIndicator,
  Alert,
  AppState,
  Linking,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  Share,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { WebView, type WebViewMessageEvent } from 'react-native-webview';

import { DEFAULT_SETTINGS, DEFAULT_URL, loadSettings, saveSettings, type Settings } from './src/config';
import { BUILD_AT, BUILD_SHA } from './src/buildinfo';
import { daysLeft, readExpiry, scheduleExpiry } from './src/expiry';
import { INJECT_BEFORE } from './src/inject';
import { clearLog, logError, logInfo, readLog, type LogEntry } from './src/log';
import NativeCamera, { type CamMode, type CamRequest, type Msg, type SendMeta, type Taken } from './src/NativeCamera';
import { saveToPhotos } from './src/photos';
import { shrinkIfNeeded } from './src/resize';
import appJson from './app.json';
import { cancelAllNotify, ensureNotifyPermission, hasNotifyPermission, scheduleFromItems, type NotifyItem } from './src/notify';
import { itemFileUri, queueAdd, queueList, queueRemove, queueUpdate, type QItem } from './src/queue';
import ResearchBrowser, { type CtxInfo, type PageInfo } from './src/ResearchBrowser';

type Geo = { lat: number; lng: number; acc: number; at: number };

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const p2 = (n: number) => String(n).padStart(2, '0');
const stampOf = (t: number) => {
  const d = new Date(t);
  return `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}_${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`;
};
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const isPad = (Platform as unknown as { isPad?: boolean }).isPad === true;

export default function App() {
  const { width } = useWindowDimensions();
  const [settings, setSettings] = useState<Settings | null>(null);
  const [draft, setDraft] = useState<Settings>(DEFAULT_SETTINGS);
  const [showSettings, setShowSettings] = useState(false);
  const [loadErr, setLoadErr] = useState('');
  const [webKey, setWebKey] = useState(0);
  const [toastT, setToastT] = useState('');

  const [req, setReq] = useState<CamRequest | null>(null);
  const [camMsg, setCamMsg] = useState<Msg>({ text: '' });
  const [jobCount, setJobCount] = useState(0); // 裏で保存している撮影の数
  const [jobText, setJobText] = useState('');
  const [camTarget, setCamTarget] = useState('');
  const [camTitle, setCamTitle] = useState('');
  const [forceMode, setForceMode] = useState<{ mode: CamMode; tick: number } | null>(null);
  const [geoText, setGeoText] = useState('');

  const [pending, setPending] = useState(0);
  const [syncMsg, setSyncMsg] = useState('');
  const [showQueue, setShowQueue] = useState(false);
  const [queueItems, setQueueItems] = useState<QItem[]>([]);

  const [ready, setReady] = useState(false); // 設定を読み終えた
  const [pendTick, setPendTick] = useState(0);
  const pendingUrl = useRef<string | null>(null); // 開かれたURL(スキーム・ファイル)の処理待ち
  const [splitOn, setSplitOn] = useState(false);
  const [phoneResearch, setPhoneResearch] = useState(false);
  const [rUrl, setRUrl] = useState('');
  const [rTick, setRTick] = useState(0);

  const webRef = useRef<WebView<object>>(null);
  const workRef = useRef<WebView<object>>(null);
  const reqRef = useRef<CamRequest | null>(null);
  reqRef.current = req;
  const settingsRef = useRef<Settings>(DEFAULT_SETTINGS);
  if (settings) settingsRef.current = settings;

  const pend = useRef(new Map<string, { res: (v: any) => void; rej: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>());
  const wseq = useRef(0);
  const workLoaded = useRef(false);
  const workFailed = useRef(false);
  const saveDlRef = useRef<(m: any) => void>(() => {});
  const lastFail = useRef(0);
  const syncing = useRef(false);
  const lastNotify = useRef(0);
  const geoRef = useRef<Geo | null>(null);
  const geoSub = useRef<Location.LocationSubscription | null>(null);
  const wide = width >= 700;

  // 裏で保存する撮影の順番待ち(撮影は止めずに、1件ずつ順に送る)
  type Job = {
    id: string;
    sid: string; // ページ側のカメラ画面の番号
    kind: 'photo' | 'burst';
    paths: string[];
    geo: { lat: number; lng: number; acc: number } | null;
    extra: Record<string, string>; // 保存先(フォルダ・記録)。失敗して「未送信」に残すとき使う
    cid: string;
    blocking: boolean; // 保存したらカメラを閉じる画面(スキャンなど)
    name?: string;
    qr?: string;
  };
  const jobQ = useRef<Job[]>([]);
  const jobRun = useRef<Job | null>(null);
  const jobWait = useRef<{ job: string; done: (r: { ok: boolean; err?: string; unknown?: boolean }) => void } | null>(null);
  const camMeta = useRef<Record<string, string>>({});
  const deferClose = useRef<string | null>(null);
  const photoWarned = useRef(false);
  const jobDone = useRef(0);
  const [lastOk, setLastOk] = useState(0);
  const [expiry, setExpiry] = useState<Date | null>(null);
  const [showDiag, setShowDiag] = useState(false);
  const [diagLog, setDiagLog] = useState<LogEntry[]>([]);
  const [diagNet, setDiagNet] = useState('');
  const [locked, setLocked] = useState(false);
  const bgAt = useRef(0);

  const toast = useCallback((t: string) => {
    setToastT(t);
    setTimeout(() => setToastT((c) => (c === t ? '' : c)), 4000);
  }, []);

  useEffect(() => {
    loadSettings().then((s) => {
      setSettings(s);
      setDraft(s);
      if (s.faceLock) setLocked(true);
      setReady(true);
    });
    readExpiry().then(async (d) => {
      setExpiry(d);
      // 通知の許可がすでにあるときだけ、期限の前日の通知を予約する(許可は設定の「保存して開く」で求める)
      if (await hasNotifyPermission()) scheduleExpiry(d, settingsRef.current.expiryNotify).catch(() => {});
    });
  }, []);

  // ---------- Face ID(または passcode)でアプリを開く ----------
  const unlock = useCallback(async () => {
    try {
      const lv = await LocalAuthentication.getEnrolledLevelAsync();
      if (lv === LocalAuthentication.SecurityLevel.NONE) {
        setLocked(false); // 端末に passcode などがなければ、確認のしようがないので開く
        return;
      }
      const r = await LocalAuthentication.authenticateAsync({ promptMessage: '植物管理を開く', cancelLabel: 'やめる' });
      if (r.success) setLocked(false);
    } catch (e) {
      logError('Face ID の確認でエラー: ' + errMsg(e));
    }
  }, []);
  useEffect(() => {
    if (locked) unlock();
  }, [locked, unlock]);

  const js = useCallback((code: string) => webRef.current?.injectJavaScript(code + ';true;'), []);

  // ---------- 裏方の画面(ログイン済みの権限で、送信や一覧の取得をする) ----------
  const call = useCallback((kind: string, payload: object = {}, ms = 60000) => {
    return new Promise<any>((res, rej) => {
      const id = 'w' + ++wseq.current;
      const timer = setTimeout(() => {
        pend.current.delete(id);
        rej(new Error('時間内に応答がありませんでした'));
      }, ms);
      pend.current.set(id, { res, rej, timer });
      workRef.current?.injectJavaScript(
        `window.__w?window.__w.run(${JSON.stringify(id)},${JSON.stringify(kind)},${JSON.stringify(payload)}):0;true;`,
      );
    });
  }, []);

  const putFile = useCallback(async (key: string, i: number, name: string, mime: string, uri: string) => {
    const b64 = await new File(uri).base64();
    workRef.current?.injectJavaScript(
      `window.__w.put(${JSON.stringify(key)},${i},${JSON.stringify(name)},${JSON.stringify(mime)},${JSON.stringify(b64)});true;`,
    );
  }, []);

  const onWorkMessage = useCallback((ev: WebViewMessageEvent) => {
    try {
      const m = JSON.parse(ev.nativeEvent.data);
      if (m.t !== 'w') return;
      const p = pend.current.get(m.id);
      if (!p) return;
      clearTimeout(p.timer);
      pend.current.delete(m.id);
      if (m.ok) p.res(m.data);
      else p.rej(new Error(m.error || 'うまくいきませんでした'));
    } catch {
      // 無視
    }
  }, []);

  const ensureWorker = useCallback(async (): Promise<boolean> => {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        if (workLoaded.current) {
          const d = await call('ping', {}, 8000);
          if (d && d.csrf && d.cam) {
            setLastOk(Date.now());
            return true;
          }
        }
      } catch {
        // 読み込み直す
      }
      workLoaded.current = false;
      workFailed.current = false;
      workRef.current?.reload();
      for (let i = 0; i < 12 && !workLoaded.current && !workFailed.current; i++) await sleep(1000);
      if (workFailed.current) return false; // つながらない(圏外など)ときは、すぐ諦めて次の機会を待つ
    }
    return false;
  }, [call]);

  // ---------- 順番待ち(圏外で撮ったもの)の送信 ----------
  const refreshPending = useCallback(async () => {
    const l = await queueList();
    setPending(l.length);
    setQueueItems(l);
    return l;
  }, []);

  const syncQueue = useCallback(
    async (manual = false) => {
      if (syncing.current) return;
      if (!manual && Date.now() - lastFail.current < 60000) return;
      syncing.current = true;
      try {
        const all = await refreshPending();
        const items = all.filter((i) => !i.hold); // 手動で確認するもの(hold)は、自動では送らない
        if (!items.length) {
          if (manual) toast('送る分はありません');
          setSyncMsg(all.length ? `未送信 ${all.length}件(確認待ち。「未送信の撮影」から操作してください)` : '');
          return;
        }
        if (manual) setSyncMsg(`未送信 ${items.length}件: 接続を確認しています…`);
        if (!(await ensureWorker())) {
          lastFail.current = Date.now();
          setSyncMsg(`未送信 ${items.length}件(接続待ち。つながると自動で送ります)`);
          if (manual) toast('サーバーに接続できません(VPN・ログインを確認してください)');
          return;
        }
        let ok = 0;
        let ng = 0;
        for (let n = 0; n < items.length; n++) {
          const it = items[n];
          setSyncMsg(`送信中 ${n + 1} / ${items.length}…`);
          try {
            const extra: Record<string, string> = { ...(it.extra || {}), client_id: it.cid || it.id };
            if (it.qr) {
              const d = await call('lookup', { text: it.qr });
              if (d && d.id) {
                extra.table = String(d.table || '');
                extra.target_id = String(d.id);
              }
            }
            if (it.name) extra.name = it.name;
            const base = stampOf(it.at);
            for (let i = 0; i < it.files.length; i++) {
              const nm = it.kind === 'photo' ? `camera_${base}.jpg` : `focus_${base}_${i + 1}.jpg`;
              // 写真は、設定した大きさに縮めて送る(ピント合成の連写は、画質のためそのまま)
              const src = it.kind === 'photo' ? await shrinkIfNeeded(itemFileUri(it, i), settingsRef.current.sendSize) : itemFileUri(it, i);
              await putFile(it.id, i, nm, 'image/jpeg', src.startsWith('file://') ? src : 'file://' + src);
            }
            await call(it.kind === 'photo' ? 'upload' : 'stack', { key: it.id, extra, geo: it.geo }, 240000);
            queueRemove(it.id);
            logInfo(`未送信を送りました(${it.kind === 'photo' ? '写真' : 'ピント合成'})`);
            ok++;
          } catch (e) {
            ng++;
            const m = errMsg(e);
            logError('未送信の送信に失敗: ' + m);
            it.tries += 1;
            it.error = m;
            await queueUpdate(it);
            if (/ログイン|時間内|ネットワーク|network|接続|Failed to fetch|Load failed/i.test(m)) {
              lastFail.current = Date.now();
              break;
            }
          }
        }
        const left = await refreshPending();
        setSyncMsg(left.length ? `未送信 ${left.length}件(あとで自動で再送します)` : '');
        if (!left.length) jobDone.current = 0;
        if (manual || ok) toast(`送信: ${ok}件 完了${ng ? ` / ${ng}件 失敗` : ''}`);
      } finally {
        syncing.current = false;
        refreshPending();
      }
    },
    [call, ensureWorker, putFile, refreshPending, toast],
  );

  // ---------- 通知 ----------
  const refreshNotify = useCallback(
    async (manual = false) => {
      const st = settingsRef.current;
      if (!st.notify) {
        await cancelAllNotify();
        return;
      }
      try {
        if (!(await ensureNotifyPermission())) {
          if (manual) toast('通知が許可されていません(iPhoneの設定で許可してください)');
          return;
        }
        if (!(await ensureWorker())) {
          if (manual) toast('サーバーに接続できないため、通知を更新できません');
          return;
        }
        const d = await call('notify', { days: st.notifyDays });
        const raw: any[] = (d && (d.items || (d.data && d.data.items))) || [];
        const items: NotifyItem[] = raw.map((r) => ({
          title: `${r.kind_label ? r.kind_label + ': ' : ''}${r.title || ''}`,
          date: String(r.date || ''),
          level: r.level,
        }));
        const n = await scheduleFromItems(items, st.notifyHour, st.notifyDays);
        lastNotify.current = Date.now();
        if (manual) toast(`通知を${n}件 予約しました`);
      } catch (e) {
        if (manual) toast('通知を更新できませんでした: ' + errMsg(e));
      }
    },
    [call, ensureWorker, toast],
  );

  // ---------- 撮影場所 ----------
  const startGeo = useCallback(async () => {
    if (!settingsRef.current.geo) {
      setGeoText('');
      return;
    }
    try {
      const p = await Location.requestForegroundPermissionsAsync();
      if (!p.granted) {
        setGeoText('位置情報: 許可なし');
        return;
      }
      setGeoText('位置情報: 取得中…');
      geoSub.current?.remove();
      geoSub.current = await Location.watchPositionAsync(
        { accuracy: Location.Accuracy.Balanced, timeInterval: 4000, distanceInterval: 3 },
        (l) => {
          geoRef.current = { lat: l.coords.latitude, lng: l.coords.longitude, acc: l.coords.accuracy ?? 0, at: Date.now() };
          setGeoText(`位置 ±${Math.round(l.coords.accuracy ?? 0)}m`);
        },
      );
    } catch {
      setGeoText('位置情報: 取得できません');
    }
  }, []);
  const stopGeo = useCallback(() => {
    geoSub.current?.remove();
    geoSub.current = null;
  }, []);
  const getGeo = useCallback(async (): Promise<Geo | null> => {
    if (!settingsRef.current.geo) return null;
    const g = geoRef.current;
    if (g && Date.now() - g.at < 10 * 60 * 1000) return g;
    try {
      const l = await Promise.race([Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced }), sleep(6000).then(() => null)]);
      if (l) {
        geoRef.current = { lat: l.coords.latitude, lng: l.coords.longitude, acc: l.coords.accuracy ?? 0, at: Date.now() };
        return geoRef.current;
      }
    } catch {
      // 位置なしで続ける
    }
    return null;
  }, []);

  // ---------- カメラ ----------
  const openQuick = useCallback(
    (mode: CamMode) => {
      setCamMsg({ text: '' });
      setCamTarget('');
      setCamTitle('');
      setForceMode({ mode, tick: Date.now() });
      setReq({ id: 'quick', title: 'クイック撮影(圏外でも使えます)', modes: ['photo', 'burst', 'qr'], mode, keepOpen: true, hasWeb: false, queue: true });
      startGeo();
    },
    [startGeo],
  );

  const uiJobs = useCallback(() => {
    const n = jobQ.current.length + (jobRun.current ? 1 : 0);
    setJobCount(n);
    setJobText(n > 0 ? `裏で保存中 ${n}件(続けて撮れます)` : '');
  }, []);

  // 保存の待ちがなくなったら、閉じるのを先送りしていたページ側のカメラ画面を片付ける
  const flushDeferredClose = useCallback(() => {
    if (jobRun.current || jobQ.current.length || !deferClose.current) return;
    const id = deferClose.current;
    deferClose.current = null;
    js(`window.__nc&&window.__nc.closed(${JSON.stringify(id)})`);
  }, [js]);

  const closeCam = useCallback(() => {
    const r = reqRef.current;
    setReq(null);
    stopGeo();
    if (r && r.id !== 'quick') {
      if (jobRun.current || jobQ.current.length) deferClose.current = r.id; // 保存が終わってから閉じる
      else js(`window.__nc&&window.__nc.closed(${JSON.stringify(r.id)})`);
    }
    if (r && r.id === 'quick') syncQueue();
  }, [js, stopGeo, syncQueue]);

  const resolveJob = useCallback((job: string | undefined, r: { ok: boolean; err?: string; unknown?: boolean }) => {
    const w = jobWait.current;
    if (!w || (job && w.job !== job)) return;
    jobWait.current = null;
    w.done(r);
  }, []);

  // 1件の送信: 写真を(必要なら縮めて)ページへ渡し、サーバーに受け取られるのを待つ
  const runJob = useCallback(
    async (job: Job): Promise<{ ok: boolean; err?: string; unknown?: boolean }> => {
      const st = settingsRef.current;
      const waiting = new Promise<{ ok: boolean; err?: string; unknown?: boolean }>((res) => {
        const timer = setTimeout(() => {
          if (jobWait.current && jobWait.current.job === job.id) {
            jobWait.current = null;
            res({ ok: false, unknown: true, err: '応答がありませんでした(サーバーには届いている可能性があります)' });
          }
        }, 240000);
        jobWait.current = {
          job: job.id,
          done: (r) => {
            clearTimeout(timer);
            res(r);
          },
        };
      });
      try {
        js(job.geo ? `window.__nc.geo(${JSON.stringify(job.geo)})` : 'window.__nc.geo(null)');
        const base = stampOf(Date.now());
        for (let i = 0; i < job.paths.length; i++) {
          const src = job.kind === 'photo' ? await shrinkIfNeeded(job.paths[i], st.sendSize) : job.paths[i];
          const b64 = await new File(src.startsWith('file://') ? src : 'file://' + src).base64();
          const name = job.kind === 'photo' ? `camera_${base}.jpg` : `focus_${base}_${i + 1}.jpg`;
          js(
            `window.__nc.recv(${JSON.stringify(job.sid)},${JSON.stringify(job.kind)},${i},${job.paths.length},${JSON.stringify(name)},"image/jpeg",${JSON.stringify(b64)},${JSON.stringify(job.id)})`,
          );
        }
      } catch (e) {
        resolveJob(job.id, { ok: false, err: '送信の準備に失敗: ' + errMsg(e) });
      }
      return waiting;
    },
    [js, resolveJob],
  );

  const pumpJobs = useCallback(async () => {
    if (jobRun.current) return;
    const job = jobQ.current.shift();
    if (!job) {
      uiJobs();
      flushDeferredClose();
      return;
    }
    jobRun.current = job;
    uiJobs();
    let res: { ok: boolean; err?: string; unknown?: boolean };
    try {
      res = await runJob(job);
    } catch (e) {
      res = { ok: false, err: errMsg(e) };
    }
    jobRun.current = null;
    if (res.ok) {
      jobDone.current += 1;
      logInfo(`保存しました(${job.kind === 'photo' ? '写真' : 'ピント合成'})`);
      setCamMsg({ text: `保存しました(${jobDone.current}件完了)` });
      if (job.blocking && !reqRef.current?.keepOpen) closeCam();
    } else if (job.blocking) {
      logError('保存できませんでした: ' + (res.err || ''));
      setCamMsg({ text: '保存できませんでした: ' + (res.err || ''), error: true });
    } else {
      // 失敗しても撮ったものは消さない。「未送信」に残し、確認してから送れるようにする
      logError('保存できなかった撮影を未送信に残しました: ' + (res.err || ''));
      try {
        await queueAdd(job.kind, job.paths, {
          name: job.name,
          qr: job.qr,
          geo: job.geo ?? undefined,
          cid: job.cid,
          extra: job.extra,
          hold: true,
          error: res.unknown ? '送れたか分かりません。ファイル管理を確認してから「送る」を押してください(重複に注意)' : res.err || 'うまくいきませんでした',
        });
        await refreshPending();
        setCamMsg({ text: '保存できませんでした。撮った写真は「未送信の撮影」に残してあります。' + (res.err ? '(' + res.err + ')' : ''), error: true });
        toast('保存できなかった撮影を、未送信に残しました');
      } catch (e) {
        setCamMsg({ text: '保存できず、端末にも残せませんでした: ' + errMsg(e), error: true });
      }
    }
    uiJobs();
    pumpJobs();
  }, [closeCam, flushDeferredClose, refreshPending, runJob, toast, uiJobs]);

  const onMessage = useCallback(
    (ev: WebViewMessageEvent) => {
      let m: any;
      try {
        m = JSON.parse(ev.nativeEvent.data);
      } catch {
        return;
      }
      const cur = reqRef.current;
      const metaOf = (x: any): Record<string, string> => {
        const o: Record<string, string> = {};
        if (x && typeof x === 'object') for (const k of Object.keys(x)) if (x[k] !== undefined && x[k] !== null && String(x[k]) !== '') o[k] = String(x[k]);
        return o;
      };
      switch (m.t) {
        case 'open':
          setCamMsg({ text: '' });
          setCamTarget(m.target || '');
          setCamTitle('');
          setForceMode(null);
          camMeta.current = metaOf(m.meta);
          jobDone.current = 0;
          setReq({ id: m.id, title: m.title, modes: m.modes, mode: m.mode, keepOpen: !!m.keepOpen, hasWeb: !!m.hasWeb });
          startGeo();
          break;
        case 'close':
          closeCam();
          break;
        case 'say':
          setCamMsg({ text: String(m.msg || ''), error: !!m.bad });
          break;
        case 'mode':
          if (cur && m.id === cur.id) setForceMode({ mode: m.mode, tick: Date.now() });
          break;
        case 'title':
          if (cur && m.id === cur.id) setCamTitle(String(m.title || ''));
          break;
        case 'target':
          if (cur && m.id === cur.id) {
            setCamTarget(String(m.name || ''));
            camMeta.current = metaOf(m.meta);
          }
          break;
        case 'dlstart':
          toast('ファイルを取得しています…');
          break;
        case 'dl':
          saveDlRef.current(m);
          break;
        case 'dlerr':
          toast('ダウンロードできませんでした: ' + String(m.msg || ''));
          break;
        case 'sent':
          // サーバーが受け取った(ページ側の一覧の再読み込みなどは待たない)
          resolveJob(m.job, m.ok ? { ok: true } : { ok: false, err: String(m.msg || 'サーバーが受け付けませんでした') });
          break;
        case 'saved':
          resolveJob(m.job, { ok: true });
          break;
        case 'error':
          resolveJob(m.job, { ok: false, err: String(m.msg || '') });
          break;
      }
    },
    [closeCam, resolveJob, startGeo, toast],
  );

  // 撮影が終わるたびに呼ばれる。ここでは待たずに順番待ちへ入れ、すぐ次の撮影に戻れるようにする
  const onSend = useCallback(
    (kind: 'photo' | 'burst', files: Taken[], meta: SendMeta) => {
      const r = reqRef.current;
      if (!r) return;
      const paths = files.map((f) => f.path);
      const st = settingsRef.current;
      if (st.savePhotos && kind === 'photo') {
        saveToPhotos(paths[0]).then((ok) => {
          if (!ok && !photoWarned.current) {
            photoWarned.current = true;
            toast('写真アプリに保存できませんでした(iPhoneの設定で、写真への追加を許可してください)');
          }
        });
      }
      if (r.queue) {
        // 圏外用: 端末に貯める(すぐ終わる)
        (async () => {
          try {
            const g = await getGeo();
            await queueAdd(kind, paths, { name: meta.name, qr: meta.qr, geo: g ? { lat: g.lat, lng: g.lng, acc: g.acc } : undefined });
            const l = await refreshPending();
            setCamMsg({ text: `端末に保存しました(未送信 ${l.length}件)。つながると自動で送ります。` });
            syncQueue();
          } catch (e) {
            logError('端末への保存に失敗: ' + errMsg(e));
            setCamMsg({ text: '端末に保存できませんでした: ' + errMsg(e), error: true });
          }
        })();
        return;
      }
      (async () => {
        const g = await getGeo();
        jobQ.current.push({
          id: 'j' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
          sid: r.id,
          kind,
          paths,
          geo: g ? { lat: g.lat, lng: g.lng, acc: g.acc } : null,
          extra: { ...camMeta.current },
          cid: 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
          blocking: !r.keepOpen,
          name: meta.name,
          qr: meta.qr,
        });
        uiJobs();
        pumpJobs();
      })();
    },
    [getGeo, pumpJobs, refreshPending, syncQueue, toast, uiJobs],
  );

  const onQR = useCallback(
    (text: string) => {
      const r = reqRef.current;
      if (r && r.id !== 'quick') js(`window.__nc&&window.__nc.qr(${JSON.stringify(r.id)},${JSON.stringify(text)})`);
    },
    [js],
  );

  const onUseWeb = useCallback(() => {
    const r = reqRef.current;
    setReq(null);
    stopGeo();
    if (r) js(`window.__nc&&window.__nc.useweb(${JSON.stringify(r.id)},"video")`);
  }, [js, stopGeo]);

  // ---------- 調べもの画面の長押しメニュー ----------
  const memoAdd = useCallback(
    async (body: string, title: string, url: string) => {
      try {
        if (!(await ensureWorker())) throw new Error('サーバーに接続できません(ログインを確認してください)');
        await call('memo', { data: { body: body.slice(0, 4000), source_title: title.slice(0, 255), source_url: /^https?:\/\//i.test(url) && url.length <= 2000 ? url : '' } });
        toast('一時メモに追加しました: ' + body.replace(/\s+/g, ' ').slice(0, 40));
      } catch (e) {
        toast('一時メモに追加できませんでした: ' + errMsg(e));
      }
    },
    [call, ensureWorker, toast],
  );

  const saveImage = useCallback(
    async (src: string) => {
      if (!/^https?:\/\//i.test(src)) {
        toast('この画像は保存できません(通常のアドレスの画像のみ)');
        return;
      }
      try {
        if (!(await ensureWorker())) throw new Error('サーバーに接続できません(ログインを確認してください)');
        const m = /\.(jpe?g|png|webp|gif)(\?|#|$)/i.exec(src);
        const ext = m ? m[1].toLowerCase().replace('jpeg', 'jpg') : 'jpg';
        const mime = ext === 'jpg' ? 'image/jpeg' : `image/${ext}`;
        const dir = new Directory(Paths.cache, 'dl');
        dir.create({ intermediates: true, idempotent: true });
        const dest = new File(dir, `dl_${Date.now()}.${ext}`);
        const f = await File.downloadFileAsync(src, dest);
        const key = 'img' + Date.now();
        await putFile(key, 0, `web_${stampOf(Date.now())}.${ext}`, mime, f.uri);
        await call('upload', { key, extra: {} }, 120000);
        try {
          f.delete();
        } catch {
          // 無視
        }
        toast('ファイル管理に保存しました');
      } catch (e) {
        toast('画像を保存できませんでした: ' + errMsg(e));
      }
    },
    [call, ensureWorker, putFile, toast],
  );

  const addLink = useCallback(
    async (kind: 'bookmarks' | 'links', url: string, title: string) => {
      if (!/^https?:\/\//i.test(url)) {
        toast('このページは登録できません(http / https のページのみ)');
        return;
      }
      try {
        if (!(await ensureWorker())) throw new Error('サーバーに接続できません(ログインを確認してください)');
        await call('link', {
          api: kind === 'links' ? 'links_api.php' : 'bookmarks_api.php',
          data: { url, title: title.slice(0, 200), categories: [], note: '' },
        });
        toast(`${kind === 'links' ? 'リンク集' : 'ブックマーク'}に追加しました: ${title || url}`.slice(0, 80));
      } catch (e) {
        toast('登録できませんでした: ' + errMsg(e));
      }
    },
    [call, ensureWorker, toast],
  );

  const openInResearch = useCallback((u: string) => {
    setRUrl(u);
    setRTick((t) => t + 1);
  }, []);

  const sheet = (title: string, opts: { label: string; fn: () => void }[]) => {
    ActionSheetIOS.showActionSheetWithOptions(
      { options: [...opts.map((o) => o.label), 'キャンセル'], cancelButtonIndex: opts.length, title: title.slice(0, 70) },
      (i) => {
        if (i < opts.length) opts[i].fn();
      },
    );
  };

  // リンク・画像の長押し
  const onCtx = useCallback(
    (c: CtxInfo) => {
      const opts: { label: string; fn: () => void }[] = [];
      if (c.src) opts.push({ label: '画像をファイル管理に保存', fn: () => saveImage(c.src) });
      if (c.href) {
        opts.push({ label: 'リンク先を開く', fn: () => openInResearch(c.href) });
        opts.push({ label: 'リンクを一時メモに追加', fn: () => memoAdd(c.href, c.title, c.href) });
        opts.push({ label: 'リンクをブックマークに追加', fn: () => addLink('bookmarks', c.href, c.href) });
        opts.push({ label: 'リンクをリンク集に追加', fn: () => addLink('links', c.href, c.href) });
      }
      if (!opts.length) return;
      sheet(c.href || c.src, opts);
    },
    [addLink, memoAdd, openInResearch, saveImage],
  );

  // 文字を選んだときの、iOS標準メニューに足した項目
  const onSel = useCallback(
    (key: string, text: string, page: PageInfo) => {
      if (key === 'memo') memoAdd(text, page.title, page.url);
      else if (key === 'search') openInResearch('https://www.google.com/search?q=' + encodeURIComponent(text.slice(0, 200)));
      else if (key === 'bm') addLink('bookmarks', page.url, page.title);
    },
    [addLink, memoAdd, openInResearch],
  );

  // 調べもの画面の ★(いま開いているページの登録)
  const onPageMenu = useCallback(
    (pg: PageInfo) => {
      sheet(pg.title || pg.url, [
        { label: 'ブックマークに追加', fn: () => addLink('bookmarks', pg.url, pg.title) },
        { label: 'リンク集に追加', fn: () => addLink('links', pg.url, pg.title) },
        { label: '一時メモに追加', fn: () => memoAdd(pg.title || pg.url, pg.title, pg.url) },
      ]);
    },
    [addLink, memoAdd],
  );

  // ---------- ダウンロード(ページ側で取得 → 端末に保存 → 共有メニュー) ----------
  const startDownload = useCallback(
    (u: string) => js(`window.__nc&&window.__nc.dl(${JSON.stringify(u)},"")`),
    [js],
  );
  const saveDownloaded = useCallback(
    async (m: { name: string; mime: string; url: string; b64: string }) => {
      try {
        const extOf: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'application/pdf': 'pdf', 'text/plain': 'txt', 'video/mp4': 'mp4' };
        let name = (m.name || '').replace(/[\\/:*?"<>|]/g, '_').trim();
        if (!name) name = 'download_' + stampOf(Date.now()) + (extOf[m.mime] ? '.' + extOf[m.mime] : '');
        const bin = atob(m.b64);
        const u8 = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
        const dir = new Directory(Paths.cache, 'dl');
        dir.create({ intermediates: true, idempotent: true });
        const f = new File(dir, name);
        if (f.exists) f.delete();
        f.create();
        f.write(u8);
        toast('取得しました: ' + name);
        await Share.share({ url: f.uri });
      } catch (e) {
        toast('ファイルを保存できませんでした: ' + errMsg(e));
      }
    },
    [toast],
  );
  saveDlRef.current = saveDownloaded;

  // ---------- 起動・復帰 ----------
  useEffect(() => {
    // ホーム画面アイコンの長押しメニュー
    QuickActions.setItems([
      { id: 'quick', title: 'クイック撮影', subtitle: '圏外でも撮れます', icon: 'symbol:camera' },
      { id: 'qr', title: 'QRを読んで撮る', icon: 'symbol:qrcode' },
    ]).catch(() => {});
    const handle = (id?: string) => {
      if (id === 'quick') openQuick('photo');
      else if (id === 'qr') openQuick('qr');
    };
    handle(QuickActions.initial?.id);
    const sub = QuickActions.addListener((a) => handle(a.id));
    return () => sub.remove();
  }, [openQuick]);

  useEffect(() => {
    refreshPending();
    const sub = AppState.addEventListener('change', (st) => {
      if (st === 'background') bgAt.current = Date.now();
      if (st !== 'active') return;
      // 1分以上はなれていたら、もう一度 Face ID を求める
      if (settingsRef.current.faceLock && bgAt.current && Date.now() - bgAt.current > 60000) setLocked(true);
      bgAt.current = 0;
      if (loadErr) webRef.current?.reload();
      syncQueue();
      if (Date.now() - lastNotify.current > 30 * 60 * 1000) refreshNotify();
    });
    const iv = setInterval(() => {
      if (AppState.currentState === 'active') {
        if (loadErr) webRef.current?.reload();
        syncQueue();
      }
    }, 90000);
    return () => {
      sub.remove();
      clearInterval(iv);
    };
  }, [loadErr, refreshNotify, refreshPending, syncQueue]);

  const onWorkLoad = useCallback(() => {
    workLoaded.current = true;
    workFailed.current = false;
    lastFail.current = 0;
    syncQueue();
    if (Date.now() - lastNotify.current > 30 * 60 * 1000) refreshNotify();
  }, [refreshNotify, syncQueue]);

  const applySettings = () => {
    const u = draft.url.trim();
    if (!/^https?:\/\//.test(u)) {
      Alert.alert('アドレスは http:// か https:// から入力してください');
      return;
    }
    const next = { ...draft, url: u };
    saveSettings(next);
    setSettings(next);
    settingsRef.current = next;
    setLoadErr('');
    setWebKey((k) => k + 1);
    setShowSettings(false);
    workLoaded.current = false;
    if (!next.notify) cancelAllNotify();
    else refreshNotify(true);
    // 署名の期限の前日の通知(許可がなければここで求める)
    (async () => {
      if (next.expiryNotify) await ensureNotifyPermission().catch(() => false);
      await scheduleExpiry(expiry, next.expiryNotify).catch(() => {});
    })();
  };

  const openDiag = useCallback(() => {
    setDiagLog(readLog());
    setDiagNet('');
    setShowDiag(true);
  }, []);
  const testNet = useCallback(async () => {
    setDiagNet('確認中…');
    try {
      const ok = await ensureWorker();
      setDiagNet(ok ? 'つながっています(ログイン済み)' : 'つながりません(VPN・ログインを確認してください)');
    } catch (e) {
      setDiagNet('確認できませんでした: ' + errMsg(e));
    }
    setDiagLog(readLog());
  }, [ensureWorker]);

  // 未送信の撮影を、写真アプリへ退避する(アプリを消す前・期限が切れる前の保険)
  const rescueToPhotos = useCallback(
    async (items: QItem[]) => {
      let ok = 0;
      let ng = 0;
      for (const it of items) {
        for (let i = 0; i < it.files.length; i++) {
          if (await saveToPhotos(itemFileUri(it, i))) ok++;
          else ng++;
        }
      }
      toast(ng ? `写真アプリへ ${ok}枚 保存 / ${ng}枚 失敗(写真への追加の許可を確認してください)` : `写真アプリへ ${ok}枚 保存しました`);
    },
    [toast],
  );

  // ---------- ファイルの取り込み(ファイルApp・AirDrop・「このアプリで開く」)→ ファイル管理 ----------
  const importFiles = useCallback(
    async (files: { uri: string; name: string; size?: number }[]) => {
      if (!files.length) return;
      try {
        if (!(await ensureWorker())) throw new Error('サーバーに接続できません(VPN・ログインを確認してください)');
      } catch (e) {
        toast('取り込めませんでした: ' + errMsg(e));
        return;
      }
      let ok = 0;
      const errs: string[] = [];
      for (const f of files) {
        try {
          let size = f.size ?? 0;
          if (!size) {
            try {
              size = new File(f.uri).size ?? 0;
            } catch {
              // 大きさが分からなくても続ける
            }
          }
          if (size > 30 * 1024 * 1024) throw new Error('30MBを超えるファイルは、パソコンから取り込んでください');
          toast(`取り込み中… ${f.name}`);
          const key = 'lib' + Date.now().toString(36) + ok;
          const ext = (f.name.split('.').pop() || '').toLowerCase();
          const mime = ext === 'pdf' ? 'application/pdf' : ext === 'png' ? 'image/png' : ext === 'heic' ? 'image/heic' : ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : 'application/octet-stream';
          await putFile(key, 0, f.name, mime, f.uri);
          await call('libfile', { key, name: f.name }, 300000);
          ok++;
          logInfo('ファイルを取り込みました: ' + f.name);
        } catch (e) {
          errs.push(`${f.name}: ${errMsg(e)}`);
          logError('取り込みに失敗: ' + f.name + ' ' + errMsg(e));
        }
      }
      toast(errs.length ? `取り込み ${ok}件 / 失敗 ${errs.length}件(${errs[0]})`.slice(0, 120) : `ファイル管理へ ${ok}件 取り込みました`);
    },
    [call, ensureWorker, putFile, toast],
  );

  const pickFiles = useCallback(async () => {
    try {
      const r = await DocumentPicker.getDocumentAsync({ multiple: true, copyToCacheDirectory: true, type: '*/*' });
      if (r.canceled) return;
      importFiles(r.assets.map((a) => ({ uri: a.uri, name: a.name, size: a.size ?? undefined })));
    } catch (e) {
      toast('ファイルを選べませんでした: ' + errMsg(e));
    }
  }, [importFiles, toast]);

  // ---------- 他から開かれたとき(ショートカット・Action Button・ファイル)----------
  //   plantapp://quick/photo | quick/burst | quick/qr | research?url=… | settings | diag | import
  const handleUrl = useCallback(
    (raw: string) => {
      if (/^file:/i.test(raw)) {
        let name = 'file';
        try {
          name = decodeURIComponent(raw.split('?')[0].split('/').pop() || 'file');
        } catch {
          // そのまま
        }
        importFiles([{ uri: raw, name }]);
        return;
      }
      const m = /^plantapp:\/\/([^?#]*)(?:\?([^#]*))?/i.exec(raw);
      if (!m) return;
      const path = m[1].replace(/^\/+|\/+$/g, '').toLowerCase();
      const q: Record<string, string> = {};
      (m[2] || '').split('&').forEach((kv) => {
        const i = kv.indexOf('=');
        if (i > 0) {
          try {
            q[kv.slice(0, i)] = decodeURIComponent(kv.slice(i + 1).replace(/\+/g, ' '));
          } catch {
            // 読めない値は無視
          }
        }
      });
      logInfo('URLで開かれました: ' + path);
      switch (path) {
        case 'quick':
        case 'quick/photo':
          openQuick('photo');
          break;
        case 'quick/burst':
          openQuick('burst');
          break;
        case 'quick/qr':
          openQuick('qr');
          break;
        case 'research': {
          if (isPad && wide) setSplitOn(true);
          else setPhoneResearch(true);
          if (/^https?:\/\//i.test(q.url || '')) openInResearch(q.url);
          break;
        }
        case 'settings':
          if (settings) setDraft(settings);
          refreshPending();
          setShowSettings(true);
          break;
        case 'diag':
          openDiag();
          break;
        case 'import':
          pickFiles();
          break;
      }
    },
    [importFiles, isPad, openDiag, openInResearch, openQuick, pickFiles, refreshPending, settings, wide],
  );

  useEffect(() => {
    Linking.getInitialURL().then((u) => {
      if (u) {
        pendingUrl.current = u;
        setPendTick((t) => t + 1);
      }
    });
    const sub = Linking.addEventListener('url', ({ url }) => {
      pendingUrl.current = url;
      setPendTick((t) => t + 1);
    });
    return () => sub.remove();
  }, []);
  useEffect(() => {
    // 設定を読み終え、Face ID の確認が済んでから処理する
    if (!ready || locked || !pendingUrl.current) return;
    const u = pendingUrl.current;
    pendingUrl.current = null;
    handleUrl(u);
  }, [ready, locked, pendTick, handleUrl]);

  if (!settings) {
    return (
      <View style={s.center}>
        <ActivityIndicator />
      </View>
    );
  }
  const url = settings.url;
  const split = isPad && wide && splitOn;
  const base = url.replace(/\/+$/, '');
  const home = base + '/bookmarks.php';
  const linksUrl = base + '/links.php';

  const mainWeb = (
    <WebView<object>
      key={webKey}
      ref={webRef}
      source={{ uri: url }}
      style={s.web}
      originWhitelist={['*']}
      javaScriptEnabled
      domStorageEnabled
      sharedCookiesEnabled
      allowsInlineMediaPlayback
      pullToRefreshEnabled
      mediaCapturePermissionGrantType="grantIfSameHostElsePrompt"
      allowsBackForwardNavigationGestures
      injectedJavaScriptBeforeContentLoaded={INJECT_BEFORE}
      onMessage={onMessage}
      onLoadStart={() => setLoadErr('')}
      onError={(e) => setLoadErr(e.nativeEvent.description || '読み込めませんでした')}
      onHttpError={(e) => setLoadErr(`サーバーの応答エラー (${e.nativeEvent.statusCode})`)}
      onContentProcessDidTerminate={() => webRef.current?.reload()}
      onFileDownload={(e) => startDownload(e.nativeEvent.downloadUrl)}
      onShouldStartLoadWithRequest={(r) => {
        const isDl = /library_file\.php\?[^#]*mode=(download|open)/.test(r.url) || /[?&]dl=1(&|#|$)/.test(r.url) || /attach_file\.php/.test(r.url);
        if (isDl && r.isTopFrame !== false && r.navigationType !== 'backforward') {
          startDownload(r.url);
          return false;
        }
        return true;
      }}
    />
  );

  return (
    <SafeAreaProvider>
      <SafeAreaView style={s.root} edges={['top', 'left', 'right', 'bottom']}>
        <StatusBar style="dark" />
        <View style={s.rowFill}>
          <View style={{ flex: 1 }}>
            {mainWeb}
            {!!expiry && daysLeft(expiry) <= 2 && (
              <View style={s.expiry}>
                <Text style={s.expiryT}>
                  {daysLeft(expiry) < 0
                    ? 'アプリの期限が切れています。パソコンの Sideloadly で入れ直してください。'
                    : `アプリの期限まであと${daysLeft(expiry)}日です。${pending > 0 ? '未送信があるので、先に送るか写真アプリへ退避してください。' : 'Sideloadly で入れ直してください。'}`}
                </Text>
              </View>
            )}
            {!!syncMsg && (
              <Pressable style={s.sync} onPress={() => { refreshPending(); setShowQueue(true); }}>
                <Text style={s.syncT}>{syncMsg}</Text>
              </Pressable>
            )}
            {!!loadErr && (
              <View style={s.err}>
                <Text style={s.errT}>読み込めません: {loadErr}</Text>
                <Text style={s.errH}>
                  ・VPN / 自宅の Wi-Fi につながっていますか{'\n'}
                  ・つながると自動で読み込み直します{'\n'}
                  ・圏外のときも、下の📷で撮影だけはできます(あとで自動送信)
                </Text>
                <Pressable style={s.btn2} onPress={() => webRef.current?.reload()}>
                  <Text style={s.btn2T}>今すぐ読み込み直す</Text>
                </Pressable>
              </View>
            )}
          </View>
          {split && (
            <View style={s.side}>
              <ResearchBrowser home={home} linksUrl={linksUrl} url={rUrl} navTick={rTick} onCtx={onCtx} onSel={onSel} onPageMenu={onPageMenu} />
            </View>
          )}
        </View>

        {/* 下の機能バー(画面の下部バーと重ならないよう、別の行にしてある) */}
        <View style={s.bottomBar}>
          <Pressable style={s.tab} onPress={() => openQuick('photo')}>
            <Text style={s.tabI}>📷</Text>
            <Text style={s.tabT}>クイック撮影</Text>
            {pending > 0 && (
              <View style={s.badge}>
                <Text style={s.badgeT}>{pending}</Text>
              </View>
            )}
          </Pressable>
          <Pressable
            style={s.tab}
            onPress={() => {
              if (isPad && wide) setSplitOn(!splitOn);
              else setPhoneResearch(true);
            }}
          >
            <Text style={s.tabI}>{split ? '✕' : '🔎'}</Text>
            <Text style={s.tabT}>{split ? '調べものを閉じる' : '調べもの'}</Text>
          </Pressable>
          <Pressable
            style={s.tab}
            onPress={() => {
              setDraft(settings);
              refreshPending();
              setShowSettings(true);
            }}
          >
            <Text style={s.tabI}>⚙</Text>
            <Text style={s.tabT}>設定</Text>
          </Pressable>
        </View>
        {!!toastT && (
          <View style={s.toast} pointerEvents="none">
            <Text style={s.toastT}>{toastT}</Text>
          </View>
        )}

        {/* 裏方の画面(見えない)。送信・通知の取得・一時メモへの追加に使う */}
        <View style={s.hidden} pointerEvents="none">
          <WebView<object>
            ref={workRef}
            source={{ uri: url.replace(/\/+$/, '') + '/cam.php' }}
            originWhitelist={['*']}
            javaScriptEnabled
            domStorageEnabled
            sharedCookiesEnabled
            injectedJavaScriptBeforeContentLoaded={INJECT_BEFORE}
            onMessage={onWorkMessage}
            onLoad={onWorkLoad}
            onError={() => {
              workLoaded.current = false;
              workFailed.current = true;
            }}
            onHttpError={() => {
              workLoaded.current = false;
              workFailed.current = true;
            }}
            onContentProcessDidTerminate={() => workRef.current?.reload()}
          />
        </View>

        {req && (
          <NativeCamera
            req={req}
            message={camMsg}
            jobs={jobCount}
            jobText={jobText}
            opts={{ review: settings.review, grid: settings.grid, keyShutter: settings.keyShutter, lockExposure: settings.lockExposure }}
            target={camTarget}
            forceMode={forceMode}
            titleText={camTitle}
            geoText={geoText}
            onSend={onSend}
            onQR={onQR}
            onClose={closeCam}
            onUseWeb={onUseWeb}
          />
        )}

        {/* iPhone: 調べもの画面(全画面) */}
        <Modal visible={phoneResearch} animationType="slide" presentationStyle="fullScreen" onRequestClose={() => setPhoneResearch(false)}>
          <SafeAreaProvider>
            <SafeAreaView style={{ flex: 1 }}>
              <ResearchBrowser home={home} linksUrl={linksUrl} url={rUrl} navTick={rTick} onCtx={onCtx} onSel={onSel} onPageMenu={onPageMenu} onClose={() => setPhoneResearch(false)} />
            </SafeAreaView>
          </SafeAreaProvider>
        </Modal>

        {/* 未送信の一覧 */}
        <Modal visible={showQueue} transparent animationType="fade" onRequestClose={() => setShowQueue(false)}>
          <View style={s.shade}>
            <View style={[s.card, { maxHeight: '80%' }]}>
              <Text style={s.h}>未送信の撮影 {queueItems.length}件</Text>
              <ScrollView>
                {queueItems.length === 0 && <Text>ありません</Text>}
                {queueItems.map((it) => (
                  <View key={it.id} style={s.qrow}>
                    <Text style={{ flex: 1, fontSize: 12 }}>
                      {stampOf(it.at)} {it.kind === 'photo' ? '写真' : `ピント合成 ${it.files.length}枚`}
                      {it.name ? ` 「${it.name}」` : ''}
                      {it.qr ? ' QR付き' : ''}
                      {it.error ? `\n⚠ ${it.error}` : ''}
                      {it.hold ? '\n(自動では送りません)' : ''}
                    </Text>
                    {it.hold && (
                      <Pressable
                        onPress={async () => {
                          it.hold = false;
                          await queueUpdate(it);
                          await refreshPending();
                          syncQueue(true);
                        }}
                      >
                        <Text style={{ color: '#2e7d32' }}>送る</Text>
                      </Pressable>
                    )}
                    <Pressable
                      onPress={() =>
                        Alert.alert('削除しますか', 'この撮影は送信されずに消えます。', [
                          { text: 'やめる', style: 'cancel' },
                          { text: '削除', style: 'destructive', onPress: () => { queueRemove(it.id); refreshPending(); } },
                        ])
                      }
                    >
                      <Text style={{ color: '#b00020' }}>削除</Text>
                    </Pressable>
                  </View>
                ))}
              </ScrollView>
              <Pressable style={s.btn} onPress={() => syncQueue(true)}>
                <Text style={s.btnT}>今すぐ送る</Text>
              </Pressable>
              {queueItems.length > 0 && (
                <Pressable style={s.btn2} onPress={() => rescueToPhotos(queueItems)}>
                  <Text style={s.btn2T}>すべて写真アプリへ退避する</Text>
                </Pressable>
              )}
              <Text style={s.hint}>アプリを削除すると、未送信の撮影は消えます。消す前に、送るか写真アプリへ退避してください。</Text>
              <Pressable style={s.btn2} onPress={() => setShowQueue(false)}>
                <Text style={s.btn2T}>閉じる</Text>
              </Pressable>
            </View>
          </View>
        </Modal>

        {/* 設定 */}
        <Modal visible={showSettings} transparent animationType="fade" onRequestClose={() => setShowSettings(false)}>
          <View style={s.shade}>
            <View style={[s.card, { maxHeight: '90%' }]}>
              <ScrollView contentContainerStyle={{ gap: 10 }}>
                <Text style={s.h}>設定</Text>
                <Text style={s.lbl}>システムのアドレス</Text>
                <TextInput
                  value={draft.url}
                  onChangeText={(v) => setDraft({ ...draft, url: v })}
                  autoCapitalize="none"
                  autoCorrect={false}
                  keyboardType="url"
                  style={s.input}
                  placeholder={DEFAULT_URL}
                />
                <View style={s.sw}>
                  <Text style={s.lbl}>撮影場所を記録する</Text>
                  <Switch value={draft.geo} onValueChange={(v) => setDraft({ ...draft, geo: v })} />
                </View>
                <View style={s.sw}>
                  <Text style={s.lbl}>予定・期限を通知する</Text>
                  <Switch value={draft.notify} onValueChange={(v) => setDraft({ ...draft, notify: v })} />
                </View>
                {draft.notify && (
                  <>
                    <Text style={s.lbl}>通知する時刻</Text>
                    <View style={s.chips}>
                      {[6, 7, 8, 9, 12, 18, 20].map((h) => (
                        <Pressable key={h} style={[s.chip, draft.notifyHour === h && s.chipOn]} onPress={() => setDraft({ ...draft, notifyHour: h })}>
                          <Text style={[s.chipT, draft.notifyHour === h && { color: '#fff' }]}>{h}時</Text>
                        </Pressable>
                      ))}
                    </View>
                    <Text style={s.lbl}>何日先まで</Text>
                    <View style={s.chips}>
                      {[3, 7, 14, 30].map((d) => (
                        <Pressable key={d} style={[s.chip, draft.notifyDays === d && s.chipOn]} onPress={() => setDraft({ ...draft, notifyDays: d })}>
                          <Text style={[s.chipT, draft.notifyDays === d && { color: '#fff' }]}>{d}日</Text>
                        </Pressable>
                      ))}
                    </View>
                    <Text style={s.hint}>通知は、アプリを開いたときに予約し直します。圏外のあいだは前回の予約が鳴ります。</Text>
                  </>
                )}
                <Text style={[s.h, { fontSize: 15, marginTop: 6 }]}>撮影</Text>
                <Text style={s.lbl}>送る写真の大きさ(長辺)</Text>
                <View style={s.chips}>
                  {([['orig', 'そのまま'], ['2048', '2048px'], ['1280', '1280px']] as const).map(([v, t]) => (
                    <Pressable key={v} style={[s.chip, draft.sendSize === v && s.chipOn]} onPress={() => setDraft({ ...draft, sendSize: v })}>
                      <Text style={[s.chipT, draft.sendSize === v && { color: '#fff' }]}>{t}</Text>
                    </Pressable>
                  ))}
                </View>
                <Text style={s.hint}>VPN で遅いときは小さくします。ピント合成の連写は、画質のためそのまま送ります。</Text>
                <View style={s.sw}>
                  <Text style={s.lbl}>撮った写真を写真アプリにも保存</Text>
                  <Switch value={draft.savePhotos} onValueChange={(v) => setDraft({ ...draft, savePhotos: v })} />
                </View>
                <View style={s.sw}>
                  <Text style={s.lbl}>送る前に撮った写真を確認する</Text>
                  <Switch value={draft.review} onValueChange={(v) => setDraft({ ...draft, review: v })} />
                </View>
                <View style={s.sw}>
                  <Text style={s.lbl}>グリッド線と水準器を出す</Text>
                  <Switch value={draft.grid} onValueChange={(v) => setDraft({ ...draft, grid: v })} />
                </View>
                <View style={s.sw}>
                  <Text style={s.lbl}>連写中は明るさ・色を固定する</Text>
                  <Switch value={draft.lockExposure} onValueChange={(v) => setDraft({ ...draft, lockExposure: v })} />
                </View>
                <View style={s.sw}>
                  <Text style={s.lbl}>外部キーボードで撮影(スペース / Enter)</Text>
                  <Switch value={draft.keyShutter} onValueChange={(v) => setDraft({ ...draft, keyShutter: v })} />
                </View>
                {draft.keyShutter && <Text style={s.hint}>画面のキーボードが出てしまうときは、オフにしてください。Bluetooth のリモコンは、音量ボタンでの撮影には対応していません。</Text>}
                <Text style={[s.h, { fontSize: 15, marginTop: 6 }]}>安全</Text>
                <View style={s.sw}>
                  <Text style={s.lbl}>開くときに Face ID で確認する</Text>
                  <Switch value={draft.faceLock} onValueChange={(v) => setDraft({ ...draft, faceLock: v })} />
                </View>
                <View style={s.sw}>
                  <Text style={s.lbl}>アプリの期限の前日に通知する</Text>
                  <Switch value={draft.expiryNotify} onValueChange={(v) => setDraft({ ...draft, expiryNotify: v })} />
                </View>
                <Text style={s.hint}>
                  アプリの期限: {expiry ? `${expiry.getFullYear()}/${expiry.getMonth() + 1}/${expiry.getDate()} ${p2(expiry.getHours())}:${p2(expiry.getMinutes())}(あと${daysLeft(expiry)}日)` : '読み取れませんでした'}
                </Text>
                <Pressable style={s.btn} onPress={applySettings}>
                  <Text style={s.btnT}>保存して開く</Text>
                </Pressable>
                <Pressable
                  style={s.btn2}
                  onPress={() => {
                    setShowSettings(false);
                    pickFiles();
                  }}
                >
                  <Text style={s.btn2T}>ファイルを取り込む(ファイルApp・AirDrop)</Text>
                </Pressable>
                <Pressable
                  style={s.btn2}
                  onPress={() => {
                    setShowSettings(false);
                    openDiag();
                  }}
                >
                  <Text style={s.btn2T}>診断(動作の記録・版・接続)</Text>
                </Pressable>
                <Pressable
                  style={s.btn2}
                  onPress={() => {
                    setShowSettings(false);
                    setShowQueue(true);
                  }}
                >
                  <Text style={s.btn2T}>未送信の撮影({pending}件)を見る</Text>
                </Pressable>
                <Pressable style={s.btn2} onPress={() => refreshNotify(true)}>
                  <Text style={s.btn2T}>通知を今すぐ更新</Text>
                </Pressable>
                <Pressable
                  style={s.btn2}
                  onPress={() => {
                    setLoadErr('');
                    setWebKey((k) => k + 1);
                    setShowSettings(false);
                  }}
                >
                  <Text style={s.btn2T}>再読み込み</Text>
                </Pressable>
                <Pressable style={s.btn2} onPress={() => setShowSettings(false)}>
                  <Text style={s.btn2T}>閉じる</Text>
                </Pressable>
              </ScrollView>
            </View>
          </View>
        </Modal>

        {/* 診断 */}
        <Modal visible={showDiag} transparent animationType="fade" onRequestClose={() => setShowDiag(false)}>
          <View style={s.shade}>
            <View style={[s.card, { maxHeight: '88%' }]}>
              <Text style={s.h}>診断</Text>
              <ScrollView contentContainerStyle={{ gap: 6 }}>
                <Text style={s.diagT}>版: {appJson.expo.version}(ビルド {BUILD_AT} / {BUILD_SHA.slice(0, 7)})</Text>
                <Text style={s.diagT}>端末: {Platform.OS} {String(Platform.Version)} / {isPad ? 'iPad' : 'iPhone'}</Text>
                <Text style={s.diagT}>
                  アプリの期限: {expiry ? `${expiry.toLocaleString()}(あと${daysLeft(expiry)}日)` : '読み取れませんでした'}
                </Text>
                <Text style={s.diagT}>サーバー: {settings.url}</Text>
                <Text style={s.diagT}>最後につながった時刻: {lastOk ? new Date(lastOk).toLocaleTimeString() : 'まだありません'}</Text>
                <Text style={s.diagT}>
                  未送信 {pending}件 / 裏で保存中 {jobCount}件
                </Text>
                {!!diagNet && <Text style={[s.diagT, { fontWeight: '700' }]}>{diagNet}</Text>}
                <Text style={[s.lbl, { marginTop: 8 }]}>動作の記録(新しい順)</Text>
                {diagLog.length === 0 && <Text style={s.hint}>まだありません</Text>}
                {diagLog.map((e, i) => (
                  <Text key={i} style={[s.diagT, e.level === 'error' && { color: '#b00020' }]}>
                    {new Date(e.at).toLocaleTimeString()} {e.msg}
                  </Text>
                ))}
              </ScrollView>
              <Pressable style={s.btn} onPress={testNet}>
                <Text style={s.btnT}>接続を確認する</Text>
              </Pressable>
              <Pressable
                style={s.btn2}
                onPress={() => {
                  clearLog();
                  setDiagLog([]);
                }}
              >
                <Text style={s.btn2T}>記録を消す</Text>
              </Pressable>
              <Pressable style={s.btn2} onPress={() => setShowDiag(false)}>
                <Text style={s.btn2T}>閉じる</Text>
              </Pressable>
            </View>
          </View>
        </Modal>

        {/* Face ID の確認(開いている間は、中身を見せない) */}
        <Modal visible={locked} animationType="none" presentationStyle="fullScreen">
          <View style={s.lock}>
            <Text style={s.lockT}>植物管理</Text>
            <Pressable style={s.btn} onPress={unlock}>
              <Text style={s.btnT}>Face ID で開く</Text>
            </Pressable>
          </View>
        </Modal>
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

const s = StyleSheet.create({
  lock: { flex: 1, backgroundColor: '#eef3ee', alignItems: 'center', justifyContent: 'center', gap: 20, padding: 40 },
  lockT: { fontSize: 24, fontWeight: '700', color: '#2e5a32' },
  diagT: { fontSize: 12, color: '#233' },
  root: { flex: 1, backgroundColor: '#fff' },
  rowFill: { flex: 1, flexDirection: 'row' },
  web: { flex: 1 },
  side: { flex: 1, borderLeftWidth: 1, borderLeftColor: '#9ab' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  hidden: { position: 'absolute', width: 2, height: 2, opacity: 0, left: 0, top: 0, overflow: 'hidden' },
  err: { position: 'absolute', left: 12, right: 12, top: 60, backgroundColor: '#fff3f3', borderColor: '#b00020', borderWidth: 1, borderRadius: 8, padding: 10, gap: 6 },
  errT: { color: '#b00020', fontWeight: '700' },
  errH: { color: '#533', fontSize: 12 },
  bottomBar: { flexDirection: 'row', backgroundColor: '#eef3ee', borderTopWidth: 1, borderTopColor: '#b9c9b9' },
  tab: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingVertical: 5 },
  tabI: { fontSize: 18 },
  tabT: { fontSize: 10, color: '#2e5a32', fontWeight: '600' },
  badge: { position: 'absolute', right: '22%', top: 2, minWidth: 18, height: 18, borderRadius: 9, backgroundColor: '#d32f2f', alignItems: 'center', justifyContent: 'center', paddingHorizontal: 3 },
  badgeT: { color: '#fff', fontSize: 11, fontWeight: '700' },
  expiry: { position: 'absolute', left: 8, right: 8, top: 8, backgroundColor: 'rgba(176,0,32,0.92)', borderRadius: 8, padding: 8, zIndex: 5 },
  expiryT: { color: '#fff', fontSize: 12, fontWeight: '600' },
  sync: { position: 'absolute', left: 8, bottom: 8, right: 8, backgroundColor: 'rgba(20,60,30,0.9)', borderRadius: 8, padding: 8 },
  syncT: { color: '#fff', fontSize: 12 },
  toast: { position: 'absolute', left: 16, right: 16, top: 56, backgroundColor: 'rgba(0,0,0,0.8)', borderRadius: 10, padding: 10 },
  toastT: { color: '#fff', fontSize: 13 },
  shade: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', justifyContent: 'center', padding: 24 },
  card: { backgroundColor: '#fff', borderRadius: 12, padding: 16, gap: 10 },
  h: { fontSize: 18, fontWeight: '700' },
  lbl: { fontWeight: '600', color: '#344' },
  hint: { color: '#566', fontSize: 12 },
  sw: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { paddingVertical: 6, paddingHorizontal: 12, borderRadius: 16, borderWidth: 1, borderColor: '#2e7d32', backgroundColor: '#fff' },
  chipOn: { backgroundColor: '#2e7d32' },
  chipT: { color: '#2e7d32', fontWeight: '600' },
  qrow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: '#dde' },
  input: { borderWidth: 1, borderColor: '#9ab', borderRadius: 8, padding: 10, fontSize: 15 },
  btn: { backgroundColor: '#2e7d32', padding: 12, borderRadius: 10, alignItems: 'center' },
  btnT: { color: '#fff', fontWeight: '700' },
  btn2: { padding: 12, borderRadius: 10, alignItems: 'center', borderWidth: 1, borderColor: '#2e7d32' },
  btn2T: { color: '#2e7d32', fontWeight: '600' },
});
