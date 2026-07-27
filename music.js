/* ============================================================================
   music.js - streaming background music for Gem Drop
   ----------------------------------------------------------------------------
   Deliberately separate from audio.js. Short clips (voices, SFX) belong in Web
   Audio, where they are decoded once and fired with no latency. Music is the
   opposite problem: a 3-minute track decodes to ~30MB of raw samples, so we
   stream it with <audio> instead and let the browser handle looping. <audio>
   also plays happily from file:// , which fetch + decodeAudioData does not.

   EXCEPT on iOS. The old iOS workaround routed the <audio> element through a
   Web Audio GainNode (createMediaElementSource) because iOS ignores
   HTMLMediaElement.volume. That graph is what caused the mobile warble: the
   media element's clock and the AudioContext's clock drift apart, and every
   30-60s WebKit "corrects" the drift by resampling - heard as the music
   going slow and fast at once, settling, then doing it again (worst while a
   game's own SFX context is running alongside). So on iOS we now skip the
   element entirely and play music as decoded Web Audio buffers: one clock,
   no drift, gapless loops, real gain fades. A modern iPhone decodes a 3-min
   mp3 in well under a second and holds a few tracks comfortably; we cap the
   cache at 4 decoded tracks. If fetch/decode ever fails we fall back to the
   plain <audio> element (volume then fixed at 1.0 on iOS - audible beats
   silent).

   Usage:
     GameMusic.play("classic")        switch track, crossfading from the old one
     GameMusic.sting("lose_classic")  one-shot over the top (game-over stinger)
     GameMusic.stop()                 fade out
     GameMusic.setMuted(true)         wire this to your existing mute button
     GameMusic.toggle()               flip mute, returns the new "is on" state
     GameMusic.isOn()                 true when unmuted
     GameMusic.setVolume(0.5)         0..1

   Tracks live in ./music/<name>.mp3 - change BASE below if you move them.
   ==========================================================================*/
window.GameMusic = (function () {
  "use strict";

  var BASE = "music/";
  var FADE_MS = 700;      /* crossfade length when switching modes */
  var VOLUME = 0.45;      /* music sits under the sound effects */

  var on = true;          /* false once the player mutes music */
  var current = null;     /* name of the track that should be playing */
  var deck = [];          /* two <audio> elements we alternate between */
  var live = 0;           /* which deck is currently the audible one */
  var unlocked = false;   /* browsers block playback until a user gesture */
  var pending = null;     /* track requested before that gesture arrived */
  var stinger = null;     /* built in decks() so it gets unlocked too */
  var fades = [];

  try { var saved = localStorage.getItem("gemdrop-music"); if (saved !== null) on = saved === "1"; }
  catch (e) { /* private mode / sandboxed iframe: just default to on */ }

  var lastError = null, events = [];
  function log(kind, detail) {
    events.push({ t: Date.now(), kind: kind, detail: detail || "" });
    if (events.length > 60) events.shift();
  }

  var IOS = /iP(hone|ad|od)/.test(navigator.userAgent) ||
            (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

  var AC = null;
  function actx() {
    if (AC) return AC;
    try {
      var C = window.AudioContext || window.webkitAudioContext;
      if (!C) return null;
      AC = new C();
    } catch (e) { AC = null; }
    return AC;
  }
  /* iOS parks a context in "suspended" before the first gesture and in
     "interrupted" after a phone call / Siri / route change - resume from
     any not-running state, not just "suspended". */
  function acAwake() {
    if (AC && AC.state !== "running") { try { AC.resume(); } catch (e) {} }
  }

  /* ---- iOS: decoded-buffer engine ---------------------------------- */
  var BUF = IOS ? { bufs: {}, order: [], cur: null, sting: null,
                    loading: null, token: 0, fellBack: false } : null;
  function useBuffers() { return !!BUF && !BUF.fellBack; }

  function loadBuf(name, cb) {
    var c = actx();
    if (!c) return cb(null, "no AudioContext");
    if (BUF.bufs[name]) return cb(BUF.bufs[name], null);
    fetch(BASE + name + ".mp3")
      .then(function (r) {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.arrayBuffer();
      })
      .then(function (ab) {
        return new Promise(function (res, rej) {
          /* callback form: oldest webkit has no promise decodeAudioData */
          c.decodeAudioData(ab, res, rej);
        });
      })
      .then(function (b) {
        BUF.bufs[name] = b;
        BUF.order.push(name);
        while (BUF.order.length > 4) delete BUF.bufs[BUF.order.shift()];
        cb(b, null);
      })
      .catch(function (err) {
        cb(null, (err && (err.message || err.name)) || "load failed");
      });
  }

  function fadeOutNode(node, t, f) {
    try {
      node.gain.gain.cancelScheduledValues(t);
      node.gain.gain.setValueAtTime(node.gain.gain.value, t);
      node.gain.gain.linearRampToValueAtTime(0.0001, t + f);
      node.src.stop(t + f + 0.05);
    } catch (e) { try { node.src.stop(); } catch (e2) {} }
  }
  function killNode(node) {
    try { node.gain.gain.cancelScheduledValues(0); node.gain.gain.value = 0; } catch (e) {}
    try { node.src.stop(); } catch (e) {}
  }
  function stopBuf(fadeMs) {
    BUF.token++;          /* invalidate any load still in flight */
    BUF.loading = null;
    if (!BUF.cur) return;
    if (AC) fadeOutNode(BUF.cur, AC.currentTime, (fadeMs || FADE_MS) / 1000);
    else killNode(BUF.cur);
    BUF.cur = null;
  }

  function playBuf(name) {
    var c = actx();
    if (!c) { BUF.fellBack = true; return playEl(name); }
    acAwake();
    if (BUF.cur && BUF.cur.name === name) return;   /* already on it */
    if (BUF.loading === name) return;               /* already fetching it */
    BUF.loading = name;
    var my = ++BUF.token;
    log("play", name);
    loadBuf(name, function (b, err) {
      if (BUF.loading === name) BUF.loading = null;
      if (!b) {
        lastError = { src: BASE + name + ".mp3", code: 0, text: "buffer: " + err };
        log("buf-fallback", name);
        BUF.fellBack = true;   /* stream via <audio> instead; iOS then plays at
                                  fixed volume, which beats silence */
        if (current === name && on) playEl(name);
        return;
      }
      if (my !== BUF.token || current !== name || !on) return;  /* superseded */
      var t = c.currentTime, f = FADE_MS / 1000;
      if (BUF.cur) fadeOutNode(BUF.cur, t, f);
      var src = c.createBufferSource();
      src.buffer = b;
      src.loop = true;        /* buffer loops are gapless, unlike mp3 <audio> */
      var g = c.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.linearRampToValueAtTime(VOLUME, t + f);
      src.connect(g); g.connect(c.destination);
      try { src.start(t); } catch (e) {}
      BUF.cur = { name: name, src: src, gain: g, startedAt: t, dur: b.duration };
      log("playing", name + ".mp3");
    });
  }

  function stingBuf(name) {
    var c = actx();
    if (!c) return;
    acAwake();
    /* the sting replaces the theme rather than sitting on top of it */
    if (BUF.cur) { BUF.token++; BUF.loading = null;
                   fadeOutNode(BUF.cur, c.currentTime, 0.4); BUF.cur = null; }
    log("sting", name);
    loadBuf(name, function (b, err) {
      if (!b) { lastError = { src: BASE + name + ".mp3", code: 0, text: "sting: " + err }; return; }
      if (!on) return;
      if (BUF.sting) killNode(BUF.sting);
      var src = c.createBufferSource();
      src.buffer = b;
      var g = c.createGain();
      g.gain.value = Math.min(1, VOLUME * 1.8);
      src.connect(g); g.connect(c.destination);
      try { src.start(c.currentTime); } catch (e) {}
      BUF.sting = { name: name, src: src, gain: g, startedAt: c.currentTime, dur: b.duration };
    });
  }

  /* ---- everywhere else: plain <audio> elements ---------------------- */
  function setLevel(a, v) { a.volume = v; }
  function levelOf(a) { return a.volume; }
  function el(tag) {
    var a = new Audio();
    a.loop = true;
    a.preload = "none";   /* don't pull 10MB off disk until a track is asked for */
    a.volume = 0;
    a.setAttribute("playsinline", "");   /* iOS: don't hijack into a player UI */
    a.dataset.deck = tag;
    ["error", "stalled", "abort", "canplay", "playing", "ended"].forEach(function (ev) {
      a.addEventListener(ev, function () {
        if (ev === "error") {
          var c = a.error ? a.error.code : 0;
          lastError = { src: a.src, code: c,
            text: ["", "aborted", "network", "decode", "src not supported"][c] || "?" };
        }
        log(ev, (a.src || "").split("/").pop());
      });
    });
    /* some iOS versions refuse to play elements that aren't in the document */
    a.style.display = "none";
    if (document.body) document.body.appendChild(a);
    else window.addEventListener("DOMContentLoaded", function () { document.body.appendChild(a); });
    return a;
  }
  function decks() {
    if (!deck.length) {
      deck = [el("a"), el("b")];
      stinger = el("sting");
      stinger.loop = false;
    }
    return deck;
  }
  function clearFades() {
    for (var i = 0; i < fades.length; i++) clearInterval(fades[i]);
    fades = [];
  }
  /* volume ramps by hand: Audio has no scheduling like Web Audio does */
  function fade(a, to, ms, done) {
    var from = levelOf(a), t0 = performance.now();
    var id = setInterval(function () {
      var k = Math.min(1, (performance.now() - t0) / ms);
      var v = from + (to - from) * k;
      setLevel(a, v < 0 ? 0 : v > 1 ? 1 : v);
      if (k >= 1) { clearInterval(id); if (done) done(); }
    }, 33);
    fades.push(id);
    return id;
  }

  function play(name) {
    if (!name) return;
    current = name;
    if (!on) return;                      /* remember it, start when unmuted */
    if (useBuffers()) return playBuf(name);
    playEl(name);
  }

  function playEl(name) {
    var d = decks();
    var cur = d[live], nxt = d[1 - live];
    if (cur.src && cur.src.indexOf(BASE + name + ".mp3") !== -1 && !cur.paused) return;
    clearFades();
    nxt.src = BASE + name + ".mp3";
    nxt.preload = "auto";
    nxt.currentTime = 0;
    setLevel(nxt, 0);
    log("play", name);
    var p = nxt.play();
    if (p && p.catch) p.catch(function (err) {
      lastError = { src: nxt.src, code: 0, text: "play() rejected: " + (err && err.name) };
      log("rejected", name);
      /* Refused - almost always "no user gesture in this document yet".
         Remember the track; the gesture handler below retries it on the next
         tap. No flags to get stuck in the wrong state. */
      pending = name;
    });
    fade(nxt, VOLUME, FADE_MS);
    if (cur.src && !cur.paused) fade(cur, 0, FADE_MS, function () { cur.pause(); });
    live = 1 - live;
  }

  function stop() {
    clearFades();
    current = null;
    if (BUF) stopBuf();
    for (var i = 0; i < deck.length; i++) {
      (function (a) { if (a.src && !a.paused) fade(a, 0, FADE_MS, function () { a.pause(); }); })(deck[i]);
    }
  }

  /* short one-shot laid over the music - the mode's game-over sting */
  function sting(name) {
    if (!on) return;
    if (useBuffers()) return stingBuf(name);
    decks();
    /* A game-over sting replaces the theme rather than sitting on top of it,
       the way B3 does it. The menu track comes back when the player exits. */
    for (var i = 0; i < deck.length; i++) {
      if (deck[i].src && !deck[i].paused) (function (a) {
        fade(a, 0, 400, function () { a.pause(); });
      })(deck[i]);
    }
    stinger.src = BASE + name + ".mp3";
    setLevel(stinger, Math.min(1, VOLUME * 1.8));
    log("sting", name);
    var p = stinger.play();
    if (p && p.catch) p.catch(function (e) {
      lastError = { src: stinger.src, code: 0, text: "sting rejected: " + (e && e.name) };
    });
  }

  function setMuted(m) {
    on = !m;
    try { localStorage.setItem("gemdrop-music", on ? "1" : "0"); } catch (e) {}
    if (!on) {
      if (BUF) {
        stopBuf(120);
        if (BUF.sting) { killNode(BUF.sting); BUF.sting = null; }
      }
      clearFades();
      for (var i = 0; i < deck.length; i++) { deck[i].pause(); setLevel(deck[i], 0); }
      if (stinger) stinger.pause();
    } else if (current) {
      var want = current; current = null; play(want);
    }
    return on;
  }

  /* the first tap anywhere satisfies the browser's autoplay gesture rule */
  function unlockDecks() {
    /* iOS unlocks each media element separately: an element that never had
       play() called during a gesture stays silent forever, and we crossfade
       between two of them. */
    var d = decks().concat(stinger ? [stinger] : []);
    for (var i = 0; i < d.length; i++) {
      (function (a) {
        if (a._unlocked) return;
        a._unlocked = true;
        try {
          a.muted = true;
          var p = a.play();
          if (p && p.then) p.then(function () { a.pause(); a.muted = false; })
                            .catch(function () { a.muted = false; });
          else { a.pause(); a.muted = false; }
        } catch (e) { a.muted = false; }
      })(d[i]);
    }
  }
  /* Runs on every tap. If something should be playing but isn't, start it.
     Deliberately stateless: no "already unlocked" short-circuit, because that
     is exactly what stranded a refused track until some later interaction. */
  function onGesture() {
    unlocked = true;
    acAwake();
    if (useBuffers()) {
      /* buffer engine: nothing to unlock beyond the context; if a track was
         asked for but nothing is live, (re)start it - playBuf dedupes */
      var wantB = pending || current;
      if (!BUF.cur && wantB) { pending = null; play(wantB); }
      return;
    }
    unlockDecks();
    var d = decks();
    var silent = true;
    for (var i = 0; i < d.length; i++) if (!d[i].paused && levelOf(d[i]) > 0) silent = false;
    if (!silent) return;
    var want = pending || current;
    if (want) { pending = null; current = null; play(want); }
  }
  function unlock() { onGesture(); }
  ["pointerdown", "touchend", "keydown", "click"].forEach(function (ev) {
    window.addEventListener(ev, onGesture, { passive: true });
  });

  /* Backgrounding the app should silence it. Without this the track keeps
     playing from the app switcher, and on iOS it can even hold the audio
     session open after the app is gone from view. */
  var resumeOnReturn = false;
  function goAway() {
    resumeOnReturn = false;
    if (useBuffers()) {
      /* suspending the context freezes the source in place; resume picks the
         loop back up exactly where it left off */
      if (BUF.cur && AC && AC.state === "running") {
        resumeOnReturn = true;
        try { AC.suspend(); } catch (e) {}
      }
      return;
    }
    var d = decks();
    for (var i = 0; i < d.length; i++) {
      if (d[i].src && !d[i].paused) { resumeOnReturn = true; d[i].pause(); }
    }
    if (stinger && !stinger.paused) stinger.pause();
  }
  function comeBack() {
    if (!on || !resumeOnReturn) return;
    resumeOnReturn = false;
    if (useBuffers()) { acAwake(); return; }
    var a = decks()[live];
    if (a && a.src) { var p = a.play(); if (p && p.catch) p.catch(function () {}); }
  }
  document.addEventListener("visibilitychange", function () {
    if (document.hidden) goAway(); else comeBack();
  });
  window.addEventListener("pagehide", goAway);
  window.addEventListener("blur", function () { if (document.hidden) goAway(); });

  return {
    play: play,
    stop: stop,
    sting: sting,
    setMuted: setMuted,
    toggle: function () { return setMuted(on); },
    isOn: function () { return on; },
    setVolume: function (v) {
      VOLUME = Math.max(0, Math.min(1, v));
      if (BUF && AC) {
        if (BUF.cur) {
          try {
            var g = BUF.cur.gain.gain, t = AC.currentTime;
            g.cancelScheduledValues(t);
            g.setValueAtTime(g.value, t);
            g.linearRampToValueAtTime(VOLUME, t + 0.05);
          } catch (e) {}
        }
        if (BUF.sting) { try { BUF.sting.gain.gain.value = Math.min(1, VOLUME * 1.8); } catch (e) {} }
      }
      /* element path: apply to whichever deck is audible */
      for (var i = 0; i < deck.length; i++)
        if (deck[i] && !deck[i].paused) setLevel(deck[i], VOLUME);
      if (stinger && !stinger.paused) setLevel(stinger, Math.min(1, VOLUME * 1.8));
    },
    unlock: unlock,
    current: function () { return current; },
    base: function () { return BASE; },
    lastError: function () { return lastError; },
    events: function () { return events.slice(); },
    state: function () {
      if (useBuffers()) {
        var c = AC, now = c ? c.currentTime : 0, ds = [];
        if (BUF.cur) {
          var pos = BUF.cur.dur ? (now - BUF.cur.startedAt) % BUF.cur.dur : 0;
          ds.push({
            deck: 0, live: true,
            src: BUF.cur.name + ".mp3",
            paused: !(c && c.state === "running"),
            volume: Math.round((BUF.cur.gain ? BUF.cur.gain.gain.value : 0) * 100) / 100,
            time: Math.round(pos * 10) / 10,
            duration: Math.round(BUF.cur.dur || 0),
            readyState: 4, networkState: 1, error: 0
          });
        }
        return {
          on: on, unlocked: unlocked, current: current, pending: pending,
          volume: VOLUME,
          levelPath: "webaudio buffers (iOS)",
          acState: c ? c.state : "none",
          loading: BUF.loading, cached: BUF.order.slice(),
          decks: ds, lastError: lastError
        };
      }
      var d = decks();
      return {
        on: on, unlocked: unlocked, current: current, pending: pending,
        volume: VOLUME,
        levelPath: "element.volume",
        acState: AC ? AC.state : "none",
        decks: d.map(function (a, i) {
          return {
            deck: i, live: i === live,
            src: (a.src || "").split("/").pop(),
            paused: a.paused, volume: Math.round(levelOf(a) * 100) / 100,
            time: Math.round(a.currentTime * 10) / 10,
            duration: isFinite(a.duration) ? Math.round(a.duration) : 0,
            readyState: a.readyState, networkState: a.networkState,
            error: a.error ? a.error.code : 0
          };
        }),
        lastError: lastError
      };
    }
  };
})();
