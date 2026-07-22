/* ============================================================================
   music.js - streaming background music for Gem Drop
   ----------------------------------------------------------------------------
   Deliberately separate from audio.js. Short clips (voices, SFX) belong in Web
   Audio, where they are decoded once and fired with no latency. Music is the
   opposite problem: a 3-minute track decodes to ~30MB of raw samples, so we
   stream it with <audio> instead and let the browser handle looping. <audio>
   also plays happily from file:// , which fetch + decodeAudioData does not.

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
  var stinger = null;   /* built in decks() so it gets unlocked too */
  var fades = [];

  try { var saved = localStorage.getItem("gemdrop-music"); if (saved !== null) on = saved === "1"; }
  catch (e) { /* private mode / sandboxed iframe: just default to on */ }

  var lastError = null, events = [];
  function log(kind, detail) {
    events.push({ t: Date.now(), kind: kind, detail: detail || "" });
    if (events.length > 60) events.shift();
  }
  /* ---- volume on iOS -------------------------------------------------
     iOS ignores HTMLMediaElement.volume outright - it is reserved for the
     hardware buttons - so a slider that sets .volume does nothing there while
     pause() still works. Routing the element through a Web Audio GainNode
     gives us a level control iOS does honour. If the graph can't be built
     (older browser, or the media is cross-origin without CORS) we fall back to
     .volume, which is correct everywhere except iOS.                        */
  var AC = null, gainOf = new WeakMap(), graphOK = true;
  function actx() {
    if (AC) return AC;
    try {
      var C = window.AudioContext || window.webkitAudioContext;
      if (!C) { graphOK = false; return null; }
      AC = new C();
    } catch (e) { graphOK = false; AC = null; }
    return AC;
  }
  function wire(a) {
    if (!graphOK || gainOf.has(a)) return gainOf.get(a) || null;
    var c = actx();
    if (!c) return null;
    try {
      var src = c.createMediaElementSource(a);
      var g = c.createGain();
      g.gain.value = VOLUME;
      src.connect(g); g.connect(c.destination);
      gainOf.set(a, g);
      return g;
    } catch (e) { graphOK = false; return null; }   /* fall back to .volume */
  }
  function setLevel(a, v) {
    var g = gainOf.get(a);
    if (g) { try { g.gain.value = v; return; } catch (e) {} }
    a.volume = v;            /* non-iOS path, or graph unavailable */
  }
  function levelOf(a) {
    var g = gainOf.get(a);
    return g ? g.gain.value : a.volume;
  }
  function el(tag) {
    var a = new Audio();
    a.crossOrigin = "anonymous";   /* required before src for the graph */
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
          /* codes 2 (network) and 4 (unsupported) are what a blocked CORS load
             looks like from here */
          if (a.crossOrigin && (c === 2 || c === 4) && a.src) {
            var nm = a.src.split("/").pop().replace(".mp3", "");
            recoverNoCORS(a, nm);
          }
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

  /* If crossOrigin made the load fail (no CORS headers on the host), retry the
     same track without it. Volume control is then .volume-only - wrong on iOS,
     but audible everywhere, which beats silence. */
  function recoverNoCORS(a, name) {
    if (a._noCors) return false;
    a._noCors = true;
    graphOK = false;
    log("cors-retry", name);
    var fresh = el(a.dataset ? a.dataset.deck : "r");
    fresh.crossOrigin = null;
    var i = deck.indexOf(a);
    if (i >= 0) deck[i] = fresh; else if (a === stinger) stinger = fresh;
    fresh.src = BASE + name + ".mp3";
    fresh.loop = a.loop;
    fresh.volume = VOLUME;
    var p = fresh.play();
    if (p && p.catch) p.catch(function () { pending = name; });
    return true;
  }
  function play(name) {
    if (!name) return;
    current = name;
    if (!on) return;                      /* remember it, start when unmuted */
    var d = decks();
    var cur = d[live], nxt = d[1 - live];
    if (cur.src && cur.src.indexOf(BASE + name + ".mp3") !== -1 && !cur.paused) return;
    clearFades();
    nxt.src = BASE + name + ".mp3";
    nxt.preload = "auto";
    nxt.currentTime = 0;
    wire(nxt); setLevel(nxt, 0);
    log("play", name);
    var p = nxt.play();
    if (p && p.catch) p.catch(function (err) {
      lastError = { src: nxt.src, code: 0, text: "play() rejected: " + (err && err.name) };
      log("rejected", name);
      /* The browser refused, almost always because this document hasn't had a
         user gesture yet. Un-arm so the next tap retries instead of the track
         being lost - otherwise unlock() sees unlocked===true, returns early,
         and nothing ever plays that track again. */
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
    for (var i = 0; i < deck.length; i++) {
      (function (a) { if (a.src && !a.paused) fade(a, 0, FADE_MS, function () { a.pause(); }); })(deck[i]);
    }
  }

  /* short one-shot laid over the music - the mode's game-over sting */
  function sting(name) {
    if (!on) return;
    decks();
    /* A game-over sting replaces the theme rather than sitting on top of it,
       the way B3 does it. The menu track comes back when the player exits. */
    for (var i = 0; i < deck.length; i++) {
      if (deck[i].src && !deck[i].paused) (function (a) {
        fade(a, 0, 400, function () { a.pause(); });
      })(deck[i]);
    }
    stinger.src = BASE + name + ".mp3";
    wire(stinger); setLevel(stinger, Math.min(1, VOLUME * 1.8));
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
    if (AC && AC.state === "suspended") { try { AC.resume(); } catch (e) {} }
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
    var d = decks();
    resumeOnReturn = false;
    for (var i = 0; i < d.length; i++) {
      if (d[i].src && !d[i].paused) { resumeOnReturn = true; d[i].pause(); }
    }
    if (stinger && !stinger.paused) stinger.pause();
  }
  function comeBack() {
    if (!on || !resumeOnReturn) return;
    resumeOnReturn = false;
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
      /* apply to whichever deck is audible - via gain on iOS, .volume elsewhere */
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
      var d = decks();
      return {
        on: on, unlocked: unlocked, current: current, pending: pending,
        volume: VOLUME,
        levelPath: graphOK ? "gain node (iOS-safe)" : "element.volume",
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
