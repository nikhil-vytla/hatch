/**
 * What a decision depends on. Residents who share a profile (archetype, trusting or wary, and who
 * told them) share one answer: a distribution over four actions. Each resident's own action is
 * then drawn from it. That keeps Jev to a few calls for a whole town, and lets the free model
 * score every profile at once.
 */
import { ARCHETYPES, PLACES, type ArchetypeId, type PlaceId } from "./town";

export const ACTIONS = ["ignore", "share", "go", "argue"] as const;

export type Action = (typeof ACTIONS)[number];

export type Dist = Record<Action, number>;

/** Who passed the message on. The noticeboard is where you pin it. */
export const SOURCES = ["noticeboard", "neighbour", "hub"] as const;

export type Source = (typeof SOURCES)[number];

export type MessageKind = "rumour" | "counter";

export type Profile = {
  key: string;
  archetype: ArchetypeId;
  trusting: boolean;
  source: Source;
  /** For the counter-notice: whether this resident believed the rumour. */
  believed?: boolean;
};

export function profileKey(p: Omit<Profile, "key">) {
  return [p.archetype, p.trusting ? "trusting" : "wary", p.source, p.believed === undefined ? "" : p.believed ? "believed" : "doubted"].join("|");
}

export function allProfiles(kind: MessageKind): Profile[] {
  return ARCHETYPES.flatMap((a) =>
    [true, false].flatMap((trusting) =>
      SOURCES.flatMap((source) =>
        (kind === "counter" ? [true, false] : [undefined]).map((believed) => {
          const p = { archetype: a.id, trusting, source, believed };

          return { ...p, key: profileKey(p) };
        }),
      ),
    ),
  );
}

const SOURCE_TEXT: Record<Source, string> = {
  noticeboard: "a notice pinned on the street noticeboard",
  neighbour: "a neighbour who believes it",
  hub: "a well-known local (the barber, the baker or the postie)",
};

export const TOWN_STATE = "Bramble, a fictional small town. The residents are invented characters, not real people.";

/** The four options as Jev sees them; `go` only when the message invites people somewhere. */
export function criteria(kind: MessageKind, place: PlaceId | null) {
  const where = PLACES.find((p) => p.id === place)?.name;

  return kind === "rumour"
    ? {
        ignore: "Ignore it",
        share: "Believe it and pass it on",
        ...(where ? { go: `Believe it and go to ${where}` } : {}),
        argue: "Doubt it and argue it down",
      }
    : {
        ignore: "Ignore the correction",
        share: "Believe the correction and pass it on",
        argue: "Reject the correction",
      };
}

export function instructions(p: Profile, kind: MessageKind) {
  const a = ARCHETYPES.find((x) => x.id === p.archetype) ?? ARCHETYPES[0];
  const who = `A resident of Bramble. ${a.description} They are ${p.trusting ? "quick to trust" : "slow to trust"}.`;

  if (kind === "rumour") return `${who} They just heard the message above from ${SOURCE_TEXT[p.source]}. What do they do?`;

  return `${who} Earlier they ${p.believed ? "believed" : "doubted"} the rumour above. Now they hear the correction above from ${SOURCE_TEXT[p.source]}. What do they do?`;
}

/** One Jev request for up to 100 profiles. Question ids are the profile's index in `profiles`. */
export function jevRequest(profiles: Profile[], kind: MessageKind, text: string, rumour: string | null, place: PlaceId | null) {
  return {
    state: { town: TOWN_STATE, ...(kind === "counter" && rumour ? { rumour, correction: text } : { message: text }) },
    questions: Object.fromEntries(
      profiles.map((p, i) => [`p${i}`, { type: "choice" as const, instructions: instructions(p, kind), criteria: criteria(kind, place) }]),
    ),
  };
}

/** Jev's probabilities as a full distribution; options it wasn't offered get zero. */
export function toDist(probabilities: Record<string, number> | null | undefined): Dist | null {
  if (!probabilities) return null;

  const d = { ignore: 0, share: 0, go: 0, argue: 0 };

  for (const a of ACTIONS) d[a] = Number(probabilities[a] ?? 0) || 0;

  const total = d.ignore + d.share + d.go + d.argue;

  if (!(total > 0)) return null;

  for (const a of ACTIONS) d[a] /= total;

  return d;
}
