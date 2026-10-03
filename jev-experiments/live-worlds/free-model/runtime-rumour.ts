/**
 * The free model's rumour-mill network, kept apart from runtime.ts so Who can you win over?
 * doesn't bundle it. It was trained and scored like the rest of Bramble mini, but it didn't beat
 * the rumour mill's current free model on the gold rumours, so no page uses it; the evaluation
 * script and tests do.
 */
import { allProfiles, type Dist, type MessageKind } from "../rumour/profiles";
import type { PlaceId as RumourPlace } from "../rumour/town";
import { profileInput, RUMOUR_ACTIONS } from "./features";
import { load, run, type NetFile } from "./model";
import { netBytes } from "./runtime";
import profileFile from "./weights/profile.json";

// SAFETY: the weight file is written by train.py in NetFile's shape.
const profile = load(profileFile as NetFile);

/** Committed size of the rumour-mill network, in bytes of float32 weights. */
export const PROFILE_WEIGHT_BYTES = netBytes(profile);

/** Every profile's odds for one message (and, for a correction, the rumour it corrects). */
export function profileDists(msg: ArrayLike<number>, rumour: ArrayLike<number> | null, kind: MessageKind, place: RumourPlace | null) {
  const hasPlace = kind === "rumour" && !!place;
  const mask = { action: hasPlace ? [] : ["go"] };

  return new Map(
    allProfiles(kind).map((p) => {
      const o = run(profile, profileInput(msg, kind === "counter" ? rumour : null, kind, p, hasPlace), mask).action;
      const d = Object.fromEntries(RUMOUR_ACTIONS.map((a) => [a, o[a] ?? 0]));

      // SAFETY: d has exactly the four rumour actions.
      return [p.key, d as Dist];
    }),
  );
}
