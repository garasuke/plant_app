// ページが読み込まれる前に差し込む処理。
// 既存の PlantCam.open(...) を、写真・ピント合成のときだけネイティブ撮影に差し替える。
// 撮影結果はアプリ側から __nc.recv(...) で渡され、ページ自身の onPhoto / onBurst が従来どおり保存する
// (ログインの Cookie や CSRF はページ側のものがそのまま使われる)。
export const INJECT_BEFORE = `
(function () {
  if (window.__ncInstalled) { return; }
  window.__ncInstalled = true;
  var seq = 0, sessions = {};
  function post(m) { try { window.ReactNativeWebView.postMessage(JSON.stringify(m)); } catch (e) {} }
  function modesOf(o) { return (o && o.modes && o.modes.length) ? o.modes : [(o && o.mode) || 'photo']; }
  function useNative(o) {
    var first = (o && o.mode) || modesOf(o)[0];
    if (first === 'qr' || first === 'video') { return false; }
    var m = modesOf(o);
    return m.indexOf('photo') >= 0 || m.indexOf('burst') >= 0;
  }
  function wrap(p) {
    if (!p || p.__nc || typeof p.open !== 'function') { return; }
    var orig = p.open;
    p.open = function (o) {
      o = o || {};
      if (!useNative(o)) { return orig.call(p, o); }
      var id = 's' + (++seq);
      sessions[id] = { id: id, o: o, orig: orig, p: p, parts: {}, names: {} };
      var all = modesOf(o);
      post({
        t: 'open', id: id, title: o.title || 'カメラ',
        modes: all.filter(function (m) { return m === 'photo' || m === 'burst'; }),
        mode: o.mode === 'burst' ? 'burst' : 'photo',
        keepOpen: !!o.keepOpen,
        hasWeb: all.indexOf('video') >= 0 || all.indexOf('qr') >= 0
      });
      return {
        close: function () { post({ t: 'close', id: id }); },
        setMode: function () {}, setTitle: function () {}, setTarget: function () {}, meta: function () { return {}; },
        say: function (m) { post({ t: 'say', id: id, msg: String(m || '') }); },
        mode: function () { return 'photo'; }
      };
    };
    p.__nc = true;
  }
  function run(s, kind, list, names) {
    var o = s.o, pr;
    try {
      if (kind === 'photo') { pr = o.onPhoto ? o.onPhoto(list[0], names[0]) : null; }
      else { pr = o.onBurst ? o.onBurst(list) : null; }
    } catch (e) { pr = Promise.reject(e); }
    Promise.resolve(pr).then(
      function () { post({ t: 'saved', id: s.id, kind: kind }); },
      function (e) { post({ t: 'error', id: s.id, msg: (e && e.message) || String(e) }); }
    );
  }
  window.__nc = {
    recv: function (id, kind, index, total, name, mime, b64) {
      var s = sessions[id]; if (!s) { return; }
      var bin = atob(b64), u8 = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) { u8[i] = bin.charCodeAt(i); }
      var arr = s.parts[kind] = s.parts[kind] || [];
      var nm = s.names[kind] = s.names[kind] || [];
      arr[index] = new Blob([u8], { type: mime }); nm[index] = name;
      var have = 0; for (var j = 0; j < total; j++) { if (arr[j]) { have++; } }
      if (have < total) { return; }
      delete s.parts[kind]; delete s.names[kind];
      run(s, kind, arr, nm);
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
