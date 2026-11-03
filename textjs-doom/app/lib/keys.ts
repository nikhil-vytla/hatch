import { DoomKey } from "./doom-engine.js";

/** Browser KeyboardEvent.code -> Doom key. Ctrl is fire, as in vanilla Doom. */
export const CODE_TO_DOOM: Record<string, number> = {
  ArrowUp: DoomKey.UP, ArrowDown: DoomKey.DOWN, ArrowLeft: DoomKey.LEFT, ArrowRight: DoomKey.RIGHT,
  KeyW: DoomKey.UP, KeyS: DoomKey.DOWN, KeyA: DoomKey.STRAFE_L, KeyD: DoomKey.STRAFE_R,
  Comma: DoomKey.STRAFE_L, Period: DoomKey.STRAFE_R,
  ControlLeft: DoomKey.FIRE, ControlRight: DoomKey.FIRE, KeyF: DoomKey.FIRE, KeyJ: DoomKey.FIRE,
  Space: DoomKey.USE, KeyE: DoomKey.USE,
  ShiftLeft: DoomKey.RSHIFT, ShiftRight: DoomKey.RSHIFT, AltLeft: DoomKey.RALT, AltRight: DoomKey.RALT,
  Escape: DoomKey.ESCAPE, Enter: DoomKey.ENTER, NumpadEnter: DoomKey.ENTER, Tab: DoomKey.TAB,
  Backspace: DoomKey.BACKSPACE, Pause: DoomKey.PAUSE, Minus: 0x2d, Equal: 0x3d,
  F1: DoomKey.F1, F2: DoomKey.F2, F3: DoomKey.F3, F4: DoomKey.F4, F5: DoomKey.F5, F6: DoomKey.F6,
  F7: DoomKey.F7, F8: DoomKey.F8, F9: DoomKey.F9, F10: DoomKey.F10, F11: DoomKey.F11,
  KeyY: 121, KeyN: 110,
};
for (let d = 1; d <= 7; d++) CODE_TO_DOOM[`Digit${d}`] = 48 + d;

/**
 * Text.js useInput key -> Doom key, for the terminal (`text run`) and the offscreen
 * test renderer, where only key presses (no releases) are reported.
 */
export function inputToDoom(e: { key: string; input?: string; ctrl?: boolean }): number | null {
  switch (e.key) {
    case "up": return DoomKey.UP;
    case "down": return DoomKey.DOWN;
    case "left": return DoomKey.LEFT;
    case "right": return DoomKey.RIGHT;
    case "return": case "enter": return DoomKey.ENTER;
    case "escape": return DoomKey.ESCAPE;
    case "tab": return DoomKey.TAB;
    case "backspace": return DoomKey.BACKSPACE;
    case "space": return DoomKey.USE;
  }
  const ch = (e.input ?? e.key ?? "").toLowerCase();
  if (ch === " ") return DoomKey.USE;
  if (ch === "f" || ch === "j") return DoomKey.FIRE;
  if (ch === "e") return DoomKey.USE;
  if (ch === "w") return DoomKey.UP;
  if (ch === "s") return DoomKey.DOWN;
  if (ch === "a" || ch === ",") return DoomKey.STRAFE_L;
  if (ch === "d" || ch === ".") return DoomKey.STRAFE_R;
  if (ch.length === 1 && ((ch >= "0" && ch <= "9") || ch === "y" || ch === "n" || ch === "-" || ch === "=")) return ch.charCodeAt(0);
  return null;
}
