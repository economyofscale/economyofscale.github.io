/**
 * Browser audio output: an AudioWorklet that plays stereo samples from a
 * ring buffer the page fills once per displayed frame (GameSound.frame()).
 *
 * The page's frames (requestAnimationFrame, ~60 Hz) and the Game Boy's
 * (59.73 Hz) differ a little, so the buffer is kept short: past ~100 ms
 * queued, the oldest samples are dropped; when it runs dry, silence.
 * Browsers only start audio from a user gesture -- create it from one.
 */

const WORKLET = `
class Ring extends AudioWorkletProcessor {
  constructor() {
    super();
    this.size = 1 << 15;
    this.l = new Float32Array(this.size);
    this.r = new Float32Array(this.size);
    this.read = 0;
    this.write = 0;
    this.max = Math.round(sampleRate * 0.1);
    this.port.onmessage = ({ data }) => {
      const { left, right } = data;
      for (let i = 0; i < left.length; i++) {
        this.l[this.write] = left[i];
        this.r[this.write] = right[i];
        this.write = (this.write + 1) & (this.size - 1);
      }
      const queued = (this.write - this.read) & (this.size - 1);
      if (queued > this.max) this.read = (this.write - this.max) & (this.size - 1);
    };
  }
  process(_, outputs) {
    const [l, r] = outputs[0];
    for (let i = 0; i < l.length; i++) {
      if (this.read === this.write) { l[i] = 0; if (r) r[i] = 0; continue; }
      l[i] = this.l[this.read];
      if (r) r[i] = this.r[this.read];
      this.read = (this.read + 1) & (this.size - 1);
    }
    return true;
  }
}
registerProcessor('gb-ring', Ring);
`;

export class AudioOut {
  /** Resolves once the worklet is running; `rate` is the context's. */
  static async create() {
    const ctx = new AudioContext();
    const url = URL.createObjectURL(new Blob([WORKLET], { type: 'application/javascript' }));
    await ctx.audioWorklet.addModule(url);
    URL.revokeObjectURL(url);
    const node = new AudioWorkletNode(ctx, 'gb-ring', { outputChannelCount: [2] });
    const gain = ctx.createGain();
    node.connect(gain).connect(ctx.destination);
    await ctx.resume();
    return new AudioOut(ctx, node, gain);
  }

  constructor(ctx, node, gain) {
    this.ctx = ctx;
    this.node = node;
    this.gain = gain;
    this.rate = ctx.sampleRate;
  }

  /** One frame's samples ({ left, right } Float32Arrays). */
  push(samples) {
    this.node.port.postMessage(samples, [samples.left.buffer, samples.right.buffer]);
  }

  get muted() { return this.gain.gain.value === 0; }
  set muted(m) { this.gain.gain.value = m ? 0 : 1; }
}
