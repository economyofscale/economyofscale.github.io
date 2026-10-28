/**
 * The game's flow between levels and lives, ported from the game.
 *
 *   NewGame      $01ae  level 1, 6 lives, no powers, no Force
 *   LevelStart   $01e0  object and player RAM cleared ($c300..$da86), full
 *                       health for player and tauntaun, then the level's
 *                       setup ($0c3c and on)
 *   AfterDeath   $0e76  the next of four death messages (dialog $84); with
 *                       no lives left a new game, else one life less and
 *                       the continue prompt (dialog $c5)
 *   Prompt       $0eb1  Y or N blinks; LEFT/RIGHT switches, A/B answers:
 *                       Y restarts the level, N starts a new game
 *
 * What survives a level start lives at $da87 and above: the death message
 * index $da88, lives $da89, the lightsaber $da91, the item $da92, the
 * Force meter $da95 and the powers $da96..$da9d -- plus the level, $ff8b.
 * `s` holds those, by address.
 */

/** $0f05: the four death messages, in the script. */
export const DEATH_MESSAGES = 0x0f05;
/** The continue prompt's text, and its two blinking letters ($0f0d table). */
export const CONTINUE_PROMPT = 0xd1ae;
export const PROMPT_LETTERS = { yes: 0x0f15, yesBlank: 0x0f19, no: 0x0f1d, noBlank: 0x0f21 };

/** $01ae..$01df */
export function newGame(s) {
  s.ff8b = 1;
  s.da89 = 6;
  s.da91 = 0;
  s.da92 = 0;
  s.da95 = 0;
  for (let a = 0xda96; a <= 0xda9d; a++) s[a.toString(16)] = 0;
}

/** $01e0..$0204: what the level start resets before setting the level up. */
export function levelStart(s) {
  // $15e7 clears $c300..$da86: among it these.
  for (const k of ['da2b', 'da35', 'da43', 'da81']) s[k] = 0;
  s.da93 = 0x20;
  s.da94 = 0x20;
  s.ff8c = 0; s.ff8e = 0; s.ff8f = 0; s.ff8d = 0;
  s.ffa0 = 0xff;
}

/**
 * $0e76 -- after the death loop. Returns what the game shows next: dialog
 * screens ($2566, A and text address), then 'newGame' or 'prompt'.
 */
export function afterDeath(s, rom) {
  s.da88 = (s.da88 + 1) & 0x03;
  const out = [{ ev: 'dialog', a: 0x84, hl: rom.word(0, DEATH_MESSAGES + s.da88 * 2) }];
  if (!s.da89) return [...out, { ev: 'newGame' }];
  s.da89 = (s.da89 - 1) & 0xff;
  return [...out, { ev: 'dialog', a: 0xc5, hl: CONTINUE_PROMPT }, { ev: 'prompt' }];
}

/** $0efa: the prompt's answer, from $d98e bit 2 (set: N). */
export const promptAnswer = (d98e) => (d98e & 0x04 ? 'newGame' : 'levelStart');

/**
 * $0eb1..$0ef5, a pass every 10 VBlanks (five $044d): the selected letter
 * blinks ($d98e bit 1); then, at the next pass, the joypad read: A or B
 * answers, LEFT/RIGHT held switches ($d98e bit 2) and redraws both, and
 * the blink goes on. `first`: the first pass, which reads nothing. Returns
 * the letters to draw, and the answer once given.
 */
export function promptStep(state, joy, first = false) {
  const draw = [];
  if (!first) {
    if (joy & 0x30) return { draw, answer: promptAnswer(state.d98e) };
    if (joy & 0x03) {
      state.d98e ^= 0x04;
      draw.push(PROMPT_LETTERS.yes, PROMPT_LETTERS.no);
    }
  }
  state.d98e ^= 0x02;
  draw.push([0x0f15, 0x0f19, 0x0f1d, 0x0f21][state.d98e >> 1 & 3]);
  return { draw, answer: null };
}
