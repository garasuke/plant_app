// 植物管理(iPhone / iPad クライアント)
// 既存の植物管理システムを WebView で表示し、カメラの「写真」「ピント合成」だけネイティブ撮影に差し替える。
import { File } from 'expo-file-system';
import { StatusBar } from 'expo-status-bar';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Modal, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { WebView, type WebViewMessageEvent } from 'react-native-webview';

import { DEFAULT_URL, loadUrl, saveUrl } from './src/config';
import { INJECT_BEFORE } from './src/inject';
import NativeCamera, { type CamMode, type CamRequest, type Msg, type Taken } from './src/NativeCamera';

const stamp = () => {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
};

export default function App() {
  const [url, setUrl] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [showSettings, setShowSettings] = useState(false);
  const [loadErr, setLoadErr] = useState('');
  const [webKey, setWebKey] = useState(0);

  const [req, setReq] = useState<CamRequest | null>(null);
  const [camMsg, setCamMsg] = useState<Msg>({ text: '' });
  const [sending, setSending] = useState(false);
  const [savedTick, setSavedTick] = useState(0);

  const webRef = useRef<WebView<object>>(null);
  const reqRef = useRef<CamRequest | null>(null);
  reqRef.current = req;

  useEffect(() => {
    loadUrl().then((u) => {
      setUrl(u);
      setDraft(u);
    });
  }, []);

  const js = useCallback((code: string) => webRef.current?.injectJavaScript(code + ';true;'), []);

  const closeCam = useCallback(() => {
    const r = reqRef.current;
    setReq(null);
    setSending(false);
    if (r) js(`window.__nc&&window.__nc.closed(${JSON.stringify(r.id)})`);
  }, [js]);

  const onMessage = useCallback(
    (ev: WebViewMessageEvent) => {
      let m: any;
      try {
        m = JSON.parse(ev.nativeEvent.data);
      } catch {
        return;
      }
      switch (m.t) {
        case 'open':
          setCamMsg({ text: '' });
          setSending(false);
          setReq({ id: m.id, title: m.title, modes: m.modes, mode: m.mode, keepOpen: !!m.keepOpen, hasWeb: !!m.hasWeb });
          break;
        case 'close':
          closeCam();
          break;
        case 'say':
          setCamMsg({ text: String(m.msg || '') });
          break;
        case 'saved':
          setSending(false);
          setSavedTick((t) => t + 1);
          setCamMsg({ text: '保存しました。' });
          if (!reqRef.current?.keepOpen) closeCam();
          break;
        case 'error':
          setSending(false);
          setCamMsg({ text: '保存できませんでした: ' + String(m.msg || ''), error: true });
          break;
      }
    },
    [closeCam],
  );

  const onSend = useCallback(
    async (kind: CamMode, files: Taken[]) => {
      const r = reqRef.current;
      if (!r) return;
      setSending(true);
      setCamMsg({ text: 'サーバーへ送っています…' });
      try {
        const base = stamp();
        for (let i = 0; i < files.length; i++) {
          const b64 = await new File('file://' + files[i].path).base64();
          const name = kind === 'photo' ? `camera_${base}.jpg` : `focus_${base}_${i + 1}.jpg`;
          js(
            `window.__nc.recv(${JSON.stringify(r.id)},${JSON.stringify(kind)},${i},${files.length},${JSON.stringify(name)},"image/jpeg",${JSON.stringify(b64)})`,
          );
        }
      } catch (e) {
        setSending(false);
        setCamMsg({ text: '送信の準備に失敗: ' + (e instanceof Error ? e.message : String(e)), error: true });
      }
    },
    [js],
  );

  const onUseWeb = useCallback(
    (mode: 'video' | 'qr') => {
      const r = reqRef.current;
      setReq(null);
      setSending(false);
      if (r) js(`window.__nc&&window.__nc.useweb(${JSON.stringify(r.id)},${JSON.stringify(mode)})`);
    },
    [js],
  );

  const applyUrl = () => {
    const u = draft.trim();
    if (!/^https?:\/\//.test(u)) return;
    saveUrl(u);
    setUrl(u);
    setLoadErr('');
    setWebKey((k) => k + 1);
    setShowSettings(false);
  };

  if (!url) {
    return (
      <View style={s.center}>
        <ActivityIndicator />
      </View>
    );
  }

  return (
    <SafeAreaProvider>
      <SafeAreaView style={s.root} edges={['top', 'left', 'right']}>
        <StatusBar style="dark" />
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
          mediaCapturePermissionGrantType="grantIfSameHostElsePrompt"
          allowsBackForwardNavigationGestures
          injectedJavaScriptBeforeContentLoaded={INJECT_BEFORE}
          onMessage={onMessage}
          onLoadStart={() => setLoadErr('')}
          onError={(e) => setLoadErr(e.nativeEvent.description || '読み込めませんでした')}
          onHttpError={(e) => setLoadErr(`サーバーの応答エラー (${e.nativeEvent.statusCode})`)}
        />
        {!!loadErr && (
          <View style={s.err}>
            <Text style={s.errT}>読み込めません: {loadErr}</Text>
            <Text style={s.errH}>
              ・同じ Wi-Fi(自宅内)に接続していますか{'\n'}
              ・iPhone の Safari で同じアドレスが開けますか(証明書の信頼設定)
            </Text>
          </View>
        )}
        <Pressable style={s.gear} onPress={() => setShowSettings(true)}>
          <Text style={s.gearT}>⚙</Text>
        </Pressable>

        {req && (
          <NativeCamera
            req={req}
            message={camMsg}
            sending={sending}
            savedTick={savedTick}
            onSend={onSend}
            onClose={closeCam}
            onUseWeb={onUseWeb}
          />
        )}

        <Modal visible={showSettings} transparent animationType="fade" onRequestClose={() => setShowSettings(false)}>
          <View style={s.shade}>
            <View style={s.card}>
              <Text style={s.h}>設定</Text>
              <Text style={s.lbl}>システムのアドレス</Text>
              <TextInput
                value={draft}
                onChangeText={setDraft}
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="url"
                style={s.input}
                placeholder={DEFAULT_URL}
              />
              <Pressable style={s.btn} onPress={applyUrl}>
                <Text style={s.btnT}>保存して開く</Text>
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
            </View>
          </View>
        </Modal>
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#fff' },
  web: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  err: { position: 'absolute', left: 12, right: 12, top: 60, backgroundColor: '#fff3f3', borderColor: '#b00020', borderWidth: 1, borderRadius: 8, padding: 10 },
  errT: { color: '#b00020', fontWeight: '700' },
  errH: { color: '#533', marginTop: 4, fontSize: 12 },
  gear: { position: 'absolute', right: 8, bottom: 8, width: 36, height: 36, borderRadius: 18, backgroundColor: 'rgba(0,0,0,0.45)', alignItems: 'center', justifyContent: 'center' },
  gearT: { color: '#fff', fontSize: 18 },
  shade: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', justifyContent: 'center', padding: 24 },
  card: { backgroundColor: '#fff', borderRadius: 12, padding: 16, gap: 10 },
  h: { fontSize: 18, fontWeight: '700' },
  lbl: { fontWeight: '600', color: '#344' },
  input: { borderWidth: 1, borderColor: '#9ab', borderRadius: 8, padding: 10, fontSize: 15 },
  btn: { backgroundColor: '#2e7d32', padding: 12, borderRadius: 10, alignItems: 'center' },
  btnT: { color: '#fff', fontWeight: '700' },
  btn2: { padding: 12, borderRadius: 10, alignItems: 'center', borderWidth: 1, borderColor: '#2e7d32' },
  btn2T: { color: '#2e7d32', fontWeight: '600' },
});
