/* LiveTranscriber: streams a MediaStream to the native speech helper and
 * reports partial and final text. Finals carry the recording time at which
 * their sentence began, so they can be stamped [mm:ss]. */
(function () {
  class LiveTranscriber {
    constructor() {
      this.active = false;
      this.ctx = null;
      this.segStart = new Map();
      this.handlers = { partial: () => {}, final: () => {}, error: () => {}, state: () => {} };
      window.memo.onStt((ev) => this.onEvent(ev));
    }

    on(name, fn) { this.handlers[name] = fn; }

    /* `clock` returns the current recording time in seconds. */
    async start(stream, clock, locale = 'ko-KR') {
      if (this.active) return;
      this.clock = clock;
      this.segStart.clear();
      const ok = await window.memo.sttStart({ locale });
      if (!ok) return;
      this.active = true;

      this.ctx = new AudioContext();
      await this.ctx.audioWorklet.addModule('pcm-worklet.js');
      const src = this.ctx.createMediaStreamSource(stream);
      this.node = new AudioWorkletNode(this.ctx, 'pcm-16k');
      this.node.port.onmessage = (e) => { if (this.active) window.memo.sttAudio(new Uint8Array(e.data)); };
      // The worklet only runs while pulled by the graph; feed it into a muted sink.
      const mute = this.ctx.createGain();
      mute.gain.value = 0;
      src.connect(this.node).connect(mute).connect(this.ctx.destination);
      this.handlers.state('starting');
    }

    async stop() {
      if (!this.active) return;
      this.active = false;
      try { this.node?.disconnect(); } catch {}
      await this.ctx?.close();
      this.ctx = null;
      this.handlers.state('flushing');
      await window.memo.sttStop();
      this.handlers.state('idle');
    }

    startOf(seg) {
      if (!this.segStart.has(seg)) {
        // The recognizer reports a beat after speech begins; nudge back a little.
        this.segStart.set(seg, Math.max(0, (this.clock?.() ?? 0) - 1));
      }
      return this.segStart.get(seg);
    }

    onEvent(ev) {
      switch (ev.type) {
        case 'ready': return this.handlers.state('listening', ev);
        case 'partial': this.startOf(ev.seg); return this.handlers.partial(ev.text);
        case 'final': {
          const at = this.startOf(ev.seg);
          this.segStart.delete(ev.seg);
          return this.handlers.final(ev.text, at);
        }
        case 'error':
          this.active = false;
          return this.handlers.error(ev);
        case 'exit':
          if (this.active) {
            this.active = false;
            this.handlers.state('idle');
          }
          return undefined;
        default: return undefined;
      }
    }
  }

  window.LiveTranscriber = LiveTranscriber;
})();
