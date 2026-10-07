/* Typewriter sounds, synthesized with Web Audio so no samples need to ship.
 * Every strike is randomized a little so long passages never sound looped. */
(function () {
  const rand = (a, b) => a + Math.random() * (b - a);

  // Each profile scales the hammer clicks and the body thump of every sound.
  const PROFILES = {
    classic: { click: 1, pitch: 1, body: 1, bodyPitch: 1, decay: 1 },
    soft: { click: 0.45, pitch: 0.78, body: 0.75, bodyPitch: 0.95, decay: 0.9 },
    heavy: { click: 1.05, pitch: 0.82, body: 1.35, bodyPitch: 0.72, decay: 1.35 },
  };

  class TypeSound {
    constructor() {
      this.ctx = null;
      this.enabled = true;
      this.volume = 0.7;
      this.profile = 'classic';
    }

    ensure() {
      if (!this.ctx) {
        const ctx = new AudioContext({ latencyHint: 'interactive' });
        this.ctx = ctx;

        this.master = ctx.createGain();
        this.master.gain.value = this.volume;

        const comp = ctx.createDynamicsCompressor();
        comp.threshold.value = -14;
        comp.ratio.value = 4;
        comp.attack.value = 0.002;
        comp.release.value = 0.08;

        // A small wooden room: short, dark reverb tail.
        this.reverb = ctx.createConvolver();
        this.reverb.buffer = this.makeImpulse(0.45, 3.2);
        const wet = ctx.createGain();
        wet.gain.value = 0.16;
        const tone = ctx.createBiquadFilter();
        tone.type = 'lowpass';
        tone.frequency.value = 3800;

        this.loud = ctx.createGain();
        this.loud.connect(comp);
        this.loud.connect(this.reverb);
        // Quieter bus for text the app types on its own.
        this.soft = ctx.createGain();
        this.soft.gain.value = 0.4;
        this.soft.connect(this.loud);
        this.bus = this.loud;
        this.reverb.connect(tone).connect(wet).connect(comp);
        comp.connect(this.master).connect(ctx.destination);

        this.noise = this.makeNoise(1.0);
      }
      if (this.ctx.state === 'suspended') this.ctx.resume();
      return this.ctx;
    }

    setVolume(v) {
      this.volume = v;
      if (this.master) this.master.gain.value = v;
    }

    makeNoise(seconds) {
      const len = Math.floor(this.ctx.sampleRate * seconds);
      const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
      return buf;
    }

    makeImpulse(seconds, decay) {
      const rate = this.ctx.sampleRate;
      const len = Math.floor(rate * seconds);
      const buf = this.ctx.createBuffer(2, len, rate);
      for (let c = 0; c < 2; c++) {
        const d = buf.getChannelData(c);
        for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
      }
      return buf;
    }

    /* A filtered burst of noise: the hammer, the typebar, the escapement. */
    hit(t, { freq = 2500, q = 1, type = 'bandpass', dur = 0.03, gain = 0.5, attack = 0.0008 }) {
      const ctx = this.ctx;
      const P = PROFILES[this.profile] || PROFILES.classic;
      freq *= P.pitch;
      gain *= P.click;
      dur *= P.decay;
      const src = ctx.createBufferSource();
      src.buffer = this.noise;
      const f = ctx.createBiquadFilter();
      f.type = type;
      f.frequency.value = freq;
      f.Q.value = q;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.linearRampToValueAtTime(gain, t + attack);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      src.connect(f).connect(g).connect(this.bus);
      src.start(t, Math.random() * 0.8);
      src.stop(t + dur + 0.02);
    }

    /* A falling pitched thump: the platen and the body of the machine. */
    thump(t, { f0 = 170, f1 = 55, dur = 0.07, gain = 0.4, type = 'triangle' }) {
      const ctx = this.ctx;
      const P = PROFILES[this.profile] || PROFILES.classic;
      f0 *= P.bodyPitch;
      f1 *= P.bodyPitch;
      gain *= P.body;
      dur *= P.decay;
      const o = ctx.createOscillator();
      o.type = type;
      o.frequency.setValueAtTime(f0, t);
      o.frequency.exponentialRampToValueAtTime(f1, t + dur);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.linearRampToValueAtTime(gain, t + 0.002);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g).connect(this.bus);
      o.start(t);
      o.stop(t + dur + 0.02);
    }

    strike() {
      const t = this.ctx.currentTime + 0.002;
      const v = rand(0.8, 1.1);
      this.hit(t, { freq: rand(1900, 3300), q: rand(0.9, 1.7), dur: rand(0.028, 0.04), gain: 0.95 * v });
      this.thump(t, { f0: rand(150, 200), f1: 52, dur: 0.075, gain: 0.55 * v });
      this.hit(t + 0.001, { freq: rand(5200, 6800), type: 'highpass', dur: 0.012, gain: 0.3 * v });
      this.hit(t + rand(0.011, 0.019), { freq: rand(3800, 4600), q: 7, dur: 0.009, gain: 0.16 });
      // typebar falling back into the basket
      this.hit(t + rand(0.048, 0.075), { freq: rand(850, 1350), q: 2.2, dur: 0.026, gain: 0.22 * v });
    }

    space() {
      const t = this.ctx.currentTime + 0.002;
      const v = rand(0.85, 1.05);
      this.hit(t, { freq: rand(1000, 1400), q: 1.1, dur: 0.05, gain: 0.6 * v });
      this.thump(t, { f0: 120, f1: 42, dur: 0.11, gain: 0.7 * v });
      this.hit(t + rand(0.012, 0.018), { freq: 4200, q: 6, dur: 0.01, gain: 0.18 });
      this.hit(t + rand(0.07, 0.09), { freq: 700, q: 1.5, dur: 0.035, gain: 0.25 * v });
    }

    back() {
      const t = this.ctx.currentTime + 0.002;
      this.hit(t, { freq: rand(1300, 1700), q: 2.4, dur: 0.035, gain: 0.7 });
      this.thump(t, { f0: 210, f1: 90, dur: 0.05, gain: 0.35 });
      this.hit(t + 0.03, { freq: 2600, q: 4, dur: 0.018, gain: 0.25 });
    }

    bell(at) {
      const ctx = this.ctx;
      const t = at ?? ctx.currentTime + 0.002;
      // Inharmonic partials make it read as a small struck bell.
      [[2380, 0.22, 1.5], [2380 * 2.76, 0.07, 0.6], [2380 * 5.4, 0.03, 0.25]].forEach(([f, gain, dur]) => {
        const o = ctx.createOscillator();
        o.type = 'sine';
        o.frequency.value = f * rand(0.995, 1.005);
        const g = ctx.createGain();
        g.gain.setValueAtTime(0.0001, t);
        g.gain.linearRampToValueAtTime(gain, t + 0.003);
        g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
        o.connect(g).connect(this.bus);
        o.start(t);
        o.stop(t + dur + 0.05);
      });
      this.hit(t, { freq: 6000, q: 3, dur: 0.01, gain: 0.25 });
    }

    carriage() {
      const t0 = this.ctx.currentTime + 0.002;
      // line-feed lever
      this.hit(t0, { freq: 1600, q: 1.5, dur: 0.05, gain: 0.55 });
      this.thump(t0, { f0: 140, f1: 60, dur: 0.06, gain: 0.4 });
      // ratchet as the carriage slides back
      let t = t0 + 0.06;
      const n = 13;
      for (let i = 0; i < n; i++) {
        this.hit(t, { freq: rand(2800, 3400), q: 5, dur: 0.012, gain: 0.2 * (1 - (i / n) * 0.4) });
        t += 0.016 + i * 0.0018;
      }
      this.hit(t0 + 0.06, { freq: 900, type: 'lowpass', q: 0.7, dur: t - t0, gain: 0.1, attack: 0.05 });
      // the carriage hitting its stop
      this.thump(t, { f0: 105, f1: 38, dur: 0.14, gain: 0.85 });
      this.hit(t, { freq: 1200, q: 1.2, dur: 0.06, gain: 0.55 });
    }

    play(kind, soft = false) {
      if (!this.enabled) return;
      this.ensure();
      // Every node is wired synchronously below, so swapping the bus is safe.
      this.bus = soft ? this.soft : this.loud;
      switch (kind) {
        case 'space': this.space(); break;
        case 'back': this.back(); break;
        case 'enter': this.carriage(); break;
        case 'bell': this.bell(); break;
        default: this.strike();
      }
      this.bus = this.loud;
    }
  }

  window.TypeSound = TypeSound;
})();
