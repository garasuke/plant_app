// 調べもの用の簡易ブラウザ(iPad は右側に分割表示、iPhone は全画面で開く)。
//  ・最初のページは、システムのブックマーク一覧
//  ・複数のタブ / ページ内検索 / 閲覧履歴
//  ・文字を選ぶと、iOS標準のメニューに「一時メモに追加」「検索」が出る(ページの登録は★ボタン)
//  ・リンク・画像を長押しすると、メモ / ファイル管理 / ブックマーク / リンク集 への登録メニューが出る
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { WebView, type WebViewMessageEvent } from 'react-native-webview';

import { addHistory, clearHistory, loadHistory, type HistEntry } from './history';
import { INJECT_RESEARCH } from './inject';

export type CtxInfo = { text: string; href: string; src: string; title: string; url: string };
export type PageInfo = { title: string; url: string };

type Props = {
  home: string; // 最初に開くページ(システムのブックマーク一覧)
  linksUrl: string; // リンク集のページ
  url: string; // 親から開き先を指示する(navTick を変えると、新しいタブで開く)
  navTick: number;
  onCtx: (c: CtxInfo) => void;
  onSel: (key: string, text: string, page: PageInfo) => void;
  onPageMenu: (p: PageInfo) => void;
  onClose?: () => void; // iPhone の全画面表示で使う
};

type Tab = { id: number; src: string; title: string; url: string; canBack: boolean };
const MAX_TABS = 8;

const toUrl = (t: string): string => {
  const v = t.trim();
  if (!v) return 'about:blank';
  if (/^https?:\/\//i.test(v)) return v;
  if (/^[\w-]+(\.[\w-]+)+(\/.*)?$/.test(v)) return 'https://' + v;
  return 'https://www.google.com/search?q=' + encodeURIComponent(v);
};

// ページ内検索(WebKit の window.find)。見つかった数も数える
const findJs = (q: string, back: boolean) =>
  `(function(q,b){try{var n=0;var t=document.body?document.body.innerText:'';var re=new RegExp(q.replace(/[.*+?^$\\{\\}()|\\[\\]\\\\]/g,'\\\\$&'),'gi');n=(t.match(re)||[]).length;window.find(q,false,b,true,false,false,false);window.ReactNativeWebView.postMessage(JSON.stringify({t:'found',n:n}));}catch(e){}})(${JSON.stringify(q)},${back ? 'true' : 'false'});true;`;

export default function ResearchBrowser({ home, linksUrl, url, navTick, onCtx, onSel, onPageMenu, onClose }: Props) {
  const seq = useRef(1);
  const refs = useRef<Record<number, WebView<object> | null>>({});
  const [tabs, setTabs] = useState<Tab[]>([{ id: 1, src: home, title: '', url: home, canBack: false }]);
  const [cur, setCur] = useState(1);
  const [text, setText] = useState('');
  const [findOn, setFindOn] = useState(false);
  const [findQ, setFindQ] = useState('');
  const [found, setFound] = useState<number | null>(null);
  const [showHist, setShowHist] = useState(false);
  const [hist, setHist] = useState<HistEntry[]>([]);

  const active = tabs.find((t) => t.id === cur) ?? tabs[0];
  const patch = useCallback((id: number, p: Partial<Tab>) => setTabs((l) => l.map((t) => (t.id === id ? { ...t, ...p } : t))), []);

  const newTab = useCallback(
    (u: string) => {
      setTabs((l) => {
        const id = ++seq.current;
        setCur(id);
        setText(u);
        const t: Tab = { id, src: u, title: '', url: u, canBack: false };
        return l.length >= MAX_TABS ? [...l.slice(1), t] : [...l, t];
      });
    },
    [],
  );

  // 親からの「ここを開いて」は、新しいタブで開く
  useEffect(() => {
    if (navTick > 0 && url) newTab(url);
  }, [navTick, url, newTab]);

  const closeTab = (id: number) => {
    setTabs((l) => {
      if (l.length <= 1) return l;
      const i = l.findIndex((t) => t.id === id);
      const next = l.filter((t) => t.id !== id);
      if (id === cur) {
        const n = next[Math.max(0, i - 1)];
        setCur(n.id);
        setText(n.url);
      }
      return next;
    });
  };

  const go = (u: string) => patch(active.id, { src: u, url: u });

  const doFind = (back: boolean) => {
    if (!findQ) return;
    refs.current[active.id]?.injectJavaScript(findJs(findQ, back));
  };

  const onMessage = (id: number) => (ev: WebViewMessageEvent) => {
    try {
      const m = JSON.parse(ev.nativeEvent.data);
      if (m.t === 'ctx') onCtx({ text: m.text || '', href: m.href || '', src: m.src || '', title: m.title || '', url: m.url || '' });
      else if (m.t === 'found' && id === cur) setFound(typeof m.n === 'number' ? m.n : null);
    } catch {
      // 無視
    }
  };

  const pageOf = (): PageInfo => ({ title: active.title, url: active.url });

  return (
    <View style={s.root}>
      <View style={s.bar}>
        {onClose && (
          <Pressable onPress={onClose} style={s.btn}>
            <Text style={s.btnT}>閉じる</Text>
          </Pressable>
        )}
        <Pressable onPress={() => refs.current[active.id]?.goBack()} disabled={!active.canBack} style={[s.btn, !active.canBack && { opacity: 0.4 }]}>
          <Text style={s.btnT}>戻る</Text>
        </Pressable>
        <TextInput
          value={text}
          onChangeText={setText}
          onSubmitEditing={() => go(toUrl(text))}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          returnKeyType="go"
          selectTextOnFocus
          style={s.input}
          placeholder="検索語またはアドレス"
        />
        <Pressable onPress={() => onPageMenu(pageOf())} style={s.btn}>
          <Text style={s.btnT}>★</Text>
        </Pressable>
      </View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={s.tabs} contentContainerStyle={{ gap: 6, paddingHorizontal: 6, alignItems: 'center' }}>
        {tabs.map((t) => (
          <View key={t.id} style={[s.tab, t.id === cur && s.tabOn]}>
            <Pressable
              onPress={() => {
                setCur(t.id);
                setText(t.url);
                setFound(null);
              }}
            >
              <Text style={[s.tabT, t.id === cur && { color: '#fff' }]} numberOfLines={1}>
                {(t.title || t.url.replace(/^https?:\/\//, '')).slice(0, 14)}
              </Text>
            </Pressable>
            {tabs.length > 1 && (
              <Pressable onPress={() => closeTab(t.id)} hitSlop={8}>
                <Text style={[s.tabT, t.id === cur && { color: '#fff' }]}> ✕</Text>
              </Pressable>
            )}
          </View>
        ))}
        <Pressable onPress={() => newTab(home)} style={s.btn}>
          <Text style={s.btnT}>＋ 新しいタブ</Text>
        </Pressable>
      </ScrollView>
      <View style={s.bar2}>
        <Pressable onPress={() => go(home)} style={s.btn}>
          <Text style={s.btnT}>ブックマーク</Text>
        </Pressable>
        <Pressable onPress={() => go(linksUrl)} style={s.btn}>
          <Text style={s.btnT}>リンク集</Text>
        </Pressable>
        <Pressable onPress={() => go('https://www.google.com')} style={s.btn}>
          <Text style={s.btnT}>検索</Text>
        </Pressable>
        <Pressable onPress={() => refs.current[active.id]?.reload()} style={s.btn}>
          <Text style={s.btnT}>更新</Text>
        </Pressable>
        <Pressable onPress={() => setFindOn(!findOn)} style={[s.btn, findOn && s.btnOn]}>
          <Text style={[s.btnT, findOn && { color: '#fff' }]}>ページ内検索</Text>
        </Pressable>
        <Pressable
          onPress={async () => {
            setHist(await loadHistory());
            setShowHist(true);
          }}
          style={s.btn}
        >
          <Text style={s.btnT}>履歴</Text>
        </Pressable>
      </View>
      {findOn && (
        <View style={s.bar}>
          <TextInput
            value={findQ}
            onChangeText={setFindQ}
            onSubmitEditing={() => doFind(false)}
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType="search"
            style={s.input}
            placeholder="ページの中を探す"
            autoFocus
          />
          <Pressable onPress={() => doFind(true)} style={s.btn}>
            <Text style={s.btnT}>前</Text>
          </Pressable>
          <Pressable onPress={() => doFind(false)} style={s.btn}>
            <Text style={s.btnT}>次</Text>
          </Pressable>
          {found !== null && <Text style={s.cnt}>{found}件</Text>}
        </View>
      )}
      <View style={{ flex: 1 }}>
        {tabs.map((t) => (
          <View key={t.id} style={t.id === cur ? { flex: 1 } : s.hiddenTab}>
            <WebView<object>
              ref={(r) => {
                refs.current[t.id] = r;
              }}
              source={{ uri: t.src }}
              style={{ flex: 1 }}
              injectedJavaScript={INJECT_RESEARCH}
              onMessage={onMessage(t.id)}
              sharedCookiesEnabled
              allowsBackForwardNavigationGestures
              menuItems={[
                { label: '一時メモに追加', key: 'memo' },
                { label: '検索', key: 'search' },
              ]}
              allowsLinkPreview={false}
              onCustomMenuSelection={(e) => onSel(e.nativeEvent.key, e.nativeEvent.selectedText || '', { title: t.title, url: t.url })}
              onNavigationStateChange={(n) => {
                if (n.url && n.url !== 'about:blank') {
                  patch(t.id, { title: n.title || '', url: n.url, canBack: n.canGoBack });
                  if (t.id === cur) setText(n.url);
                  if (!n.loading) addHistory(n.url, n.title || '');
                } else {
                  patch(t.id, { canBack: n.canGoBack });
                }
              }}
            />
          </View>
        ))}
      </View>

      <Modal visible={showHist} transparent animationType="fade" onRequestClose={() => setShowHist(false)}>
        <View style={s.shade}>
          <View style={s.card}>
            <Text style={s.h}>閲覧履歴</Text>
            <ScrollView>
              {hist.length === 0 && <Text>まだありません</Text>}
              {hist.map((h, i) => (
                <Pressable
                  key={i}
                  style={s.hrow}
                  onPress={() => {
                    go(h.url);
                    setText(h.url);
                    setShowHist(false);
                  }}
                >
                  <Text style={{ fontWeight: '600' }} numberOfLines={1}>
                    {h.title || h.url}
                  </Text>
                  <Text style={s.hurl} numberOfLines={1}>
                    {new Date(h.at).toLocaleString()}  {h.url}
                  </Text>
                </Pressable>
              ))}
            </ScrollView>
            <Pressable
              style={s.btn}
              onPress={async () => {
                await clearHistory();
                setHist([]);
              }}
            >
              <Text style={s.btnT}>履歴をすべて消す</Text>
            </Pressable>
            <Pressable style={s.btn} onPress={() => setShowHist(false)}>
              <Text style={s.btnT}>閉じる</Text>
            </Pressable>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#fff' },
  bar: { flexDirection: 'row', alignItems: 'center', gap: 6, padding: 6, backgroundColor: '#eef3ee' },
  bar2: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 6, paddingHorizontal: 6, paddingBottom: 6, backgroundColor: '#eef3ee' },
  tabs: { flexGrow: 0, backgroundColor: '#e3ebe3', paddingVertical: 4 },
  tab: { flexDirection: 'row', alignItems: 'center', paddingVertical: 5, paddingHorizontal: 9, borderRadius: 14, borderWidth: 1, borderColor: '#2e7d32', backgroundColor: '#fff' },
  tabOn: { backgroundColor: '#2e7d32' },
  tabT: { color: '#2e7d32', fontSize: 12, fontWeight: '600' },
  btn: { paddingVertical: 6, paddingHorizontal: 10, borderRadius: 8, borderWidth: 1, borderColor: '#2e7d32', backgroundColor: '#fff' },
  btnOn: { backgroundColor: '#2e7d32' },
  btnT: { color: '#2e7d32', fontWeight: '600', fontSize: 13 },
  input: { flex: 1, borderWidth: 1, borderColor: '#9ab', borderRadius: 8, paddingHorizontal: 8, paddingVertical: 6, backgroundColor: '#fff', fontSize: 14 },
  cnt: { color: '#2e5a32', fontSize: 12, fontWeight: '600' },
  hiddenTab: { position: 'absolute', width: 0, height: 0, overflow: 'hidden' },
  shade: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', justifyContent: 'center', padding: 24 },
  card: { backgroundColor: '#fff', borderRadius: 12, padding: 16, gap: 10, maxHeight: '80%' },
  h: { fontSize: 18, fontWeight: '700' },
  hrow: { paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: '#dde' },
  hurl: { fontSize: 11, color: '#566' },
});
