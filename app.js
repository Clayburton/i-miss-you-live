/* ============================================================
   i miss you — live lyric video engine
   Reads the audio clock every frame and renders the cue sheet
   (CUES) from cues.js as live DOM on a pure white stage.
   ============================================================ */
(function () {
  "use strict";

  const stage     = document.getElementById("stage");
  const cueLayer  = document.getElementById("cueLayer");
  const audio     = document.getElementById("song");
  const landing   = document.getElementById("landing");
  const endcard   = document.getElementById("endcard");
  const playBtn   = document.getElementById("playBtn");
  const replayBtn = document.getElementById("replayBtn");
  const toastEl   = document.getElementById("toast");
  const cursorEl  = document.getElementById("emojiCursor");
  const cursorImg = document.getElementById("emojiCursorImg");

  const ROLE_CLASS = {
    sans: "r-sans", serif: "r-serif", serifIt: "r-serifIt", mono: "r-mono", didone: "r-didone",
  };
  const ANCHOR_XY = {
    c:  [-50, -50], t:  [-50, 0],   b:  [-50, -100],
    l:  [0,   -50], r:  [-100, -50],
    tl: [0,    0],  tr: [-100, 0],  bl: [0, -100], br: [-100, -100],
  };
  const prefersReduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  let running = false;
  let clockOverride = null;                 // debug: render a fixed timestamp
  // visual-vs-audio sync nudge (seconds). MP3 adds ~20ms of encoder padding, so the
  // heard audio lags the clock slightly; render a touch behind to match. Tunable with [ ].
  let syncOffset = parseFloat(localStorage.getItem("imy_sync") || "-0.02");
  // pointer interaction state
  const dragState = {};                              // idx -> {dx,dy} while a word is dragged
  const mouse = { x: 0, y: 0, inside: false };
  let dragIdx = null, dragBase = { x: 0, y: 0 }, dragFrom = { x: 0, y: 0 };
  const KILL_DIST = 160;                             // drag this far (px) → the cue dissolves
  const mounted = new Map();                // cueIndex -> element

  /* ---------- the emoji cursor ----------
     The cursor IS the video's current emoji — it cuts in and out in
     hard sync with the show (renderAt drives it every frame). No emoji
     on screen -> no cursor. Each new emoji pops in ("trap sample"
     dilate), and it pulses on the beat (BEATS from cues.js). */
  let cursorSrc = null, cursorPopT = -9, lastBeatT = -9, beatIdx = 0;
  function setCursorEmoji(src, t) {
    if (src === cursorSrc) return;
    cursorSrc = src;
    if (src) { cursorImg.src = src; cursorPopT = t; }
  }
  function cursorFrame(t) {
    // wears exactly the emoji that's on screen right now
    let src = null;
    for (let i = 0; i < CUES.length; i++) {
      const c = CUES[i];
      if (c.emoji === false) continue;
      if (t >= c.s && t < c.e) {
        if (c.frames) {
          const a0 = c.frameAnchor != null ? c.frameAnchor : c.s;
          const k = Math.floor((t - a0) / (c.frameDur || 0.167)) % c.frames.length;
          src = c.frames[(k + c.frames.length) % c.frames.length];
        } else if (c.img) src = c.img;
      }
    }
    setCursorEmoji(src, t);
    const show = !!src && mouse.inside && running;
    cursorEl.classList.toggle("is-on", show);
    if (!show) return;
    // beat clock (BEATS is sorted; walk the index, handle seeks)
    if (typeof BEATS !== "undefined" && BEATS.length) {
      if (beatIdx >= BEATS.length || (beatIdx > 0 && BEATS[beatIdx - 1] > t)) beatIdx = 0;
      while (beatIdx < BEATS.length && BEATS[beatIdx] <= t) { lastBeatT = BEATS[beatIdx]; beatIdx++; }
    }
    // classic sample dilate: pop on every new emoji + a pulse on every beat
    const pop  = Math.max(0, 1 - (t - cursorPopT) / 0.16);
    const beat = Math.max(0, 1 - (t - lastBeatT) / 0.20);
    const s = 1 + 0.45 * pop * pop + 0.16 * beat * beat;
    cursorImg.style.transform = "scale(" + s.toFixed(3) + ")";
  }
  function moveCursor() {
    cursorEl.style.left = mouse.x + "px";
    cursorEl.style.top  = mouse.y + "px";
  }

  /* ---------- fit-to-fill: set the REAL font-size (crisp — no transform scaling) ----------
     Text scaled with transform:scale() rasterises small then upsamples → blurry.
     Instead we measure the glyphs once at a 100px reference, then set the exact
     px font-size that fills the target, so the browser renders it natively sharp. */
  const FIT_REF = 100;
  function ensureNat(el) {
    if (el.dataset.natW) return true;               // measured once (glyph metrics are viewport-independent)
    const prev = el.style.fontSize;
    el.style.fontSize = FIT_REF + "px";
    const nw = el.offsetWidth, nh = el.offsetHeight;
    if (nw && nh) { el.dataset.natW = nw; el.dataset.natH = nh; return true; }
    el.style.fontSize = prev;                        // viewport not laid out yet — try again later
    return false;
  }
  function applyFit(el, cue) {
    if (!ensureNat(el)) return;
    const W = stage.clientWidth, H = stage.clientHeight;
    if (!W || !H) return;
    const natW = +el.dataset.natW, natH = +el.dataset.natH;
    const vertical = Math.abs(((cue.rot || 0) % 180)) > 45; // ~90deg → text runs vertically
    let fs;
    if (vertical) {
      fs = Math.min(FIT_REF * (cue.fit * H) / natW, FIT_REF * ((cue.fitW || 0.96) * W) / natH);
    } else {
      fs = Math.min(FIT_REF * (cue.fit * W) / natW, FIT_REF * ((cue.fitH || 0.96) * H) / natH);
    }
    el.style.fontSize = fs + "px";
  }

  /* ---------- mount / update ---------- */
  function mount(idx, cue) {
    const el = document.createElement("div");
    el.dataset.idx = idx;
    el.style.left = (cue.x != null ? cue.x : 50) + "%";
    el.style.top  = (cue.y != null ? cue.y : 50) + "%";

    if (cue.img || cue.frames) {
      el.className = "cue cue-img";
      const im = document.createElement("img");
      im.src = cue.frames ? cue.frames[0] : cue.img;
      im.alt = cue.alt || "";
      im.draggable = false;
      el.appendChild(im);
      // emoji size = % of viewport height, like text
      el.style.height = (cue.size || 14) + "vh";
    } else {
      el.className = "cue " + (ROLE_CLASS[cue.role] || "r-sans");
      el.textContent = cue.text;
      el.style.textAlign = cue.align || "center";
      if (cue.weight) el.style.fontWeight = cue.weight;
      if (cue.font) el.style.fontFamily = cue.font;
      if (cue.style) el.style.fontStyle = cue.style;
      if (cue.track != null) el.style.letterSpacing = cue.track + "em";
      if (cue.lh != null) el.style.lineHeight = cue.lh;
      if (cue.case === "upper") el.style.textTransform = "uppercase";
      if (cue.case === "lower") el.style.textTransform = "lowercase";
      if (cue.color) el.style.color = cue.color;
      if (cue.stretch) el.style.transform = "";        // scaleX applied in update()

      if (cue.fit) {
        el.style.whiteSpace = "pre";      // keep multi-line blocks tight for measuring
        applyFit(el, cue);                // sets a crisp px font-size
      } else {
        el.style.fontSize = (cue.size || 8) + "vh";
      }
    }

    cueLayer.appendChild(el);
    if (cue.fit) applyFit(el, cue);       // re-fit now it's in the DOM
    clampWidth(el, cue);                  // vh sizing can overflow a narrow phone
    mounted.set(idx, el);
    return el;
  }

  // a cue sized in vh (matched to the 16:9 master) must never spill off a
  // narrow viewport — scale it down to fit, keeping desktop untouched
  function clampWidth(el, cue) {
    if (cue.fit) return;                          // fit cues already clamp
    const W = stage.clientWidth;
    if (!W) return;
    const w = el.offsetWidth;
    if (w > 0.94 * W) {
      if (cue.img || cue.frames) {
        el.style.height = ((cue.size || 14) * 0.94 * W / w) + "vh";
      } else {
        const fs = parseFloat(el.style.fontSize);   // "NNvh" — mount sizes text in vh
        el.style.fontSize = (fs * 0.94 * W / w) + "vh";
      }
    }
  }

  function envelope(cue, localT, life) {
    // opacity from enter/exit transitions — HARD CUT is the default (matches the source)
    const dur = cue.dur != null ? cue.dur : 0.12;
    let o = cue.opacity != null ? cue.opacity : 1;
    const fadeIn = cue.enter && cue.enter !== "cut";
    if (fadeIn && localT < dur) o *= localT / dur;
    if (cue.exit === "fade" && localT > life - dur) o *= Math.max(0, (life - localT) / dur);
    return o;
  }

  function update(idx, cue, t) {
    const el = mounted.get(idx) || mount(idx, cue);
    const life = cue.e - cue.s;
    const localT = t - cue.s;
    const k = Math.min(1, Math.max(0, localT / life));

    // frame-set animation (moon phases, earth spin, flickers): swap the image on a fixed step
    if (cue.frames) {
      const a0 = cue.frameAnchor != null ? cue.frameAnchor : cue.s;
      let k = Math.floor((t - a0) / (cue.frameDur || 0.167)) % cue.frames.length;
      k = (k + cue.frames.length) % cue.frames.length;
      if (el.dataset.fk !== String(k)) {
        el.dataset.fk = k;
        el.querySelector("img").src = cue.frames[k];
      }
    }

    // font cycling ("OFF THE DEEP END"): swap the family on a fixed beat
    if (cue.fontCycle) {
      const step = Math.floor(localT / (cue.cycleDur || 0.334)) % cue.fontCycle.length;
      if (el.dataset.cyc !== String(step)) {
        el.dataset.cyc = step;
        el.style.fontFamily = cue.fontCycle[step][0];
        el.style.fontWeight = cue.fontCycle[step][1] || 400;
        el.style.fontStyle  = cue.fontCycle[step][2] || "normal";
        delete el.dataset.natW; delete el.dataset.natH;   // re-measure the new face
        if (cue.fit) applyFit(el, cue);
      }
    }

    // opacity — dragging a cue fades it; flung far enough it's gone
    let op = envelope(cue, localT, life);
    const ds = dragState[idx];
    if (ds && dragIdx === idx) op *= Math.max(0.25, 1 - Math.hypot(ds.dx, ds.dy) / (KILL_DIST * 1.5));
    if (el.dataset.dead) { op = 0; el.style.pointerEvents = "none"; }
    el.style.opacity = op;

    if (cue.fit) applyFit(el, cue);
    let scale = 1;
    if (cue.grow) scale *= cue.grow[0] + (cue.grow[1] - cue.grow[0]) * k;

    const [ax, ay] = ANCHOR_XY[cue.anchor || "c"];
    let rot = cue.rot || 0;
    if (cue.spin) rot += 360 * ((localT / cue.spin) % 1);
    const sx = (cue.stretch || 1) * (cue.flip ? -1 : 1);   // stretch = condensed type; flip = mirrored footsteps
    const stretch = sx !== 1 ? " scaleX(" + sx + ")" : "";
    const dragT = ds ? "translate(" + ds.dx + "px," + ds.dy + "px) " : "";
    el.style.transform =
      dragT +
      "translate(" + ax + "%," + ay + "%)" +
      " rotate(" + rot + "deg)" +
      " scale(" + scale.toFixed(4) + ")" + stretch;
  }

  function unmount(idx) {
    const el = mounted.get(idx);
    if (el) { el.remove(); mounted.delete(idx); }
    delete dragState[idx];
    if (dragIdx === idx) dragIdx = null;
  }

  /* ---------- keep the browser chrome (iOS status bar / toolbar) matching the show ----------
     Direct open: live-update our own theme-color meta (honored because it exists at load).
     Embedded: postMessage the color; the WordPress block paints the parent page to match. */
  const themeMeta = document.querySelector('meta[name="theme-color"]');
  let lastBcast = null;
  function broadcastBg(color) {
    if (color === lastBcast) return;
    lastBcast = color;
    if (themeMeta) themeMeta.setAttribute("content", color);
    if (window.parent !== window) {
      try { window.parent.postMessage({ iam: "bg", color: color }, "*"); } catch (e) {}
    }
  }

  /* ---------- render one timestamp (rAF-independent) ---------- */
  let lastT = 0;
  function renderAt(t) {
    lastT = t;
    // this video lives on white, start to finish
    stage.style.setProperty("--bg", "#fff");
    stage.style.setProperty("--fg", "#000");
    broadcastBg("#ffffff");

    for (let i = 0; i < CUES.length; i++) {
      const c = CUES[i];
      const active = t >= c.s && t < c.e;
      if (active) update(i, c, t);
      else if (mounted.has(i)) unmount(i);
    }

    cursorFrame(t);   // the cursor cuts in and out with the video
  }

  /* ---------- main loop ---------- */
  function frame() {
    if (!running) return;
    const t = clockOverride != null ? clockOverride : Math.max(0, audio.currentTime + syncOffset);
    renderAt(t);
    requestAnimationFrame(frame);
  }

  /* ---------- resize: remount so every cue re-measures against the new viewport ---------- */
  function remountAll() {
    mounted.forEach(function (el) { el.remove(); });
    mounted.clear();
    if (running) renderAt(lastT);
  }
  window.addEventListener("resize", remountAll);
  if (window.ResizeObserver) {
    let lastW = 0;
    new ResizeObserver(function () {
      if (running && stage.clientWidth && stage.clientWidth !== lastW) {
        lastW = stage.clientWidth;
        remountAll();
      }
    }).observe(stage);
  }
  // web fonts load async — re-measure fit cues once the real glyphs are ready
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(function () {
      mounted.forEach(function (el) { delete el.dataset.natW; delete el.dataset.natH; });
      if (running) renderAt(lastT);
    });
  }

  /* ---------- flow ---------- */
  function start() {
    landing.classList.add("is-gone");
    setTimeout(function () { landing.hidden = true; }, 500);
    stage.classList.add("is-live");
    stage.setAttribute("aria-hidden", "false");
    document.body.classList.add("playing");
    broadcastBg("#ffffff");
    running = true;
    if (mouse.inside) moveCursor();
    audio.currentTime = 0;
    const p = audio.play();
    if (p && p.catch) p.catch(function (e) { console.warn("play blocked:", e); });
    requestAnimationFrame(frame);
  }

  playBtn.addEventListener("click", start);

  // end of song
  audio.addEventListener("ended", function () {
    running = false;
    stage.classList.remove("is-live");
    document.body.classList.remove("playing");
    cursorEl.classList.remove("is-on");
    endcard.hidden = false;
    requestAnimationFrame(function () { endcard.classList.add("is-visible"); });
  });
  replayBtn.addEventListener("click", function () {
    endcard.classList.remove("is-visible");
    setTimeout(function () { endcard.hidden = true; }, 400);
    stage.classList.add("is-live");
    document.body.classList.add("playing");
    running = true;
    if (mouse.inside) moveCursor();
    for (const k in dragState) delete dragState[k];
    mounted.forEach(function (el) { delete el.dataset.dead; });
    audio.load();                 // reliably rewinds to 0 even where seeking is blocked
    const p = audio.play();
    if (p && p.catch) p.catch(function () {});
    requestAnimationFrame(frame);
  });

  // small transient readout (used by the sync nudge)
  let toastT;
  function toast(msg) {
    toastEl.textContent = msg;
    toastEl.classList.add("is-on");
    clearTimeout(toastT);
    toastT = setTimeout(function () { toastEl.classList.remove("is-on"); }, 1100);
  }

  // keyboard: space/enter = start / replay / pause, [ ] = nudge audio sync
  window.addEventListener("keydown", function (e) {
    const isSpace = e.code === "Space" || e.key === " ";
    const isEnter = e.key === "Enter";
    if (isSpace || isEnter) {
      if (!landing.classList.contains("is-gone")) { e.preventDefault(); start(); }
      else if (!endcard.hidden) { e.preventDefault(); replayBtn.click(); }
      else if (running && isSpace) { e.preventDefault(); if (audio.paused) audio.play(); else audio.pause(); }
    } else if (e.key === "[" || e.key === "]") {
      syncOffset += (e.key === "]" ? 0.01 : -0.01);
      localStorage.setItem("imy_sync", syncOffset.toFixed(3));
      toast("audio sync " + (syncOffset >= 0 ? "+" : "") + syncOffset.toFixed(2) + "s");
    }
  });

  /* ---------- pointer: emoji cursor follows; grab a word and drag it ---------- */
  window.addEventListener("pointermove", function (e) {
    mouse.x = e.clientX; mouse.y = e.clientY; mouse.inside = true;
    if (running) moveCursor();
    if (dragIdx != null) {
      dragState[dragIdx] = { dx: dragBase.x + (e.clientX - dragFrom.x), dy: dragBase.y + (e.clientY - dragFrom.y) };
    }
  });
  window.addEventListener("mouseout", function (e) {
    if (!e.relatedTarget) { mouse.inside = false; cursorEl.classList.remove("is-on"); }
  });

  stage.addEventListener("pointerdown", function (e) {
    if (!running) return;
    mouse.x = e.clientX; mouse.y = e.clientY; mouse.inside = true;
    moveCursor(); cursorEl.classList.add("is-down");
    if (!e.target.closest) return;
    const cel = e.target.closest(".cue");
    if (!cel || cel.dataset.idx == null) return;
    dragIdx = +cel.dataset.idx;
    dragFrom = { x: e.clientX, y: e.clientY };
    const cur = dragState[dragIdx];
    dragBase = cur ? { x: cur.dx, y: cur.dy } : { x: 0, y: 0 };
    document.body.classList.add("is-dragging");
    e.preventDefault();
  });
  window.addEventListener("pointerup", function () {
    cursorEl.classList.remove("is-down");
    if (dragIdx == null) return;
    const ds = dragState[dragIdx], el = mounted.get(dragIdx);
    if (ds && Math.hypot(ds.dx, ds.dy) > KILL_DIST) {
      if (el) { el.dataset.dead = "1"; el.style.pointerEvents = "none"; }  // flung far → dissolve
    }
    // otherwise the word STAYS exactly where you dropped it (no snap-back)
    dragIdx = null;
    document.body.classList.remove("is-dragging");
  });
  // touch drag interrupted by a system gesture → don't leave a word stuck to the finger
  window.addEventListener("pointercancel", function () {
    cursorEl.classList.remove("is-down");
    dragIdx = null;
    document.body.classList.remove("is-dragging");
  });

  // expose a tiny hook for automated verification / debugging
  window.__iam = window.__imy = {
    seek: function (t) { audio.currentTime = t; },
    startAt: function (t) { if (!running) start(); audio.currentTime = t || 0; },
    setOffset: function (v) { syncOffset = +v; localStorage.setItem("imy_sync", syncOffset.toFixed(3)); },
    get offset() { return syncOffset; },
    // debug clock — render an exact timestamp without needing audio to seek
    // (renders synchronously so it works even where rAF is throttled)
    freeze: function (t) {
      clockOverride = t;
      landing.classList.add("is-gone"); landing.hidden = true;
      endcard.hidden = true;
      stage.classList.add("is-live"); stage.setAttribute("aria-hidden", "false");
      document.body.classList.add("playing");
      running = true;
      renderAt(t);
      requestAnimationFrame(frame);
    },
    unfreeze: function () { clockOverride = null; },
    get time() { return clockOverride != null ? clockOverride : audio.currentTime; },
    get mounted() { return Array.from(mounted.values()).map((e) => e.textContent || e.querySelector("img")?.src); },
  };
})();
