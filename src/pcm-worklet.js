/* Downsamples the microphone to 16 kHz mono Int16 and posts ~100 ms chunks. */
class Pcm16k extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ratio = sampleRate / 16000;
    this.pos = 0;
    this.out = new Int16Array(1600);
    this.n = 0;
  }

  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    // Box-filter each output sample over the input samples it covers.
    while (this.pos + this.ratio <= ch.length) {
      const a = Math.floor(this.pos);
      const b = Math.floor(this.pos + this.ratio);
      let sum = 0;
      for (let i = a; i < b; i++) sum += ch[i];
      const v = Math.max(-1, Math.min(1, sum / Math.max(1, b - a)));
      this.out[this.n++] = v < 0 ? v * 0x8000 : v * 0x7fff;
      if (this.n === this.out.length) {
        this.port.postMessage(this.out.buffer, [this.out.buffer]);
        this.out = new Int16Array(1600);
        this.n = 0;
      }
      this.pos += this.ratio;
    }
    this.pos -= ch.length;
    return true;
  }
}

registerProcessor('pcm-16k', Pcm16k);
