/**
 * Pacing: the page ticks the game at the Game Boy's own rate, whatever the
 * display's refresh. A tick is one VBlank (play.js `tick`, and the sound
 * driver's update with one VBlank of samples, audio.js); the LCD does one
 * every 70,224 clocks of 4,194,304 Hz, 59.73 a second. requestAnimationFrame
 * runs at the display's rate -- 60, 120, 144 Hz -- so each of its frames
 * runs as many ticks as are due by the clock. A hiccup (a quarter of a
 * second) is caught up; after a long gap (a tab in the background) the
 * game does not race: at most `max` ticks, the rest dropped (counted in
 * `dropped`).
 */

export const VBLANK_HZ = 4194304 / 70224;

export function createPacer(now) {
  return { last: now, owed: 0, dropped: 0 };
}

/** The ticks due at `now` (milliseconds). */
export function ticksDue(pacer, now, max = 15) {
  pacer.owed += ((now - pacer.last) * VBLANK_HZ) / 1000;
  pacer.last = now;
  const n = Math.max(0, Math.min(Math.floor(pacer.owed), max));
  // What is left is at most a tick: a gap's backlog is dropped.
  const rest = pacer.owed - n;
  pacer.dropped += Math.max(0, rest - 1);
  pacer.owed = Math.min(rest, 1);
  return n;
}
