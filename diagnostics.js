/* ============================================================================
   diagnostics.js — live cache + music inspector
   ----------------------------------------------------------------------------
   Open it any of these ways:
     • add #diag to the URL and reload
     • run Diag.open() from the console
     • tap the version number in the corner five times
   Everything refreshes on a timer, so you can watch files land in the cache
   as they download and watch the music decks change state as tracks switch.
   ==========================================================================*/
window.Diag = (function () {
  "use strict";

  var root = null, timer = null, tab = "cache";
  var cacheRows = [], swInfo = { version: "?", cache: "?", scope: "?", state: "none" };
  var scanning = false, lastScan = 0;

  /* ---------------------------------------------------------------- styling */
  var CSS = `
  #diagPanel{position:fixed;inset:0;z-index:999999;background:rgba(6,8,16,.94);
    color:#dfe6ff;font:12px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace;
    display:flex;flex-direction:column;backdrop-filter:blur(6px)}
  #diagPanel *{box-sizing:border-box}
  .dg-head{display:flex;align-items:center;gap:8px;padding:10px 12px;
    border-bottom:1px solid #223;background:#0b1020;flex:0 0 auto}
  .dg-title{font-weight:700;color:#5ff;letter-spacing:.5px}
  .dg-x{margin-left:auto;background:#1a2340;border:1px solid #2c3a63;color:#cfe;
    border-radius:6px;padding:6px 12px;cursor:pointer;font:inherit}
  .dg-tabs{display:flex;gap:6px;padding:8px 12px;border-bottom:1px solid #223;flex:0 0 auto}
  .dg-tab{background:#131c33;border:1px solid #26325a;color:#9fb0dd;border-radius:6px;
    padding:6px 12px;cursor:pointer;font:inherit}
  .dg-tab.on{background:#1d2c55;color:#7ff;border-color:#3b5bb5}
  .dg-body{flex:1 1 auto;overflow:auto;padding:12px;-webkit-overflow-scrolling:touch}
  .dg-card{background:#0e1428;border:1px solid #202c4d;border-radius:8px;
    padding:10px 12px;margin-bottom:10px}
  .dg-kv{display:flex;justify-content:space-between;gap:10px;padding:2px 0}
  .dg-kv span:first-child{color:#8fa0cc}
  .dg-bar{height:10px;background:#151d36;border-radius:5px;overflow:hidden;margin:8px 0 4px}
  .dg-bar i{display:block;height:100%;background:linear-gradient(90deg,#2de,#5f8cff);
    width:0;transition:width .3s}
  .dg-row{display:flex;align-items:center;gap:8px;padding:4px 0;border-bottom:1px solid #16203a}
  .dg-row .n{flex:1 1 auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .dg-row .s{color:#7f8db5;flex:0 0 auto;font-size:11px}
  .dg-dot{width:9px;height:9px;border-radius:50%;flex:0 0 auto}
  .ok{background:#3ad07f}.miss{background:#ff5a6a}.wait{background:#f0b429}
  .dg-btn{background:#182342;border:1px solid #2c3a63;color:#cfe;border-radius:6px;
    padding:7px 11px;cursor:pointer;font:inherit;margin:3px 4px 3px 0}
  .dg-btn:active{background:#24356a}
  .dg-log{max-height:190px;overflow:auto;background:#080d1c;border-radius:6px;padding:8px;
    color:#8fa0cc;white-space:pre-wrap;word-break:break-all}
  .dg-warn{color:#ffca5f}.dg-bad{color:#ff7b88}.dg-good{color:#54e08f}
  `;

  /* --------------------------------------------------------------- helpers */
  function kb(n) {
    if (n == null) return "—";
    if (n < 1024) return n + " B";
    if (n < 1048576) return (n / 1024).toFixed(0) + " KB";
    return (n / 1048576).toFixed(2) + " MB";
  }
  function h(tag, cls, txt) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (txt != null) e.textContent = txt;
    return e;
  }
  function kv(k, v, cls) {
    var r = h("div", "dg-kv");
    r.appendChild(h("span", null, k));
    r.appendChild(h("span", cls || null, String(v)));
    return r;
  }

  /* ------------------------------------------------- read the asset manifest
     sw.js is the single source of truth for what *should* be cached, so we
     parse its ASSETS array rather than keeping a second copy in sync here.  */
  function assetList() {
    return fetch("sw.js", { cache: "no-store" }).then(function (r) { return r.text(); })
      .then(function (t) {
        var m = /const ASSETS\s*=\s*\[([\s\S]*?)\]/.exec(t);
        var list = m ? (m[1].match(/"([^"]+)"/g) || []).map(function (s) { return s.slice(1, -1); }) : [];
        var v = /const APP_VERSION\s*=\s*"([^"]+)"/.exec(t);
        return { assets: list, version: v ? v[1] : "?" };
      })
      .catch(function () { return { assets: [], version: "?" }; });
  }

  /* --------------------------------------------------------- scan the cache */
  function scan() {
    if (scanning) return Promise.resolve();
    scanning = true;
    return Promise.all([assetList(), caches.keys()])
      .then(function (res) {
        var want = res[0].assets, keys = res[1];
        swInfo.fileVersion = res[0].version;
        var name = keys.filter(function (k) { return k.indexOf("neon-grid-") === 0; }).pop() || keys[0];
        swInfo.cache = name || "none";
        swInfo.allCaches = keys;
        if (!name) { cacheRows = want.map(function (u) { return { url: u, size: null, hit: false }; }); return; }
        return caches.open(name).then(function (c) {
          return Promise.all(want.map(function (u) {
            return c.match(u, { ignoreSearch: true }).then(function (r) {
              if (!r) return { url: u, size: null, hit: false };
              return r.clone().arrayBuffer()
                .then(function (b) { return { url: u, size: b.byteLength, hit: true }; })
                .catch(function () { return { url: u, size: null, hit: true }; });
            });
          })).then(function (rows) { cacheRows = rows; lastScan = Date.now(); });
        });
      })
      .then(function () { scanning = false; })
      .catch(function () { scanning = false; });
  }

  function readSW() {
    if (!("serviceWorker" in navigator)) { swInfo.state = "unsupported"; return Promise.resolve(); }
    return navigator.serviceWorker.getRegistration().then(function (reg) {
      if (!reg) { swInfo.state = "not registered"; return; }
      swInfo.scope = reg.scope;
      swInfo.state = reg.active ? "active" : reg.installing ? "installing" : reg.waiting ? "waiting" : "?";
      swInfo.waiting = !!reg.waiting;
      swInfo.controlled = !!navigator.serviceWorker.controller;
      return new Promise(function (resolve) {
        var w = reg.active || navigator.serviceWorker.controller;
        if (!w) return resolve();
        var ch = new MessageChannel();
        var done = setTimeout(resolve, 600);
        ch.port1.onmessage = function (e) {
          clearTimeout(done);
          var d = e.data;
          swInfo.version = (d && d.version) || d || "?";
          resolve();
        };
        w.postMessage({ type: "GET_INFO" }, [ch.port2]);
      });
    }).catch(function () {});
  }

  /* -------------------------------------------------------------- rendering */
  function renderCache(body) {
    var hit = cacheRows.filter(function (r) { return r.hit; });
    var total = hit.reduce(function (a, r) { return a + (r.size || 0); }, 0);
    var pct = cacheRows.length ? Math.round(hit.length / cacheRows.length * 100) : 0;

    var c = h("div", "dg-card");
    c.appendChild(kv("service worker", swInfo.state,
      swInfo.state === "active" ? "dg-good" : "dg-warn"));
    c.appendChild(kv("running version", swInfo.version));
    c.appendChild(kv("version in sw.js", swInfo.fileVersion || "?",
      (swInfo.fileVersion && swInfo.version !== "?" && swInfo.fileVersion !== swInfo.version)
        ? "dg-bad" : null));
    c.appendChild(kv("controlling page", swInfo.controlled ? "yes" : "no",
      swInfo.controlled ? "dg-good" : "dg-warn"));
    c.appendChild(kv("cache name", swInfo.cache));
    if (swInfo.allCaches && swInfo.allCaches.length > 1)
      c.appendChild(kv("stale caches", swInfo.allCaches.length - 1, "dg-warn"));
    if (swInfo.waiting) c.appendChild(kv("update waiting", "yes — reload to apply", "dg-warn"));
    body.appendChild(c);

    var p = h("div", "dg-card");
    p.appendChild(kv("cached", hit.length + " / " + cacheRows.length + "  (" + pct + "%)",
      pct === 100 ? "dg-good" : "dg-warn"));
    p.appendChild(kv("total size", kb(total)));
    var bar = h("div", "dg-bar"); var fill = h("i"); fill.style.width = pct + "%";
    bar.appendChild(fill); p.appendChild(bar);
    var rc = h("button", "dg-btn", "Re-scan");
    rc.onclick = function () { scan().then(draw); };
    var rf = h("button", "dg-btn", "Force refresh cache");
    rf.onclick = function () {
      if (!confirm("Delete all caches and reload? Files download again.")) return;
      caches.keys().then(function (ks) { return Promise.all(ks.map(function (k) { return caches.delete(k); })); })
        .then(function () { location.reload(); });
    };
    p.appendChild(rc); p.appendChild(rf);
    body.appendChild(p);

    var list = h("div", "dg-card");
    cacheRows.forEach(function (r) {
      var row = h("div", "dg-row");
      row.appendChild(h("div", "dg-dot " + (r.hit ? "ok" : "miss")));
      row.appendChild(h("div", "n", r.url.replace(/^\.\//, "")));
      row.appendChild(h("div", "s", r.hit ? kb(r.size) : "MISSING"));
      list.appendChild(row);
    });
    body.appendChild(list);
  }

  function renderMusic(body) {
    var M = window.GameMusic;
    var c = h("div", "dg-card");
    if (!M) {
      c.appendChild(kv("music.js", "NOT LOADED", "dg-bad"));
      c.appendChild(h("div", null, "index.html needs <script src=\"music.js\"></script>"));
      body.appendChild(c); return;
    }
    var s = M.state();
    c.appendChild(kv("muted", s.on ? "no" : "YES — music is off", s.on ? "dg-good" : "dg-bad"));
    c.appendChild(kv("audio unlocked", s.unlocked ? "yes" : "no — needs a tap", s.unlocked ? "dg-good" : "dg-warn"));
    c.appendChild(kv("current track", s.current || "none"));
    if (s.pending) c.appendChild(kv("waiting to start", s.pending, "dg-warn"));
    c.appendChild(kv("volume", s.volume));
    if (s.lastError)
      c.appendChild(kv("last error", s.lastError.text + " (" + (s.lastError.src || "").split("/").pop() + ")", "dg-bad"));
    body.appendChild(c);

    s.decks.forEach(function (d) {
      var card = h("div", "dg-card");
      card.appendChild(kv("deck " + d.deck + (d.live ? "  ← live" : ""), d.src || "empty"));
      card.appendChild(kv("playing", d.paused ? "paused" : "yes", d.paused ? null : "dg-good"));
      card.appendChild(kv("position", d.time + "s / " + (d.duration || "?") + "s"));
      card.appendChild(kv("volume", d.volume));
      card.appendChild(kv("readyState", d.readyState + ["  nothing", "  metadata", "  current", "  future", "  enough"][d.readyState],
        d.readyState >= 2 ? "dg-good" : "dg-warn"));
      card.appendChild(kv("networkState", d.networkState + (d.networkState === 3 ? "  NO SOURCE" : ""),
        d.networkState === 3 ? "dg-bad" : null));
      if (d.error) card.appendChild(kv("element error", d.error, "dg-bad"));
      body.appendChild(card);
    });

    var t = h("div", "dg-card");
    t.appendChild(h("div", null, "Test a track — you should hear it immediately:"));
    ["menu", "classic", "blitz", "zen", "mine", "butterfly", "icestorm", "poker"].forEach(function (n) {
      var b = h("button", "dg-btn", n);
      b.onclick = function () { M.unlock(); M.play(n); setTimeout(draw, 400); };
      t.appendChild(b);
    });
    var st = h("button", "dg-btn", "stop");
    st.onclick = function () { M.stop(); setTimeout(draw, 300); };
    t.appendChild(st);
    var probe = h("button", "dg-btn", "Probe files");
    probe.onclick = function () { probeTracks(t); };
    t.appendChild(probe);
    body.appendChild(t);

    var log = h("div", "dg-card");
    log.appendChild(h("div", null, "Recent audio events:"));
    var pre = h("div", "dg-log", M.events().slice(-25).reverse().map(function (e) {
      return new Date(e.t).toLocaleTimeString() + "  " + e.kind + "  " + e.detail;
    }).join("\n") || "(none yet)");
    log.appendChild(pre);
    body.appendChild(log);
  }

  /* fetch each track head-on to prove the file is really reachable */
  function probeTracks(container) {
    var out = h("div", "dg-log", "probing…");
    container.appendChild(out);
    var names = ["menu", "classic", "blitz", "zen", "mine", "butterfly", "icestorm", "poker"];
    var base = window.GameMusic ? window.GameMusic.base() : "music/";
    Promise.all(names.map(function (n) {
      var url = base + n + ".mp3";
      return fetch(url).then(function (r) {
        return r.ok ? r.arrayBuffer().then(function (b) {
          return url + "  " + r.status + "  " + kb(b.byteLength);
        }) : url + "  HTTP " + r.status;
      }).catch(function (e) { return url + "  FAILED  " + e.message; });
    })).then(function (lines) { out.textContent = lines.join("\n"); });
  }

  function renderStorage(body) {
    var c = h("div", "dg-card");
    c.appendChild(kv("page URL", location.href));
    c.appendChild(kv("origin", location.origin));
    c.appendChild(kv("online", navigator.onLine ? "yes" : "no", navigator.onLine ? "dg-good" : "dg-warn"));
    c.appendChild(kv("standalone (installed)", window.matchMedia("(display-mode: standalone)").matches ? "yes" : "no"));
    body.appendChild(c);
    if (navigator.storage && navigator.storage.estimate) {
      navigator.storage.estimate().then(function (e) {
        var d = h("div", "dg-card");
        d.appendChild(kv("storage used", kb(e.usage)));
        d.appendChild(kv("storage quota", kb(e.quota)));
        var pct = e.quota ? Math.round(e.usage / e.quota * 100) : 0;
        var bar = h("div", "dg-bar"); var f = h("i"); f.style.width = Math.max(1, pct) + "%";
        bar.appendChild(f); d.appendChild(bar);
        d.appendChild(kv("used", pct + "%"));
        body.appendChild(d);
      });
    }
  }

  function draw() {
    if (!root) return;
    var body = root.querySelector(".dg-body");
    body.innerHTML = "";
    if (tab === "cache") renderCache(body);
    else if (tab === "music") renderMusic(body);
    else renderStorage(body);
    Array.prototype.forEach.call(root.querySelectorAll(".dg-tab"), function (b) {
      b.classList.toggle("on", b.dataset.tab === tab);
    });
  }

  /* ------------------------------------------------------------ open / close */
  function open() {
    if (root) return;
    var style = h("style"); style.textContent = CSS; document.head.appendChild(style);
    root = h("div"); root.id = "diagPanel";
    var head = h("div", "dg-head");
    head.appendChild(h("div", "dg-title", "DIAGNOSTICS"));
    var x = h("button", "dg-x", "Close"); x.onclick = close; head.appendChild(x);
    root.appendChild(head);
    var tabs = h("div", "dg-tabs");
    [["cache", "Cache"], ["music", "Music"], ["storage", "Device"]].forEach(function (t) {
      var b = h("button", "dg-tab", t[1]); b.dataset.tab = t[0];
      b.onclick = function () { tab = t[0]; draw(); };
      tabs.appendChild(b);
    });
    root.appendChild(tabs);
    root.appendChild(h("div", "dg-body"));
    document.body.appendChild(root);
    readSW().then(scan).then(draw);
    timer = setInterval(function () {
      if (tab === "music") draw();                 /* music state moves fast   */
      else if (Date.now() - lastScan > 2000) scan().then(draw);   /* cache slow */
    }, 700);
  }
  function close() {
    if (timer) clearInterval(timer);
    timer = null;
    if (root && root.parentNode) root.parentNode.removeChild(root);
    root = null;
  }

  if (location.hash.indexOf("diag") !== -1) {
    if (document.body) open();
    else window.addEventListener("DOMContentLoaded", open);
  }
  window.addEventListener("hashchange", function () {
    if (location.hash.indexOf("diag") !== -1) open();
  });

  return { open: open, close: close, scan: scan, state: function () { return { swInfo: swInfo, rows: cacheRows }; } };
})();
