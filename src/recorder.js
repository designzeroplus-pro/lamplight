/* Recorder: microphone → MediaRecorder (webm/opus) with a level meter.
 * MediaRecorder leaves the duration out of webm files, which breaks seeking,
 * so the finished blob is patched with ysFixWebmDuration. */
(function () {
  class Recorder {
    constructor() {
      this.stream = null;
      this.mr = null;
      this.chunks = [];
      this.startedAt = 0;
      this.lastLength = 0;
      this.analyser = null;
      this.buf = null;
    }

    get active() { return !!this.mr && this.mr.state !== 'inactive'; }

    /* Live while recording; afterwards it holds the final length, so late
     * transcripts can still be stamped. */
    elapsed() {
      return this.active ? (performance.now() - this.startedAt) / 1000 : this.lastLength;
    }

    async start() {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
      });
      const mime = ['audio/webm;codecs=opus', 'audio/webm'].find((m) => MediaRecorder.isTypeSupported(m));
      this.mr = new MediaRecorder(this.stream, { mimeType: mime, audioBitsPerSecond: 64000 });
      this.chunks = [];
      this.mr.ondataavailable = (e) => {
        if (!e.data.size) return;
        this.chunks.push(e.data);
        this.onChunk?.(e.data);
      };

      this.actx = new AudioContext();
      const src = this.actx.createMediaStreamSource(this.stream);
      this.analyser = this.actx.createAnalyser();
      this.analyser.fftSize = 1024;
      this.buf = new Float32Array(this.analyser.fftSize);
      src.connect(this.analyser);

      this.mr.start(1000);
      this.startedAt = performance.now();
      this.lastLength = 0;
      this.createdAt = Date.now();
    }

    level() {
      if (!this.analyser) return 0;
      this.analyser.getFloatTimeDomainData(this.buf);
      let sum = 0;
      for (let i = 0; i < this.buf.length; i++) sum += this.buf[i] * this.buf[i];
      const rms = Math.sqrt(sum / this.buf.length);
      return Math.min(1, Math.pow(rms * 4, 0.7));
    }

    async stop() {
      if (!this.active) return null;
      const duration = (performance.now() - this.startedAt) / 1000;
      this.lastLength = duration;
      const stopped = new Promise((r) => { this.mr.onstop = r; });
      this.mr.stop();
      await stopped;
      this.stream.getTracks().forEach((t) => t.stop());
      this.actx?.close();
      this.analyser = null;
      const type = this.mr.mimeType || 'audio/webm';
      this.mr = null;
      let blob = new Blob(this.chunks, { type });
      this.chunks = [];
      if (window.ysFixWebmDuration) blob = await window.ysFixWebmDuration(blob, duration * 1000, { logger: false });
      return { blob, duration, createdAt: this.createdAt };
    }
  }

  window.Recorder = Recorder;
})();
