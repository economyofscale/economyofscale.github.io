/**
 * The Game Boy's APU at the register level: two pulse channels (the first
 * with a frequency sweep), the wave channel, the noise channel, the 512 Hz
 * frame sequencer (length, sweep, envelope), and the NR50/NR51 mix.
 *
 * `write(addr, v)` as the game writes $ff10..$ff3f; `render(cycles)`
 * returns that many CPU cycles of stereo samples. Each sample is the
 * average of each channel's level over its span (so high notes do not
 * alias badly), through the channel's DAC (0..15 -> -1..1), panned by
 * NR51, scaled by NR50, then high-passed as the hardware's output
 * capacitor does.
 *
 * Written from the documented hardware behaviour (Pan Docs), checked
 * against serverboy's own APU on the game's recorded register writes
 * (web/test/apucheck.mjs). Not modelled: the DMG's quirks (zombie mode,
 * the wave RAM corruption on retrigger, length clocking on a write).
 */

export const CPU_HZ = 4194304;
/** CPU cycles in one LCD frame: the driver's update runs once a frame. */
export const FRAME_CYCLES = 70224;

const DUTY = [
  [0, 0, 0, 0, 0, 0, 0, 1], [1, 0, 0, 0, 0, 0, 0, 1],
  [1, 0, 0, 0, 0, 1, 1, 1], [0, 1, 1, 1, 1, 1, 1, 0],
];
const NOISE_DIV = [8, 16, 32, 48, 64, 80, 96, 112];

/** The length counter and the envelope, which three channels share. */
class Channel {
  constructor(maxLength) {
    this.maxLength = maxLength;
    this.on = false;
    this.dac = false;
    this.length = 0;
    this.lengthOn = false;
    this.vol = 0;
    this.envVol = 0;
    this.envUp = false;
    this.envPeriod = 0;
    this.envTimer = 0;
    this.timer = 1;
  }

  setEnvelope(v) {
    this.envVol = v >> 4;
    this.envUp = !!(v & 0x08);
    this.envPeriod = v & 0x07;
    this.dac = (v & 0xf8) !== 0;
    if (!this.dac) this.on = false;
  }

  clockLength() {
    if (this.lengthOn && this.length > 0 && --this.length === 0) this.on = false;
  }

  clockEnvelope() {
    if (!this.envPeriod) return;
    if (--this.envTimer > 0) return;
    this.envTimer = this.envPeriod;
    if (this.envUp && this.vol < 15) this.vol++;
    else if (!this.envUp && this.vol > 0) this.vol--;
  }

  triggerCommon() {
    this.on = this.dac;
    if (!this.length) this.length = this.maxLength;
    this.vol = this.envVol;
    this.envTimer = this.envPeriod || 8;
  }

  /** The channel's level summed over `cycles`: `level()` held between timer steps. */
  run(cycles) {
    if (!this.on) return 0;
    let sum = 0;
    while (cycles > 0) {
      const n = Math.min(cycles, this.timer);
      sum += n * this.level();
      cycles -= n;
      this.timer -= n;
      if (this.timer <= 0) { this.timer += this.period(); this.tick(); }
    }
    return sum;
  }
}

class Pulse extends Channel {
  constructor(sweep) {
    super(64);
    this.hasSweep = sweep;
    this.duty = 0;
    this.pos = 0;
    this.freq = 0;
    this.sweepPeriod = 0;
    this.sweepDown = false;
    this.sweepShift = 0;
    this.sweepTimer = 0;
    this.sweepOn = false;
    this.shadow = 0;
  }

  period() { return (2048 - this.freq) * 4; }
  level() { return DUTY[this.duty][this.pos] * this.vol; }
  tick() { this.pos = (this.pos + 1) & 7; }

  write(reg, v) {
    if (reg === 0) {
      this.sweepPeriod = (v >> 4) & 7;
      this.sweepDown = !!(v & 0x08);
      this.sweepShift = v & 7;
    } else if (reg === 1) {
      this.duty = v >> 6;
      this.length = 64 - (v & 0x3f);
    } else if (reg === 2) {
      this.setEnvelope(v);
    } else if (reg === 3) {
      this.freq = (this.freq & 0x700) | v;
    } else if (reg === 4) {
      this.freq = (this.freq & 0xff) | ((v & 7) << 8);
      this.lengthOn = !!(v & 0x40);
      if (v & 0x80) this.trigger();
    }
  }

  trigger() {
    this.triggerCommon();
    this.timer = this.period();
    if (!this.hasSweep) return;
    this.shadow = this.freq;
    this.sweepTimer = this.sweepPeriod || 8;
    this.sweepOn = !!(this.sweepPeriod || this.sweepShift);
    if (this.sweepShift) this.sweepCalc();
  }

  sweepCalc() {
    const d = this.shadow >> this.sweepShift;
    const f = this.sweepDown ? this.shadow - d : this.shadow + d;
    if (f > 2047) this.on = false;
    return f;
  }

  clockSweep() {
    if (--this.sweepTimer > 0) return;
    this.sweepTimer = this.sweepPeriod || 8;
    if (!this.sweepOn || !this.sweepPeriod) return;
    const f = this.sweepCalc();
    if (f <= 2047 && this.sweepShift) {
      this.shadow = f;
      this.freq = f;
      this.sweepCalc();
    }
  }
}

class Wave extends Channel {
  constructor(ram) {
    super(256);
    this.ram = ram;
    this.shift = 0;
    this.freq = 0;
    this.pos = 0;
  }

  period() { return (2048 - this.freq) * 2; }
  tick() { this.pos = (this.pos + 1) & 31; }

  level() {
    if (!this.shift) return 0;
    const b = this.ram[this.pos >> 1];
    return (this.pos & 1 ? b & 0x0f : b >> 4) >> (this.shift - 1);
  }

  write(reg, v) {
    if (reg === 0) {
      this.dac = !!(v & 0x80);
      if (!this.dac) this.on = false;
    } else if (reg === 1) {
      this.length = 256 - v;
    } else if (reg === 2) {
      this.shift = (v >> 5) & 3;
    } else if (reg === 3) {
      this.freq = (this.freq & 0x700) | v;
    } else if (reg === 4) {
      this.freq = (this.freq & 0xff) | ((v & 7) << 8);
      this.lengthOn = !!(v & 0x40);
      if (v & 0x80) {
        this.on = this.dac;
        if (!this.length) this.length = 256;
        this.timer = this.period();
        this.pos = 0;
      }
    }
  }

  clockEnvelope() {}
}

class Noise extends Channel {
  constructor() {
    super(64);
    this.shift = 0;
    this.narrow = false;
    this.div = 0;
    this.lfsr = 0x7fff;
  }

  period() { return NOISE_DIV[this.div] << this.shift; }
  level() { return (~this.lfsr & 1) * this.vol; }

  tick() {
    const x = (this.lfsr ^ (this.lfsr >> 1)) & 1;
    this.lfsr = (this.lfsr >> 1) | (x << 14);
    if (this.narrow) this.lfsr = (this.lfsr & ~0x40) | (x << 6);
  }

  write(reg, v) {
    if (reg === 1) {
      this.length = 64 - (v & 0x3f);
    } else if (reg === 2) {
      this.setEnvelope(v);
    } else if (reg === 3) {
      this.shift = v >> 4;
      this.narrow = !!(v & 0x08);
      this.div = v & 7;
    } else if (reg === 4) {
      this.lengthOn = !!(v & 0x40);
      if (v & 0x80) {
        this.triggerCommon();
        this.timer = this.period();
        this.lfsr = 0x7fff;
      }
    }
  }
}

export class Apu {
  constructor(rate = 48000) {
    this.rate = rate;
    this.waveRam = new Uint8Array(16);
    this.ch = [new Pulse(true), new Pulse(false), new Wave(this.waveRam), new Noise()];
    this.nr50 = 0x77;
    this.nr51 = 0xff;
    this.power = true;
    this.seqTimer = 8192;
    this.seqStep = 0;
    this.frac = 0;
    this.carry = 0;
    this.capL = 0;
    this.capR = 0;
    this.charge = Math.pow(0.999958, CPU_HZ / rate);
    /** Channels to leave out of the mix (a debug aid). */
    this.muted = [false, false, false, false];
  }

  write(addr, v) {
    const r = addr - 0xff10;
    if (r < 0 || r >= 0x30) return;
    if (r >= 0x20) { this.waveRam[r - 0x20] = v; return; }
    if (r === 0x16) {
      const on = !!(v & 0x80);
      if (this.power && !on) {
        for (let a = 0xff10; a < 0xff26; a++) this.write(a, 0);
        for (const c of this.ch) c.on = false;
      }
      this.power = on;
      return;
    }
    if (!this.power) return;
    if (r < 0x05) this.ch[0].write(r, v);
    else if (r < 0x0a) this.ch[1].write(r - 0x05, v);
    else if (r < 0x0f) this.ch[2].write(r - 0x0a, v);
    else if (r < 0x14) this.ch[3].write(r - 0x0f, v);
    else if (r === 0x14) this.nr50 = v;
    else if (r === 0x15) this.nr51 = v;
  }

  /** Steps 0..7 at 512 Hz: length on even steps, sweep on 2 and 6, envelope on 7. */
  clockSequencer() {
    const s = this.seqStep;
    if (!(s & 1)) for (const c of this.ch) c.clockLength();
    if (s === 2 || s === 6) this.ch[0].clockSweep();
    if (s === 7) for (const c of this.ch) c.clockEnvelope();
    this.seqStep = (s + 1) & 7;
  }

  render(cycles) {
    const per = CPU_HZ / this.rate;
    const n = Math.floor((cycles + this.frac) / per);
    this.frac = cycles + this.frac - n * per;
    const left = new Float32Array(n), right = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const span = Math.max(1, Math.round(per + this.carry));
      this.carry += per - span;
      // The frame sequencer, at the sample's start.
      this.seqTimer -= span;
      while (this.seqTimer <= 0) { this.seqTimer += 8192; this.clockSequencer(); }
      let l = 0, r = 0;
      for (let k = 0; k < 4; k++) {
        const c = this.ch[k];
        const level = c.run(span) / span;
        if (!c.dac || !this.power || this.muted[k]) continue;
        const out = level / 7.5 - 1;
        if (this.nr51 & (0x10 << k)) l += out;
        if (this.nr51 & (0x01 << k)) r += out;
      }
      l *= (((this.nr50 >> 4) & 7) + 1) / 32;
      r *= ((this.nr50 & 7) + 1) / 32;
      // The output capacitor takes out the DC.
      const ol = l - this.capL, or = r - this.capR;
      this.capL = l - ol * this.charge;
      this.capR = r - or * this.charge;
      left[i] = ol;
      right[i] = or;
    }
    return { left, right };
  }
}
