/**
 * Sound -- the game's own driver, run under sm83.js, feeding the APU
 * (apu.js).
 *
 * The driver lives in bank 7 behind a jump table:
 *
 *   $6389  init                 once, at power-on
 *   $638c  sound effect A       from game code
 *   $638f  music A              from game code (07:$656d)
 *   $6395  update, part 1       every VBlank ($0254)
 *   $6398  update, part 2       every VBlank ($0257)
 *
 * It keeps all its state in its own RAM, so one persistent CPU running the
 * same calls in the same order writes the same APU registers. Those writes
 * ($ff10..$ff3f) are what the APU turns into sound. Verified write for
 * write against the game (web/test/audioparity.mjs).
 */

import { CPU } from './sm83.js';
import { Apu, FRAME_CYCLES } from './apu.js';

export const DRIVER = { init: 0x6389, effect: 0x638c, music: 0x638f, update1: 0x6395, update2: 0x6398 };
const SENTINEL = 0xdead;

/**
 * What reading an APU register returns: the bits that do not read back
 * are 1 ($ff10..$ff2f, as on the hardware). The driver reads NR32 back
 * ($ff1c, the wave volume) and writes it again with the unused bits set.
 * NR52's channel flags are not modelled.
 */
const READ_MASK = [
  0x80, 0x3f, 0x00, 0xff, 0xbf, 0xff, 0x3f, 0x00, 0xff, 0xbf,
  0x7f, 0xff, 0x9f, 0xff, 0xbf, 0xff, 0xff, 0x00, 0x00, 0xbf,
  0x00, 0x00, 0x70, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
];

/** A CPU that reports APU register writes. */
class DriverCpu extends CPU {
  constructor(rom) {
    super(rom, 7);
    this.writes = [];
  }

  rd(addr) {
    addr &= 0xffff;
    if (addr >= 0xff10 && addr < 0xff30) return this.mem[addr] | READ_MASK[addr - 0xff10];
    return super.rd(addr);
  }

  wr(addr, val) {
    addr &= 0xffff;
    if (addr >= 0xff10 && addr < 0xff40) this.writes.push([addr, val & 0xff]);
    super.wr(addr, val);
  }
}

export class SoundDriver {
  /** @param {Uint8Array} romBytes the whole ROM */
  constructor(romBytes) {
    this.cpu = new DriverCpu(romBytes);
    this.depth = 0;
  }

  /**
   * Run one driver entry with these registers; returns the APU writes it
   * made, as [address, value] pairs in order. `interrupts` ([{ at, run }],
   * by `at`): after `at` of its own instructions, `run()` -- the VBlank
   * handler calling the driver in the middle of this call, as it can in
   * the game. Their writes come in between, in order.
   */
  call(entry, { a = 0, bc = 0, de = 0, hl = 0 } = {}, interrupts = []) {
    const cpu = this.cpu;
    const outerWrites = cpu.writes;
    const outer = { a: cpu.a, f: cpu.f, bc: cpu.bc, de: cpu.de, hl: cpu.hl, sp: cpu.sp, pc: cpu.pc, bank: cpu.bank };
    const nested = this.depth > 0;
    this.depth++;
    cpu.setBank(7);
    cpu.a = a; cpu.bc = bc; cpu.de = de; cpu.hl = hl;
    // Below the interrupted call's stack, as the interrupt's pushes are.
    cpu.sp = nested ? (outer.sp - 0x10) & 0xffff : 0xfffe;
    cpu.push16(SENTINEL);
    cpu.pc = entry;
    const writes = cpu.writes = [];
    let own = 0, next = 0;
    while (cpu.pc !== SENTINEL) {
      if (own > 1_000_000) throw new Error(`sound driver $${entry.toString(16)} did not return`);
      while (next < interrupts.length && own === interrupts[next].at) {
        const saved = { a: cpu.a, f: cpu.f, bc: cpu.bc, de: cpu.de, hl: cpu.hl, sp: cpu.sp, pc: cpu.pc, bank: cpu.bank };
        interrupts[next++].run();
        Object.assign(cpu, { a: saved.a, f: saved.f, bc: saved.bc, de: saved.de, hl: saved.hl, sp: saved.sp, pc: saved.pc });
        cpu.setBank(saved.bank);
        cpu.writes = writes;
      }
      cpu.step();
      own++;
    }
    this.depth--;
    if (nested) {
      Object.assign(cpu, { a: outer.a, f: outer.f, bc: outer.bc, de: outer.de, hl: outer.hl, sp: outer.sp, pc: outer.pc });
      cpu.setBank(outer.bank);
      outerWrites.push(...writes);
      cpu.writes = outerWrites;
    }
    return writes;
  }

  init() { return this.call(DRIVER.init); }
  effect(a) { return this.call(DRIVER.effect, { a }); }
  music(a) { return this.call(DRIVER.music, { a }); }
  /** What the VBlank handler runs, both parts. */
  update() { return [...this.call(DRIVER.update1), ...this.call(DRIVER.update2)]; }
}

/**
 * The driver and an APU together, as the game uses them: init at power-on,
 * effects and music when game code asks, and `frame()` once per VBlank --
 * the driver's update, then a frame of samples.
 */
export class GameSound {
  constructor(romBytes, rate = 48000) {
    this.driver = new SoundDriver(romBytes);
    this.apu = new Apu(rate);
    this.apply(this.driver.init());
  }

  apply(writes) {
    for (const [addr, v] of writes) this.apu.write(addr, v);
  }

  effect(a) { this.apply(this.driver.effect(a)); }
  music(a) { this.apply(this.driver.music(a)); }

  /** $dfef: the driver's flag that a tune has ended (the boss music, $065a). */
  get tuneEnded() { return this.driver.cpu.mem[0xdfef]; }
  set tuneEnded(v) { this.driver.cpu.mem[0xdfef] = v; }

  /** One VBlank: the driver's update, then one frame of stereo samples. */
  frame() {
    this.apply(this.driver.update());
    return this.apu.render(FRAME_CYCLES);
  }
}
