// 調べもの用の簡易ブラウザ(iPad は右側に分割表示、iPhone は全画面で開く)。
// 画面を長押しすると、選んだ文字・リンク・画像を「一時メモに追加」「ファイル管理に保存」などに送れる。
import React, { useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { WebView, type WebViewMessageEvent } from 'react-native-webview';

import { INJECT_RESEARCH } from './inject';

export type CtxInfo = { text: string; href: string; src: string; title: string; url: string };

type Props = {
  url: string; // 親から開き先を指示する(変えると移動する)
  navTick: number;
  onCtx: (c: CtxInfo) => void;
  onClose?: () => void; // iPhone の全画面表示で使う
  onUrl?: (u: string) => void;
};

const toUrl = (t: string): string => {
  const v = t.trim();
  if (!v) return 'about:blank';
  if (/^https?:\/\//i.test(v)) return v;
  if (/^[\w-]+(\.[\w-]+)+(\/.*)?$/.test(v)) return 'https://' + v;
  return 'https://www.google.com/search?q=' + encodeURIComponent(v);
};

export default function ResearchBrowser({ url, navTick, onCtx, onClose, onUrl }: Props) {
  const ref = useRef<WebView<object>>(null);
  const [src, setSrc] = useState(url || 'https://www.google.com');
  const [cur, setCur] = useState(url || 'https://www.google.com');
  const [text, setText] = useState(url || '');
  const [canBack, setCanBack] = useState(false);

  useEffect(() => {
    if (navTick > 0 && url) {
      setSrc(url);
      setText(url);
    }
  }, [navTick, url]);

  const onMessage = (ev: WebViewMessageEvent) => {
    try {
      const m = JSON.parse(ev.nativeEvent.data);
      if (m.t === 'ctx') onCtx({ text: m.text || '', href: m.href || '', src: m.src || '', title: m.title || '', url: m.url || '' });
    } catch {
      // 無視
    }
  };

  return (
    <View style={s.root}>
      <View style={s.bar}>
        {onClose && (
          <Pressable onPress={onClose} style={s.btn}>
            <Text style={s.btnT}>閉じる</Text>
          </Pressable>
        )}
        <Pressable onPress={() => ref.current?.goBack()} disabled={!canBack} style={[s.btn, !canBack && { opacity: 0.4 }]}>
          <Text style={s.btnT}>戻る</Text>
        </Pressable>
        <TextInput
          value={text}
          onChangeText={setText}
          onSubmitEditing={() => setSrc(toUrl(text))}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          returnKeyType="go"
          style={s.input}
          placeholder="検索語またはアドレス"
        />
        <Pressable onPress={() => ref.current?.reload()} style={s.btn}>
          <Text style={s.btnT}>更新</Text>
        </Pressable>
      </View>
      <WebView<object>
        ref={ref}
        source={{ uri: src }}
        style={{ flex: 1 }}
        injectedJavaScript={INJECT_RESEARCH}
        onMessage={onMessage}
        allowsBackForwardNavigationGestures
        onNavigationStateChange={(n) => {
          setCanBack(n.canGoBack);
          if (n.url && n.url !== 'about:blank') {
            setCur(n.url);
            setText(n.url);
            onUrl?.(n.url);
          }
        }}
      />
      <Text style={s.foot} numberOfLines={1}>
        長押し: 文字・リンク・画像をメモ/ファイル管理へ  {cur}
      </Text>
    </View>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#fff' },
  bar: { flexDirection: 'row', alignItems: 'center', gap: 6, padding: 6, backgroundColor: '#eef3ee' },
  btn: { paddingVertical: 6, paddingHorizontal: 10, borderRadius: 8, borderWidth: 1, borderColor: '#2e7d32', backgroundColor: '#fff' },
  btnT: { color: '#2e7d32', fontWeight: '600', fontSize: 13 },
  input: { flex: 1, borderWidth: 1, borderColor: '#9ab', borderRadius: 8, paddingHorizontal: 8, paddingVertical: 6, backgroundColor: '#fff', fontSize: 14 },
  foot: { fontSize: 10, color: '#566', paddingHorizontal: 6, paddingVertical: 2, backgroundColor: '#eef3ee' },
});
