// 調べもの用の簡易ブラウザ(iPad は右側に分割表示、iPhone は全画面で開く)。
//  ・最初のページは、システムのブックマーク一覧
//  ・文字を選ぶと、iOS標準のメニューに「一時メモに追加」「検索」「ブックマークに追加」が出る
//  ・リンク・画像を長押しすると、メモ / ファイル管理 / ブックマーク / リンク集 への登録メニューが出る
import React, { useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { WebView, type WebViewMessageEvent } from 'react-native-webview';

import { INJECT_RESEARCH } from './inject';

export type CtxInfo = { text: string; href: string; src: string; title: string; url: string };
export type PageInfo = { title: string; url: string };

type Props = {
  home: string; // 最初に開くページ(システムのブックマーク一覧)
  linksUrl: string; // リンク集のページ
  url: string; // 親から開き先を指示する(navTick を変えると移動する)
  navTick: number;
  onCtx: (c: CtxInfo) => void;
  onSel: (key: string, text: string, page: PageInfo) => void;
  onPageMenu: (p: PageInfo) => void;
  onClose?: () => void; // iPhone の全画面表示で使う
};

const toUrl = (t: string): string => {
  const v = t.trim();
  if (!v) return 'about:blank';
  if (/^https?:\/\//i.test(v)) return v;
  if (/^[\w-]+(\.[\w-]+)+(\/.*)?$/.test(v)) return 'https://' + v;
  return 'https://www.google.com/search?q=' + encodeURIComponent(v);
};

export default function ResearchBrowser({ home, linksUrl, url, navTick, onCtx, onSel, onPageMenu, onClose }: Props) {
  const ref = useRef<WebView<object>>(null);
  const [src, setSrc] = useState(home);
  const [text, setText] = useState('');
  const [canBack, setCanBack] = useState(false);
  const page = useRef<PageInfo>({ title: '', url: home });

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
          selectTextOnFocus
          style={s.input}
          placeholder="検索語またはアドレス"
        />
        <Pressable onPress={() => onPageMenu(page.current)} style={s.btn}>
          <Text style={s.btnT}>★</Text>
        </Pressable>
      </View>
      <View style={s.bar2}>
        <Pressable onPress={() => setSrc(home)} style={s.btn}>
          <Text style={s.btnT}>ブックマーク</Text>
        </Pressable>
        <Pressable onPress={() => setSrc(linksUrl)} style={s.btn}>
          <Text style={s.btnT}>リンク集</Text>
        </Pressable>
        <Pressable onPress={() => setSrc('https://www.google.com')} style={s.btn}>
          <Text style={s.btnT}>検索</Text>
        </Pressable>
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
        sharedCookiesEnabled
        allowsBackForwardNavigationGestures
        menuItems={[
          { label: '一時メモに追加', key: 'memo' },
          { label: '検索', key: 'search' },
          { label: 'ページをブックマークへ', key: 'bm' },
        ]}
        onCustomMenuSelection={(e) => onSel(e.nativeEvent.key, e.nativeEvent.selectedText || '', page.current)}
        onNavigationStateChange={(n) => {
          setCanBack(n.canGoBack);
          if (n.url && n.url !== 'about:blank') {
            page.current = { title: n.title || '', url: n.url };
            setText(n.url);
          }
        }}
      />
    </View>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#fff' },
  bar: { flexDirection: 'row', alignItems: 'center', gap: 6, padding: 6, backgroundColor: '#eef3ee' },
  bar2: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 6, paddingBottom: 6, backgroundColor: '#eef3ee' },
  btn: { paddingVertical: 6, paddingHorizontal: 10, borderRadius: 8, borderWidth: 1, borderColor: '#2e7d32', backgroundColor: '#fff' },
  btnT: { color: '#2e7d32', fontWeight: '600', fontSize: 13 },
  input: { flex: 1, borderWidth: 1, borderColor: '#9ab', borderRadius: 8, paddingHorizontal: 8, paddingVertical: 6, backgroundColor: '#fff', fontSize: 14 },
});
