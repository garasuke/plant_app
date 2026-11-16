// 差し込む処理(src/inject.ts の INJECT_BEFORE)の動作テスト(node で実行: node tests/test_inject.js)
const ts = require('typescript');
const fs = require('fs');
const src = fs.readFileSync(__dirname + '/../src/inject.ts', 'utf8');
const js = ts.transpileModule(src, { compilerOptions: { target: 'ES2020', module: 'commonjs' } }).outputText;
const mod = { exports: {} };
new Function('module', 'exports', js)(mod, mod.exports);
const INJECT = mod.exports.INJECT_BEFORE;

const posts = [];
let fetched = [];
class FD { constructor() { this.m = new Map(); } append(k, v) { this.m.set(k, v); } get(k) { return this.m.get(k); } has(k) { return this.m.has(k); } }
let resp = () => ({ ok: true, clone() { return { json: async () => ({ ok: true, name: 'x.jpg' }) }; } });
const win = {
  ReactNativeWebView: { postMessage: (x) => posts.push(JSON.parse(x)) },
  fetch: async (u, init) => { fetched.push({ u, init }); return resp(); },
};
global.window = win; global.FormData = FD;
global.document = { addEventListener() {}, querySelector: () => null };
global.atob = (s) => Buffer.from(s, 'base64').toString('binary');
global.Blob = class { constructor(a, o) { this.a = a; this.o = o; } };
global.Uint8Array = Uint8Array;
new Function('window', 'document', 'FormData', 'Blob', 'atob', INJECT.replace(/^\s*\(function/, '(function'))(win, global.document, FD, global.Blob, global.atob);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  let ok = true; const check = (c, m) => { console.log((c ? 'OK  ' : 'NG  ') + m); if (!c) ok = false; };
  // ページの PlantCam: upload は fetch、onPhoto は upload のあと「一覧の再読み込み」(終わらない)を待つ
  win.PlantCam = {
    open: (o) => ({ close() {} }),
    upload: async (b, n, ex) => { const fd = new FD(); fd.append('action', 'upload'); await win.fetch('cam_api.php', { method: 'POST', body: fd }); return { name: n }; },
  };
  win.PlantCam.open({ title: 't', modes: ['photo'], mode: 'photo', keepOpen: true, meta: { folder_id: '5' },
    onPhoto: async (b, n) => { await win.PlantCam.upload(b, n, {}); await new Promise(() => {}); } });
  const open = posts.find((p) => p.t === 'open');
  check(open && open.meta && open.meta.folder_id === '5', 'open に保存先の情報が付く');
  win.__nc.recv(open.id, 'photo', 0, 1, 'camera_1.jpg', 'image/jpeg', Buffer.from('abc').toString('base64'), 'jobA');
  await sleep(50);
  const sent = posts.find((p) => p.t === 'sent');
  check(sent && sent.job === 'jobA' && sent.ok === true, '一覧の再読み込みが終わらなくても、受け取られた時点で sent が届く');
  check(!posts.find((p) => p.t === 'saved'), 'saved は(ページ側が終わらないので)まだ届かない=待たない設計');
  const body = fetched[0].init.body;
  check(body.get('client_id') === 'jobA', '二重登録防止の番号 client_id が付く');
  // 閉じたあとの送信はエラーで知らせる
  win.__nc.closed(open.id);
  win.__nc.recv(open.id, 'photo', 0, 1, 'camera_2.jpg', 'image/jpeg', 'YWJj', 'jobB');
  const err = posts.find((p) => p.t === 'error' && p.job === 'jobB');
  check(!!err, '画面が閉じたあとの送信は error で知らせる');
  // 失敗の応答
  posts.length = 0;
  resp = () => ({ ok: true, clone() { return { json: async () => ({ ok: false, error: '容量が足りません' }) }; } });
  win.PlantCam.open({ title: 't', modes: ['photo'], mode: 'photo', keepOpen: true,
    onPhoto: async () => { const fd = new FD(); fd.append('action', 'upload'); await win.fetch('cam_api.php', { body: fd }); throw new Error('容量が足りません'); } });
  const o2 = posts.find((p) => p.t === 'open');
  win.__nc.recv(o2.id, 'photo', 0, 1, 'c.jpg', 'image/jpeg', 'YWJj', 'jobC');
  await sleep(50);
  const s2 = posts.find((p) => p.t === 'sent'); const e2 = posts.find((p) => p.t === 'error');
  check(s2 && s2.ok === false && s2.msg === '容量が足りません', 'サーバーが断ったときは sent の ok=false とその理由が届く');
  check(e2 && e2.job === 'jobC', 'error にも job が付く');
  console.log(ok ? '\nすべて合格' : '\n失敗あり'); process.exit(ok ? 0 : 1);
})();
