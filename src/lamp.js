/* LampScene
 * Darkness is a canvas laid over the desk; the lamp's beam is cut out of it
 * with `destination-out`. A second canvas (mix-blend: screen) adds the warm
 * haze. The cone is pre-rendered into
 * a sprite whenever the knobs change, so each frame is just a few blits. */
(function () {
  const TILT = (-118 * Math.PI) / 180; // aimed up and to the left, over the line just typed
  const BASE_REACH = 320;
  const LAMP_W = 104;
  const LAMP_BODY_Y = 43; // rail centre inside the lamp svg
  const APEX_Y = 1;       // emitter top inside the lamp svg

  const lerp = (a, b, t) => a + (b - a) * t;
  const damp = (k, dt) => 1 - Math.pow(1 - k, dt * 60);

  class LampScene {
    constructor({ desk, shade, glow, rail, lamp }) {
      this.desk = desk;
      this.shade = shade;
      this.glow = glow;
      this.rail = rail;
      this.lamp = lamp;
      this.sctx = shade.getContext('2d');
      this.gctx = glow.getContext('2d');

      this.params = { intensity: 1.5, spread: 112, reach: 1.2 };
      this.dark = true;
      this.on = true;
      this.power = 1;
      this.powerSeq = null;

      this.x = null;
      this.tx = 0;
      this.railY = 0;
      this.railL = 0;
      this.railR = 0;

      this.level = 0;
      this.time = 0;
      this.reading = false;
      this.readMix = 0;
      this.still = false;
      this.aim = 0;       // extra beam rotation (radians), eased
      this.aimTarget = 0;

      this.resize();
      this.buildSprites();
      new ResizeObserver(() => this.resize()).observe(desk);
    }

    resize() {
      const dpr = window.devicePixelRatio || 1;
      this.w = this.desk.clientWidth;
      this.h = this.desk.clientHeight;
      for (const c of [this.shade, this.glow]) {
        c.width = Math.round(this.w * dpr);
        c.height = Math.round(this.h * dpr);
      }
      this.dpr = dpr;
    }

    setParams(p) {
      Object.assign(this.params, p);
      this.dirty = true; // rebuilt on the next frame, at most every ~90 ms while a knob is dragged
    }

    /* The beam is rendered pixel by pixel from a small light model instead of
     * a blurred wedge, so it reads like a real lamp:
     *   - the penumbra is an angle, so edges are crisp near the lamp and widen
     *     with distance (and stay soft right at the emitter, which has a size);
     *   - brightness holds near the lamp and fades out smoothly toward the reach;
     *   - light also spills onto the page around the lamp, strongest along the
     *     line being typed, instead of a separate painted band;
     *   - a whisper of grain keeps long gradients from banding.
     * It is rendered at half resolution and scaled up; the light is soft anyway. */
    buildSprites() {
      const { spread, reach } = this.params;
      const R = BASE_REACH * reach;
      const half = ((spread / 2) * Math.PI) / 180;
      const SCALE = 2;
      const S = Math.ceil(2 * (R * 1.32 + 24));
      const c = S / 2;
      const n = Math.ceil(S / SCALE);

      // Two layers: the beam (turns toward the pointer) and the pool of light
      // on the page around the lamp (stays put). Each has a cut-out alpha
      // sprite and a warm-tinted twin for the glow canvas.
      const make = () => {
        const cv = document.createElement('canvas');
        cv.width = cv.height = n;
        const ctx = cv.getContext('2d');
        return { cv, ctx, img: ctx.createImageData(n, n) };
      };
      const beamA = make();
      const beamW = make();
      const poolA = make();
      const poolW = make();
      const tint = (wd, k, I, a) => {
        // near-white in the core, amber toward the rim
        const t = I * 1.25 > 1 ? 1 : I * 1.25;
        wd[k] = 255;
        wd[k + 1] = 172 + 64 * t;
        wd[k + 2] = 96 + 112 * t;
        wd[k + 3] = a;
      };
      const grain = (I) => {
        // a whisper of noise keeps long gradients from banding
        const a = I * 255 + (Math.random() - 0.5) * 1.2;
        return a < 0 ? 0 : a > 255 ? 255 : a;
      };

      const smooth = (e0, e1, x) => {
        const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0)));
        return t * t * (3 - 2 * t);
      };
      const soft0 = 0.22 * half + 0.08; // penumbra half-width, radians
      const EMIT = 28;                  // emitter size in px
      const poolCx = -0.3 * R;          // spill: centred left of the lamp,
      const poolCy = -24;               // on the typing line just above it
      const poolX = 0.46 * R;
      const poolY = 0.2 * R;

      for (let j = 0; j < n; j++) {
        const dy = (j + 0.5) * SCALE - c;
        for (let i = 0; i < n; i++) {
          const dx = (i + 0.5) * SCALE - c;
          const r = Math.sqrt(dx * dx + dy * dy);
          let th = Math.atan2(dy, dx) - TILT;
          th = Math.atan2(Math.sin(th), Math.cos(th));
          const ang = Math.abs(th);

          const soft = soft0 + EMIT / (r + EMIT);
          const edge = 1 - smooth(half - soft, half + soft, ang);
          const core = 0.82 + 0.18 * Math.cos(Math.min(1, ang / (half + soft)) * (Math.PI / 2));
          const rn = r / R;
          const radial = (1 / (1 + 1.4 * rn * rn * rn * rn)) * (1 - smooth(0.7, 1.05, rn));
          const beam = edge * core * radial;

          const px = (dx - poolCx) / poolX;
          const py = (dy - poolCy) / poolY;
          let pool = 0.62 * Math.exp(-(px * px + py * py)) + 0.7 * Math.exp(-(r * r) / (46 * 46));
          if (pool > 1) pool = 1;

          const k = (j * n + i) * 4;
          const ab = grain(beam);
          beamA.img.data[k + 3] = ab;
          tint(beamW.img.data, k, beam, ab);
          const ap = grain(pool);
          poolA.img.data[k + 3] = ap;
          tint(poolW.img.data, k, pool, ap);
        }
      }
      for (const L of [beamA, beamW, poolA, poolW]) L.ctx.putImageData(L.img, 0, 0);

      this.cone = beamA.cv;
      this.warm = beamW.cv;
      this.pool = poolA.cv;
      this.poolWarm = poolW.cv;
      this.spriteC = c;
      this.spriteS = S;
      this.dirty = false;
      this.builtAt = performance.now();
    }

    setDark(dark) { this.dark = dark; }

    setOn(on) {
      if (on === this.on) return;
      this.on = on;
      // A short stutter when the lamp warms up.
      this.powerSeq = on
        ? { t: 0, keys: [[0, 0], [0.05, 0.9], [0.09, 0.15], [0.16, 1], [0.21, 0.45], [0.32, 1]] }
        : { t: 0, keys: [[0, this.power], [0.18, 0]] };
    }

    setRail(left, right, y) {
      this.railL = left;
      this.railR = right;
      this.railY = y;
    }

    setTarget(x) {
      this.tx = Math.max(this.railL + LAMP_W / 2 - 6, Math.min(this.railR - LAMP_W / 2 + 6, x));
      if (this.x === null) this.x = this.tx;
    }

    setLevel(v) { this.level = v; }

    /* Reading back (scrolling, folded view): lift the room light so lines
     * outside the beam stay legible. */
    setReading(on) { this.reading = on; }

    /* Reduced motion: no flicker, no warm-up stutter, the lamp jumps instead of gliding. */
    setStill(on) { this.still = on; }

    /* Turn the beam a little toward a point (desk coordinates), or back to
     * rest with null. `pull` is how much of the way it follows. */
    lookAt(px, py, pull = 0.3) {
      if (px == null || this.still) { this.aimTarget = 0; return; }
      const { x, y } = this.apex;
      let d = Math.atan2(py - y, px - x) - TILT;
      d = Math.atan2(Math.sin(d), Math.cos(d));
      const limit = 0.7;
      this.aimTarget = Math.max(-limit, Math.min(limit, d)) * pull;
    }

    // Draws a beam sprite at the apex, rotated by the current aim.
    blit(ctx, sprite, x, y, turn = true) {
      const c = this.spriteC;
      const S = this.spriteS;
      ctx.imageSmoothingQuality = 'high';
      if (!turn || Math.abs(this.aim) < 0.001) { ctx.drawImage(sprite, x - c, y - c, S, S); return; }
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(this.aim);
      ctx.drawImage(sprite, -c, -c, S, S);
      ctx.restore();
    }

    get apex() {
      return { x: this.x ?? this.tx, y: this.railY - LAMP_BODY_Y + APEX_Y };
    }

    stepPower(dt) {
      const seq = this.powerSeq;
      if (!seq) { this.power = this.on ? 1 : 0; return; }
      seq.t += dt;
      const k = seq.keys;
      if (seq.t >= k[k.length - 1][0]) {
        this.power = k[k.length - 1][1];
        this.powerSeq = null;
        return;
      }
      for (let i = 1; i < k.length; i++) {
        if (seq.t < k[i][0]) {
          const [t0, v0] = k[i - 1];
          const [t1, v1] = k[i];
          this.power = lerp(v0, v1, (seq.t - t0) / (t1 - t0));
          return;
        }
      }
    }

    frame(dt) {
      this.time += dt;
      if (this.dirty && performance.now() - (this.builtAt || 0) > 90) this.buildSprites();
      if (this.still && this.powerSeq) this.powerSeq = null;
      this.stepPower(dt);

      // carriage-like glide toward the caret
      if (this.x === null) this.x = this.tx;
      this.x = this.still ? this.tx : lerp(this.x, this.tx, damp(0.16, dt));
      this.readMix = lerp(this.readMix, this.reading ? 1 : 0, damp(0.06, dt));
      this.aim = this.still ? 0 : lerp(this.aim, this.aimTarget, damp(0.07, dt));

      const lx = this.x - LAMP_W / 2;
      const ly = this.railY - LAMP_BODY_Y;
      this.lamp.style.transform = `translate3d(${lx.toFixed(2)}px, ${ly.toFixed(2)}px, 0)`;
      this.lamp.style.setProperty('--power', (this.dark ? this.power : 0).toFixed(3));
      this.rail.style.setProperty('--rail-y', `${this.railY}px`);
      this.rail.style.setProperty('--rail-l', `${this.railL}px`);
      this.rail.style.setProperty('--rail-w', `${this.railR - this.railL}px`);

      if (!this.dark) return;
      this.draw(dt);
    }

    draw(dt) {
      const { sctx: s, gctx: g, dpr, w, h } = this;
      const { intensity } = this.params;
      const t = this.time;
      const flicker = this.still ? 1 : 1
        - 0.012 * (Math.sin(t * 11.3) + 0.6 * Math.sin(t * 6.7 + 1.3) + 0.4 * Math.sin(t * 23.1))
        + this.level * 0.05;
      const power = this.power * flicker;
      const { x, y } = this.apex;

      // darkness with the beam cut out
      s.setTransform(dpr, 0, 0, dpr, 0, 0);
      s.globalCompositeOperation = 'source-over';
      s.globalAlpha = 1;
      s.clearRect(0, 0, w, h);
      const dark = (0.58 + 0.33 * this.power) * (1 - 0.45 * this.readMix);
      s.fillStyle = `rgba(7,7,8,${dark.toFixed(3)})`;
      s.fillRect(0, 0, w, h);
      if (power > 0.01) {
        s.globalCompositeOperation = 'destination-out';
        s.globalAlpha = Math.min(1, (0.42 + intensity * 0.4) * power);
        this.blit(s, this.cone, x, y);
        this.blit(s, this.pool, x, y, false);
      }

      // warm haze
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.globalCompositeOperation = 'source-over';
      g.globalAlpha = 1;
      g.clearRect(0, 0, w, h);
      if (power <= 0.01) return;

      g.globalCompositeOperation = 'source-over';
      g.globalAlpha = Math.min(0.6, (0.07 + 0.09 * intensity) * power);
      this.blit(g, this.warm, x, y);
      this.blit(g, this.poolWarm, x, y, false);
    }
  }

  window.LampScene = LampScene;
})();
