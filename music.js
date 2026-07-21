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
  var stinger = null;
  var fades = [];

  try { var saved = localStorage.getItem("gemdrop-music"); if (saved !== null) on = saved === "1"; }
  catch (e) { /* private mode / sandboxed iframe: just default to on */ }

  function el() {
    var a = new Audio();
    a.loop = true;
    a.preload = "none";   /* don't pull 10MB off disk until a track is asked for */
    a.volume = 0;
    return a;
  }
  function decks() {
    if (!deck.length) deck = [el(), el()];
    return deck;
  }
  function clearFades() {
    for (var i = 0; i < fades.length; i++) clearInterval(fades[i]);
    fades = [];
  }
  /* volume ramps by hand: Audio has no scheduling like Web Audio does */
  function fade(a, to, ms, done) {
    var from = a.volume, t0 = performance.now();
    var id = setInterval(function () {
      var k = Math.min(1, (performance.now() - t0) / ms);
      var v = from + (to - from) * k;
      a.volume = v < 0 ? 0 : v > 1 ? 1 : v;
      if (k >= 1) { clearInterval(id); if (done) done(); }
    }, 33);
    fades.push(id);
    return id;
  }

  function play(name) {
    if (!name) return;
    current = name;
    if (!on) return;                      /* remember it, start when unmuted */
    if (!unlocked) { pending = name; return; }
    var d = decks();
    var cur = d[live], nxt = d[1 - live];
    if (cur.src && cur.src.indexOf(BASE + name + ".mp3") !== -1 && !cur.paused) return;
    clearFades();
    nxt.src = BASE + name + ".mp3";
    nxt.preload = "auto";
    nxt.currentTime = 0;
    nxt.volume = 0;
    var p = nxt.play();
    if (p && p.catch) p.catch(function () { /* autoplay refused; retry on next gesture */ });
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
    if (!on || !unlocked) return;
    if (!stinger) { stinger = new Audio(); stinger.loop = false; }
    stinger.src = BASE + name + ".mp3";
    stinger.volume = Math.min(1, VOLUME * 1.6);
    var p = stinger.play();
    if (p && p.catch) p.catch(function () {});
  }

  function setMuted(m) {
    on = !m;
    try { localStorage.setItem("gemdrop-music", on ? "1" : "0"); } catch (e) {}
    if (!on) {
      clearFades();
      for (var i = 0; i < deck.length; i++) { deck[i].pause(); deck[i].volume = 0; }
      if (stinger) stinger.pause();
    } else if (current) {
      var want = current; current = null; play(want);
    }
    return on;
  }

  /* the first tap anywhere satisfies the browser's autoplay gesture rule */
  function unlock() {
    if (unlocked) return;
    unlocked = true;
    var want = pending || current;
    if (want) { current = null; play(want); }
    pending = null;
  }
  ["pointerdown", "touchend", "keydown"].forEach(function (ev) {
    window.addEventListener(ev, unlock, { passive: true });
  });

  return {
    play: play,
    stop: stop,
    sting: sting,
    setMuted: setMuted,
    toggle: function () { return setMuted(on); },
    isOn: function () { return on; },
    setVolume: function (v) {
      VOLUME = Math.max(0, Math.min(1, v));
      if (deck[live] && !deck[live].paused) deck[live].volume = VOLUME;
    },
    unlock: unlock,
    current: function () { return current; }
  };
})();
