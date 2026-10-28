/**
 * Minimal SM83 interpreter, enough to run individual ROM routines.
 *
 * This exists for one reason: the game's asset decompressor is a bitstream
 * codec that would be easy to reimplement *almost* correctly. Running the
 * original routine instead makes the output correct by construction -- if it
 * reaches its `ret`, the bytes it produced are the bytes the real game
 * produces. The Python twin in ../../tools/sm83.py is the reference; the
 * node check cross-validates this port against it.
 *
 * Not an emulator: no PPU, no timers, no interrupts, no cycle counting.
 * Memory is flat 64 KiB with an MBC1-style bank window at $4000-$7fff.
 * Unimplemented opcodes throw rather than guessing, so a wrong assumption
 * fails loudly instead of producing plausible garbage.
 */

const BANK_SIZE = 0x4000;
const FZ = 0x80, FN = 0x40, FH = 0x20, FC = 0x10;

export class UnsupportedOpcode extends Error {}

export class CPU {
  /**
   * @param {Uint8Array} rom whole ROM image
   * @param {number} bank bank mapped at $4000
   * @param {number} stat value reported for rSTAT; 0 lets VRAM wait loops pass
   */
  constructor(rom, bank = 1, stat = 0x00) {
    this.rom = rom;
    this.mem = new Uint8Array(0x10000);
    this.mem.set(rom.subarray(0, BANK_SIZE), 0);
    this.stat = stat;
    this.setBank(bank);
    this.a = this.b = this.c = this.d = this.e = this.h = this.l = 0;
    this.f = 0;
    this.sp = 0xfffe;
    this.pc = 0;
    this.steps = 0;
  }

  setBank(bank) {
    this.bank = bank;
    const off = bank * BANK_SIZE;
    this.mem.set(this.rom.subarray(off, off + BANK_SIZE), BANK_SIZE);
  }

  rd(addr) {
    addr &= 0xffff;
    if (addr === 0xff41) return this.stat; // rSTAT
    return this.mem[addr];
  }

  wr(addr, val) {
    addr &= 0xffff;
    if (addr < 0x8000) {
      // MBC1 bank register. Bank 0 is not selectable; it reads as 1.
      if (addr >= 0x2000 && addr < 0x4000) this.setBank(Math.max(1, val & 0x1f));
      return; // ROM is not writable
    }
    this.mem[addr] = val & 0xff;
  }

  get hl() { return (this.h << 8) | this.l; }
  set hl(v) { v &= 0xffff; this.h = v >> 8; this.l = v & 0xff; }
  get de() { return (this.d << 8) | this.e; }
  set de(v) { v &= 0xffff; this.d = v >> 8; this.e = v & 0xff; }
  get bc() { return (this.b << 8) | this.c; }
  set bc(v) { v &= 0xffff; this.b = v >> 8; this.c = v & 0xff; }

  fetch() { const v = this.rd(this.pc); this.pc = (this.pc + 1) & 0xffff; return v; }
  fetch16() { const lo = this.fetch(); return lo | (this.fetch() << 8); }

  setf(z, n, h, c) {
    if (z !== null) this.f = z ? this.f | FZ : this.f & ~FZ;
    if (n !== null) this.f = n ? this.f | FN : this.f & ~FN;
    if (h !== null) this.f = h ? this.f | FH : this.f & ~FH;
    if (c !== null) this.f = c ? this.f | FC : this.f & ~FC;
    this.f &= 0xf0;
  }

  add8(val, carry = 0) {
    const a = this.a, r = a + val + carry;
    this.setf((r & 0xff) === 0, false, ((a & 0xf) + (val & 0xf) + carry) > 0xf, r > 0xff);
    this.a = r & 0xff;
  }

  sub8(val, carry = 0, store = true) {
    const a = this.a, r = a - val - carry;
    this.setf((r & 0xff) === 0, true, ((a & 0xf) - (val & 0xf) - carry) < 0, r < 0);
    if (store) this.a = r & 0xff;
  }

  inc8(v) { const r = (v + 1) & 0xff; this.setf(r === 0, false, (v & 0xf) === 0xf, null); return r; }
  dec8(v) { const r = (v - 1) & 0xff; this.setf(r === 0, true, (v & 0xf) === 0, null); return r; }

  getR(i) {
    switch (i) {
      case 0: return this.b; case 1: return this.c; case 2: return this.d;
      case 3: return this.e; case 4: return this.h; case 5: return this.l;
      case 6: return this.rd(this.hl); default: return this.a;
    }
  }

  setR(i, v) {
    v &= 0xff;
    switch (i) {
      case 0: this.b = v; break; case 1: this.c = v; break; case 2: this.d = v; break;
      case 3: this.e = v; break; case 4: this.h = v; break; case 5: this.l = v; break;
      case 6: this.wr(this.hl, v); break; default: this.a = v;
    }
  }

  cond(i) {
    switch (i) {
      case 0: return !(this.f & FZ); case 1: return !!(this.f & FZ);
      case 2: return !(this.f & FC); default: return !!(this.f & FC);
    }
  }

  push16(v) {
    this.sp = (this.sp - 1) & 0xffff; this.mem[this.sp] = (v >> 8) & 0xff;
    this.sp = (this.sp - 1) & 0xffff; this.mem[this.sp] = v & 0xff;
  }

  pop16() {
    const lo = this.mem[this.sp]; this.sp = (this.sp + 1) & 0xffff;
    const hi = this.mem[this.sp]; this.sp = (this.sp + 1) & 0xffff;
    return lo | (hi << 8);
  }

  cb() {
    const op = this.fetch();
    const idx = op & 7, kind = op >> 3;
    const v = this.getR(idx);
    let c, r;
    switch (true) {
      case kind === 0: c = v >> 7; r = ((v << 1) | c) & 0xff;
        this.setf(r === 0, false, false, !!c); this.setR(idx, r); return;
      case kind === 1: c = v & 1; r = ((v >> 1) | (c << 7)) & 0xff;
        this.setf(r === 0, false, false, !!c); this.setR(idx, r); return;
      case kind === 2: c = this.f & FC ? 1 : 0; r = ((v << 1) | c) & 0xff;
        this.setf(r === 0, false, false, !!(v >> 7)); this.setR(idx, r); return;
      case kind === 3: c = this.f & FC ? 1 : 0; r = ((v >> 1) | (c << 7)) & 0xff;
        this.setf(r === 0, false, false, !!(v & 1)); this.setR(idx, r); return;
      case kind === 4: r = (v << 1) & 0xff;
        this.setf(r === 0, false, false, !!(v >> 7)); this.setR(idx, r); return;
      case kind === 5: r = ((v >> 1) | (v & 0x80)) & 0xff;
        this.setf(r === 0, false, false, !!(v & 1)); this.setR(idx, r); return;
      case kind === 6: r = ((v << 4) | (v >> 4)) & 0xff;
        this.setf(r === 0, false, false, false); this.setR(idx, r); return;
      case kind === 7: r = v >> 1;
        this.setf(r === 0, false, false, !!(v & 1)); this.setR(idx, r); return;
      case kind < 16: this.setf(!((v >> (kind - 8)) & 1), false, true, null); return;
      case kind < 24: this.setR(idx, v & ~(1 << (kind - 16))); return;
      default: this.setR(idx, v | (1 << (kind - 24)));
    }
  }

  step() {
    this.steps++;
    const op = this.fetch();

    if (op === 0x00) return;
    if (op === 0xcb) return this.cb();
    if (op === 0x37) return this.setf(null, false, false, true);
    if (op === 0x3f) return this.setf(null, false, false, !(this.f & FC));
    if (op === 0x2f) { this.a ^= 0xff; return this.setf(null, true, true, null); }
    if (op === 0xf3 || op === 0xfb) return;
    if (op === 0x76) throw new UnsupportedOpcode('halt reached; parameters are wrong');
    if (op === 0x10) throw new UnsupportedOpcode('stop reached; parameters are wrong');

    if (op === 0x08) { const t = this.fetch16(); this.wr(t, this.sp & 0xff); this.wr(t + 1, this.sp >> 8); return; }
    if (op === 0xf9) { this.sp = this.hl; return; }

    // 16-bit immediate loads
    if (op === 0x01 || op === 0x11 || op === 0x21 || op === 0x31) {
      const v = this.fetch16();
      if (op === 0x01) this.bc = v; else if (op === 0x11) this.de = v;
      else if (op === 0x21) this.hl = v; else this.sp = v;
      return;
    }

    if ((op & 0xc7) === 0x06 && op < 0x40) return this.setR((op >> 3) & 7, this.fetch());
    if (op >= 0x40 && op < 0x80) return this.setR((op >> 3) & 7, this.getR(op & 7));

    if (op >= 0x80 && op < 0xc0) {
      const v = this.getR(op & 7), k = (op >> 3) & 7;
      switch (k) {
        case 0: return this.add8(v);
        case 1: return this.add8(v, this.f & FC ? 1 : 0);
        case 2: return this.sub8(v);
        case 3: return this.sub8(v, this.f & FC ? 1 : 0);
        case 4: this.a &= v; return this.setf(this.a === 0, false, true, false);
        case 5: this.a ^= v; return this.setf(this.a === 0, false, false, false);
        case 6: this.a |= v; return this.setf(this.a === 0, false, false, false);
        default: return this.sub8(v, 0, false);
      }
    }

    if (op === 0xc6 || op === 0xce || op === 0xd6 || op === 0xde ||
        op === 0xe6 || op === 0xee || op === 0xf6 || op === 0xfe) {
      const v = this.fetch();
      switch (op) {
        case 0xc6: return this.add8(v);
        case 0xce: return this.add8(v, this.f & FC ? 1 : 0);
        case 0xd6: return this.sub8(v);
        case 0xde: return this.sub8(v, this.f & FC ? 1 : 0);
        case 0xe6: this.a &= v; return this.setf(this.a === 0, false, true, false);
        case 0xee: this.a ^= v; return this.setf(this.a === 0, false, false, false);
        case 0xf6: this.a |= v; return this.setf(this.a === 0, false, false, false);
        default: return this.sub8(v, 0, false);
      }
    }

    if ((op & 0xc7) === 0x04 && op < 0x40) { const i = (op >> 3) & 7; return this.setR(i, this.inc8(this.getR(i))); }
    if ((op & 0xc7) === 0x05 && op < 0x40) { const i = (op >> 3) & 7; return this.setR(i, this.dec8(this.getR(i))); }

    if (op === 0x03) { this.bc = this.bc + 1; return; }
    if (op === 0x13) { this.de = this.de + 1; return; }
    if (op === 0x23) { this.hl = this.hl + 1; return; }
    if (op === 0x33) { this.sp = (this.sp + 1) & 0xffff; return; }
    if (op === 0x0b) { this.bc = this.bc - 1; return; }
    if (op === 0x1b) { this.de = this.de - 1; return; }
    if (op === 0x2b) { this.hl = this.hl - 1; return; }
    if (op === 0x3b) { this.sp = (this.sp - 1) & 0xffff; return; }

    if (op === 0x09 || op === 0x19 || op === 0x29 || op === 0x39) {
      const v = op === 0x09 ? this.bc : op === 0x19 ? this.de : op === 0x29 ? this.hl : this.sp;
      const hl = this.hl, r = hl + v;
      this.setf(null, false, ((hl & 0xfff) + (v & 0xfff)) > 0xfff, r > 0xffff);
      this.hl = r; return;
    }

    if (op === 0x07) { const c = this.a >> 7; this.a = ((this.a << 1) | c) & 0xff; return this.setf(false, false, false, !!c); }
    if (op === 0x0f) { const c = this.a & 1; this.a = ((this.a >> 1) | (c << 7)) & 0xff; return this.setf(false, false, false, !!c); }
    if (op === 0x17) { const c = this.f & FC ? 1 : 0, nc = this.a >> 7; this.a = ((this.a << 1) | c) & 0xff; return this.setf(false, false, false, !!nc); }
    if (op === 0x1f) { const c = this.f & FC ? 1 : 0, nc = this.a & 1; this.a = ((this.a >> 1) | (c << 7)) & 0xff; return this.setf(false, false, false, !!nc); }

    if (op === 0x02) return this.wr(this.bc, this.a);
    if (op === 0x12) return this.wr(this.de, this.a);
    if (op === 0x22) { this.wr(this.hl, this.a); this.hl = this.hl + 1; return; }
    if (op === 0x32) { this.wr(this.hl, this.a); this.hl = this.hl - 1; return; }
    if (op === 0x0a) { this.a = this.rd(this.bc); return; }
    if (op === 0x1a) { this.a = this.rd(this.de); return; }
    if (op === 0x2a) { this.a = this.rd(this.hl); this.hl = this.hl + 1; return; }
    if (op === 0x3a) { this.a = this.rd(this.hl); this.hl = this.hl - 1; return; }
    if (op === 0xea) return this.wr(this.fetch16(), this.a);
    if (op === 0xfa) { this.a = this.rd(this.fetch16()); return; }
    if (op === 0xe0) return this.wr(0xff00 + this.fetch(), this.a);
    if (op === 0xf0) { this.a = this.rd(0xff00 + this.fetch()); return; }
    if (op === 0xe2) return this.wr(0xff00 + this.c, this.a);
    if (op === 0xf2) { this.a = this.rd(0xff00 + this.c); return; }

    if (op === 0xc5) return this.push16(this.bc);
    if (op === 0xd5) return this.push16(this.de);
    if (op === 0xe5) return this.push16(this.hl);
    if (op === 0xf5) return this.push16((this.a << 8) | this.f);
    if (op === 0xc1) { this.bc = this.pop16(); return; }
    if (op === 0xd1) { this.de = this.pop16(); return; }
    if (op === 0xe1) { this.hl = this.pop16(); return; }
    if (op === 0xf1) { const v = this.pop16(); this.a = v >> 8; this.f = v & 0xf0; return; }

    if (op === 0xc3) { this.pc = this.fetch16(); return; }
    if (op === 0xe9) { this.pc = this.hl; return; }
    if (op === 0x18) { let o = this.fetch(); if (o > 127) o -= 256; this.pc = (this.pc + o) & 0xffff; return; }
    if (op === 0x20 || op === 0x28 || op === 0x30 || op === 0x38) {
      let o = this.fetch(); if (o > 127) o -= 256;
      if (this.cond((op >> 3) & 3)) this.pc = (this.pc + o) & 0xffff;
      return;
    }
    if (op === 0xc2 || op === 0xca || op === 0xd2 || op === 0xda) {
      const t = this.fetch16(); if (this.cond((op >> 3) & 3)) this.pc = t; return;
    }
    if (op === 0xcd) { const t = this.fetch16(); this.push16(this.pc); this.pc = t; return; }
    if (op === 0xc4 || op === 0xcc || op === 0xd4 || op === 0xdc) {
      const t = this.fetch16();
      if (this.cond((op >> 3) & 3)) { this.push16(this.pc); this.pc = t; }
      return;
    }
    if (op === 0xc9 || op === 0xd9) { this.pc = this.pop16(); return; }
    if (op === 0xc0 || op === 0xc8 || op === 0xd0 || op === 0xd8) {
      if (this.cond((op >> 3) & 3)) this.pc = this.pop16();
      return;
    }
    if ((op & 0xc7) === 0xc7) { this.push16(this.pc); this.pc = op & 0x38; return; }

    throw new UnsupportedOpcode(
      `opcode $${op.toString(16).padStart(2, '0')} at $${((this.pc - 1) & 0xffff).toString(16).padStart(4, '0')}`);
  }
}

/**
 * Execute one ROM routine and hand back the CPU for inspection.
 * Returns when the routine returns to a sentinel address pushed as its caller.
 */
export function callRoutine(rom, addr, { bank = 1, hl = 0, de = 0, bc = 0, a = 0,
                                         maxSteps = 20_000_000 } = {}) {
  const cpu = new CPU(rom, bank);
  cpu.hl = hl; cpu.de = de; cpu.bc = bc; cpu.a = a;
  cpu.pc = addr;
  cpu.sp = 0xfffe;
  const SENTINEL = 0xdead;
  cpu.push16(SENTINEL);
  while (cpu.steps < maxSteps) {
    if (cpu.pc === SENTINEL) return cpu;
    cpu.step();
  }
  throw new Error(`routine $${addr.toString(16)} did not return in ${maxSteps} steps`);
}
