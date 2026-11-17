// ページが読み込まれる前に差し込む処理(本体の画面・裏方の画面で共通)。
//  1) PlantCam.open(...) を、写真・ピント合成・QR読み取りのときだけネイティブ撮影に差し替える。
//     撮影結果はアプリ側から __nc.recv(...) で渡され、ページ自身の onPhoto / onBurst が従来どおり保存する。
//  2) 撮影場所: アプリが取った現在地を、cam_api.php への保存(upload / stack)に添える。
//  3) 裏方(__w): 順番待ちの送信・一時メモ・記録の検索・通知一覧の取得を、ログイン済みのページの権限で実行する。
export const INJECT_BEFORE = `
(function () {
  if (window.__ncInstalled) { return; }
  window.__ncInstalled = true;
  var seq = 0, sessions = {};
  function post(m) { try { window.ReactNativeWebView.postMessage(JSON.stringify(m)); } catch (e) {} }
  function modesOf(o) { return (o && o.modes && o.modes.length) ? o.modes : [(o && o.mode) || 'photo']; }
  function useNative(o) {
    var first = (o && o.mode) || modesOf(o)[0];
    if (first === 'video') { return false; }
    if (first === 'qr') { return typeof o.onQR === 'function'; }
    var m = modesOf(o);
    return m.indexOf('photo') >= 0 || m.indexOf('burst') >= 0;
  }
  function csrf() { var m = document.querySelector('meta[name="csrf"]'); return m ? m.content : ''; }
  function b64blob(b64, mime) {
    var bin = atob(b64), u8 = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) { u8[i] = bin.charCodeAt(i); }
    return new Blob([u8], { type: mime });
  }

  // ---- 撮影場所を保存に添える ----
  // 保存の完了(サーバーが受け取った)は、ページ側の後片付け(一覧の再読み込みなど)を待たずに、ここで知らせる
  var ofetch = window.fetch;
  window.fetch = function (u, init) {
    var act = '';
    try {
      var g = window.__ncGeo;
      if (init && init.body instanceof FormData && String(u).indexOf('cam_api.php') >= 0) {
        var a = init.body.get('action');
        if ((a === 'upload' || a === 'stack')) {
          act = a;
          if (g && Date.now() - g.at < 10 * 60 * 1000 && !init.body.has('lat')) {
            init.body.append('lat', Number(g.lat).toFixed(6));
            init.body.append('lng', Number(g.lng).toFixed(6));
            init.body.append('geo_acc', String(Math.round(g.acc || 0)));
          }
          // 二重登録を防ぐための撮影ごとの番号(サーバーが対応していれば使われる)
          if (window.__ncJob && !init.body.has('client_id')) { init.body.append('client_id', String(window.__ncJob)); }
        }
      }
    } catch (e) {}
    var pr = ofetch.apply(this, arguments);
    if (act && window.__ncJob) {
      var job = window.__ncJob;
      pr.then(function (r) {
        try {
          r.clone().json().then(function (d) { post({ t: 'sent', job: job, ok: !(d && d.ok === false), msg: d && d.error ? String(d.error) : '' }); }, function () { post({ t: 'sent', job: job, ok: r.ok }); });
        } catch (e) {}
      }, function () {});
    }
    return pr;
  };

  function wrap(p) {
    if (!p || p.__nc || typeof p.open !== 'function') { return; }
    var orig = p.open;
    p.open = function (o) {
      o = o || {};
      if (!useNative(o)) { return orig.call(p, o); }
      var id = 's' + (++seq);
      var all = modesOf(o);
      var mo = o.meta || {};
      var M = { table: (mo.target && mo.target.table) || '', id: (mo.target && (mo.target.id || mo.target.target_id)) || '', name: (mo.target && mo.target.name) || '', kind: (mo.target && mo.target.kind) || '', folder_id: mo.folder_id || '', tags: mo.tags || '' };
      var curMode = o.mode || all[0];
      sessions[id] = { id: id, o: o, orig: orig, p: p, parts: {}, names: {}, M: M, mo: mo, mode: curMode };
      var native = all.filter(function (m) { return m === 'photo' || m === 'burst' || (m === 'qr' && typeof o.onQR === 'function'); });
      post({
        t: 'open', id: id, title: o.title || 'カメラ',
        modes: native, mode: curMode,
        keepOpen: !!o.keepOpen,
        hasWeb: all.indexOf('video') >= 0,
        target: M.id ? M.name : '',
        meta: metaOf()
      });
      function metaOf() { return { table: M.table, target_id: M.id, folder_id: M.folder_id, tags: M.tags }; }
      function changed() {
        if (mo.onChange) { try { mo.onChange({ target: M.id ? { table: M.table, id: M.id, name: M.name, kind: M.kind } : null, folder_id: M.folder_id, tags: M.tags }); } catch (e) {} }
        post({ t: 'target', id: id, name: M.id ? M.name : '', meta: metaOf() });
      }
      return {
        close: function () { post({ t: 'close', id: id }); },
        setMode: function (m) { sessions[id] && (sessions[id].mode = m); post({ t: 'mode', id: id, mode: m }); },
        setTitle: function (t) { post({ t: 'title', id: id, title: String(t || '') }); },
        setTarget: function (t) {
          M.table = t ? t.table : ''; M.id = t ? (t.id || t.target_id || '') : ''; M.name = t ? (t.name || '') : ''; M.kind = t ? (t.kind || '') : '';
          changed();
        },
        meta: function () { return { table: M.table, target_id: M.id, folder_id: M.folder_id, tags: M.tags }; },
        say: function (m, bad) { post({ t: 'say', id: id, msg: String(m || ''), bad: !!bad }); },
        mode: function () { return (sessions[id] && sessions[id].mode) || 'photo'; }
      };
    };
    p.__nc = true;
  }
  function run(s, kind, list, names, job) {
    var o = s.o, pr;
    window.__ncJob = job || '';
    try {
      if (kind === 'photo') { pr = o.onPhoto ? o.onPhoto(list[0], names[0]) : null; }
      else { pr = o.onBurst ? o.onBurst(list) : null; }
    } catch (e) { pr = Promise.reject(e); }
    Promise.resolve(pr).then(
      function () { if (window.__ncJob === job) { window.__ncJob = ''; } post({ t: 'saved', id: s.id, kind: kind, job: job }); },
      function (e) { if (window.__ncJob === job) { window.__ncJob = ''; } post({ t: 'error', id: s.id, job: job, msg: (e && e.message) || String(e) }); }
    );
  }
  // ---- ダウンロード: ページ(ログイン済み)の権限で取得し、アプリへ渡す ----
  async function dl(url, hint) {
    try {
      post({ t: 'dlstart' });
      var r = await fetch(url, { credentials: 'same-origin' });
      if (!r.ok) { throw new Error('サーバーの応答エラー (' + r.status + ')'); }
      var cd = r.headers.get('Content-Disposition') || '', name = '', m = /filename\*=UTF-8''([^;]+)/i.exec(cd);
      if (m) { try { name = decodeURIComponent(m[1]); } catch (e) {} }
      if (!name) { m = /filename="?([^";]+)"?/i.exec(cd); if (m) { name = m[1]; } }
      var b = await r.blob();
      var fr = new FileReader();
      fr.onload = function () { var d = String(fr.result); post({ t: 'dl', name: name || hint || '', mime: b.type || '', url: url, b64: d.slice(d.indexOf(',') + 1) }); };
      fr.onerror = function () { post({ t: 'dlerr', msg: 'ファイルを読み取れませんでした' }); };
      fr.readAsDataURL(b);
    } catch (e) { post({ t: 'dlerr', msg: (e && e.message) || String(e) }); }
  }
  document.addEventListener('click', function (e) {
    var a = e.target && e.target.closest ? e.target.closest('a[download]') : null;
    if (a && a.href && a.href.indexOf('blob:') !== 0) { e.preventDefault(); e.stopPropagation(); dl(a.href, a.getAttribute('download') || ''); }
  }, true);

  window.__nc = {
    dl: dl,
    geo: function (g) { window.__ncGeo = g ? { lat: g.lat, lng: g.lng, acc: g.acc, at: Date.now() } : null; },
    recv: function (id, kind, index, total, name, mime, b64, job) {
      var s = sessions[id]; if (!s) { post({ t: 'error', id: id, job: job, msg: 'カメラの画面が閉じられていました(ページが読み込み直された可能性があります)' }); return; }
      var arr = s.parts[kind] = s.parts[kind] || [];
      var nm = s.names[kind] = s.names[kind] || [];
      arr[index] = b64blob(b64, mime); nm[index] = name;
      var have = 0; for (var j = 0; j < total; j++) { if (arr[j]) { have++; } }
      if (have < total) { return; }
      delete s.parts[kind]; delete s.names[kind];
      run(s, kind, arr, nm, job);
    },
    qr: function (id, text) {
      var s = sessions[id]; if (!s || !s.o.onQR) { return; }
      var pr;
      try { pr = s.o.onQR(String(text)); } catch (e) { pr = Promise.reject(e); }
      Promise.resolve(pr).then(null, function (e) { post({ t: 'error', id: id, msg: (e && e.message) || String(e) }); });
    },
    closed: function (id) {
      var s = sessions[id]; if (!s) { return; }
      delete sessions[id];
      try { if (s.o.onClose) { s.o.onClose(); } } catch (e) {}
    },
    useweb: function (id, mode) {
      var s = sessions[id]; if (!s) { return; }
      delete sessions[id];
      var o2 = {}; for (var k in s.o) { o2[k] = s.o[k]; } o2.mode = mode;
      s.orig.call(s.p, o2);
    }
  };

  // ---- 裏方(順番待ちの送信など) ----
  var blobs = {};
  function reply(rid, ok, data) { post({ t: 'w', id: rid, ok: ok, data: ok ? data : undefined, error: ok ? undefined : ((data && data.message) || String(data)) }); }
  async function apiJson(path, opt) {
    var r = await fetch(path, Object.assign({ credentials: 'same-origin' }, opt || {}));
    var d; try { d = await r.json(); } catch (e) { throw new Error(r.status === 401 || r.status === 403 ? 'ログインが必要です' : ('サーバーの応答が正しくありません(' + r.status + ')')); }
    if (d && d.ok === false) { throw new Error(d.error || 'うまくいきませんでした'); }
    return d;
  }
  function form(o) { var fd = new FormData(); Object.keys(o).forEach(function (k) { if (o[k] !== undefined && o[k] !== null && o[k] !== '') { fd.append(k, o[k]); } }); return fd; }
  window.__w = {
    put: function (key, i, name, mime, b64) {
      var a = blobs[key] = blobs[key] || [];
      a[i] = { blob: b64blob(b64, mime), name: name };
    },
    run: async function (rid, kind, p) {
      try {
        if (!window.PlantCam && (kind === 'upload' || kind === 'stack')) { throw new Error('このページでは送れません'); }
        if (!csrf() && kind !== 'notify' && kind !== 'lookup' && kind !== 'ping') { throw new Error('ログインが必要です'); }
        var d;
        if (kind === 'ping') { d = { csrf: !!csrf(), cam: !!window.PlantCam, url: location.href }; }
        else if (kind === 'notify') { d = await apiJson('notify_api.php?action=list&days=' + (p.days || 14) + '&event_days=' + (p.days || 14) + '&expiry_days=' + (p.days || 14)); }
        else if (kind === 'lookup') { d = await apiJson('cam_api.php?action=lookup&text=' + encodeURIComponent(p.text)); }
        else if (kind === 'memo') {
          d = await apiJson('memo_inbox_api.php', { method: 'POST', headers: { 'X-CSRF-Token': csrf() }, body: form({ action: 'add', data: JSON.stringify(p.data) }) });
        }
        else if (kind === 'link') {
          d = await apiJson(p.api + '?action=save', { method: 'POST', headers: { 'X-CSRF-Token': csrf() }, body: form({ data: JSON.stringify(p.data) }) });
        }
        else if (kind === 'upload') {
          var u = blobs[p.key] && blobs[p.key][0]; if (!u) { throw new Error('送る写真がありません'); }
          if (p.geo) { window.__ncGeo = { lat: p.geo.lat, lng: p.geo.lng, acc: p.geo.acc, at: Date.now() }; }
          try { d = await window.PlantCam.upload(u.blob, u.name, p.extra || {}); } finally { delete blobs[p.key]; if (p.geo) { window.__ncGeo = null; } }
        }
        else if (kind === 'stack') {
          var arr = (blobs[p.key] || []).map(function (x) { return x.blob; });
          if (arr.length < 2) { throw new Error('合成する写真が足りません'); }
          if (p.geo) { window.__ncGeo = { lat: p.geo.lat, lng: p.geo.lng, acc: p.geo.acc, at: Date.now() }; }
          try { d = await window.PlantCam.stack(arr, p.extra || {}); } finally { delete blobs[p.key]; if (p.geo) { window.__ncGeo = null; } }
        }
        else { throw new Error('不明な指示です'); }
        reply(rid, true, d);
      } catch (e) { reply(rid, false, e); }
    }
  };

  var cur = window.PlantCam;
  Object.defineProperty(window, 'PlantCam', {
    configurable: true, enumerable: true,
    get: function () { return cur; },
    set: function (v) { cur = v; wrap(v); }
  });
  if (cur) { wrap(cur); }
})();
true;
`;

// 右側の調べもの画面(iPad の分割表示 / iPhone の調べもの画面)で、長押ししたものをアプリへ知らせる。
export const INJECT_RESEARCH = `
(function () {
  if (window.__rsInstalled) { return; }
  window.__rsInstalled = true;
  function post(m) { try { window.ReactNativeWebView.postMessage(JSON.stringify(m)); } catch (e) {} }
  var timer = null, sx = 0, sy = 0;
  // iOS標準のリンクのメニュー(Open Link など)を出さず、こちらのメニューを使う
  try {
    var st = document.createElement('style');
    st.textContent = 'a,img{-webkit-touch-callout:none !important;}';
    (document.head || document.documentElement).appendChild(st);
  } catch (e) {}
  function isInput(t) {
    if (!t || !t.closest) { return false; }
    return !!t.closest('input,textarea,select,[contenteditable],[contenteditable=""],[contenteditable="true"]');
  }
  document.addEventListener('touchstart', function (e) {
    clearTimeout(timer);
    if (e.touches.length !== 1) { return; }
    var t = e.target;
    if (isInput(t)) { return; }
    var img = t.closest ? t.closest('img') : null;
    var a = t.closest ? t.closest('a[href]') : null;
    if (!img && !a) { return; }   // 文字などは、iOS標準の選択メニュー(項目を足してあります)に任せる
    sx = e.touches[0].clientX; sy = e.touches[0].clientY;
    timer = setTimeout(function () {
      var sel = String(window.getSelection ? window.getSelection() : '').trim();
      if (sel) { return; }   // 文字が選ばれたときは、選択メニューのほうを使う
      post({ t: 'ctx', text: '', href: a ? a.href : '', src: img ? (img.currentSrc || img.src) : '', title: document.title, url: location.href });
    }, 450);
  }, { passive: true });
  function cancel() { clearTimeout(timer); }
  document.addEventListener('touchmove', function (e) {
    var x = e.touches[0].clientX, y = e.touches[0].clientY;
    if (Math.abs(x - sx) > 10 || Math.abs(y - sy) > 10) { cancel(); }
  }, { passive: true });
  document.addEventListener('touchend', cancel, { passive: true });
  document.addEventListener('touchcancel', cancel, { passive: true });
  document.addEventListener('contextmenu', function (e) { if (!isInput(e.target)) { e.preventDefault(); } }, true);
})();
true;
`;
