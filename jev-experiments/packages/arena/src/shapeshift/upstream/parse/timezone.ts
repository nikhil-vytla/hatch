export type Zone = { label: string; tz: string };
export type TimezoneData = {
  /** The instant being converted (now when no time was given). */
  instant: Date | null;
  isNow: boolean;
  from: Zone;
  to: Zone | null;
};

/** Abbreviations and cities → IANA zones. Labels are what the card shows. */
export const ZONES: Record<string, Zone> = {
  pst: { label: "PT", tz: "America/Los_Angeles" },
  pdt: { label: "PT", tz: "America/Los_Angeles" },
  pt: { label: "PT", tz: "America/Los_Angeles" },
  "san francisco": { label: "San Francisco", tz: "America/Los_Angeles" },
  sf: { label: "San Francisco", tz: "America/Los_Angeles" },
  "los angeles": { label: "Los Angeles", tz: "America/Los_Angeles" },
  la: { label: "Los Angeles", tz: "America/Los_Angeles" },
  seattle: { label: "Seattle", tz: "America/Los_Angeles" },
  mst: { label: "MT", tz: "America/Denver" },
  denver: { label: "Denver", tz: "America/Denver" },
  cst: { label: "CT", tz: "America/Chicago" },
  chicago: { label: "Chicago", tz: "America/Chicago" },
  est: { label: "ET", tz: "America/New_York" },
  edt: { label: "ET", tz: "America/New_York" },
  et: { label: "ET", tz: "America/New_York" },
  "new york": { label: "New York", tz: "America/New_York" },
  nyc: { label: "New York", tz: "America/New_York" },
  toronto: { label: "Toronto", tz: "America/Toronto" },
  utc: { label: "UTC", tz: "UTC" },
  gmt: { label: "GMT", tz: "Europe/London" },
  london: { label: "London", tz: "Europe/London" },
  bst: { label: "London", tz: "Europe/London" },
  cet: { label: "CET", tz: "Europe/Paris" },
  paris: { label: "Paris", tz: "Europe/Paris" },
  berlin: { label: "Berlin", tz: "Europe/Berlin" },
  amsterdam: { label: "Amsterdam", tz: "Europe/Amsterdam" },
  dubai: { label: "Dubai", tz: "Asia/Dubai" },
  ist: { label: "IST", tz: "Asia/Kolkata" },
  india: { label: "India", tz: "Asia/Kolkata" },
  mumbai: { label: "Mumbai", tz: "Asia/Kolkata" },
  delhi: { label: "Delhi", tz: "Asia/Kolkata" },
  bangalore: { label: "Bangalore", tz: "Asia/Kolkata" },
  bengaluru: { label: "Bengaluru", tz: "Asia/Kolkata" },
  singapore: { label: "Singapore", tz: "Asia/Singapore" },
  sgt: { label: "Singapore", tz: "Asia/Singapore" },
  "hong kong": { label: "Hong Kong", tz: "Asia/Hong_Kong" },
  tokyo: { label: "Tokyo", tz: "Asia/Tokyo" },
  jst: { label: "Tokyo", tz: "Asia/Tokyo" },
  seoul: { label: "Seoul", tz: "Asia/Seoul" },
  sydney: { label: "Sydney", tz: "Australia/Sydney" },
  aest: { label: "Sydney", tz: "Australia/Sydney" },
  auckland: { label: "Auckland", tz: "Pacific/Auckland" },
};

const ZONE_PATTERN = Object.keys(ZONES)
  .sort((a, b) => b.length - a.length)
  .join("|");
const ZONE_RE = new RegExp(`\\b(${ZONE_PATTERN})\\b`, "gi");

export function localZone(): Zone {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return { label: "Local", tz };
}

/** Minutes the zone is ahead of UTC at that instant. */
export function tzOffset(tz: string, at: Date) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric" })
      .formatToParts(at)
      .map((p) => [p.type, p.value]),
  );
  const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute);
  return Math.round((asUtc - at.getTime()) / 60_000);
}

/** Calendar date (y/m/d) of an instant as seen in a zone. */
function ymdIn(tz: string, at: Date) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: tz, year: "numeric", month: "numeric", day: "numeric" }).formatToParts(at).map((x) => [x.type, x.value]),
  );
  return { y: +p.year, m: +p.month - 1, d: +p.day };
}

/** The instant when the wall clock in `tz` reads h:m on the zone's current date. */
export function wallTimeToInstant(tz: string, h: number, m: number, ref: Date) {
  const { y, m: mo, d } = ymdIn(tz, ref);
  const guess = Date.UTC(y, mo, d, h, m);
  let at = new Date(guess - tzOffset(tz, new Date(guess)) * 60_000);
  at = new Date(guess - tzOffset(tz, at) * 60_000); // settle across DST edges
  return at;
}

export function formatIn(tz: string, at: Date) {
  return new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" }).format(at);
}

/** −1, 0 or +1: which day the target sees relative to the source. */
export function dayShift(fromTz: string, toTz: string, at: Date) {
  const a = ymdIn(fromTz, at);
  const b = ymdIn(toTz, at);
  return Math.sign(Date.UTC(b.y, b.m, b.d) - Date.UTC(a.y, a.m, a.d));
}

export function parseTimezone(text: string, ref: Date = new Date()): TimezoneData {
  const t = text.toLowerCase();
  const hits = [...t.matchAll(ZONE_RE)].map((m) => ({ zone: ZONES[m[1]], index: m.index ?? 0 }));

  const time = t.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b|\b(\d{1,2}):(\d{2})\b|\b(noon|midnight)\b/);
  let hm: [number, number] | null = null;
  if (time) {
    if (time[6]) hm = time[6] === "noon" ? [12, 0] : [0, 0];
    else if (time[3]) {
      let h = Number(time[1]) % 12;
      if (time[3] === "pm") h += 12;
      hm = [h, Number(time[2] ?? 0)];
    } else hm = [Number(time[4]), Number(time[5])];
  }

  // "3pm pst in ist" → pst → ist.
  // One zone: "in/to tokyo" (or no time given) converts local → tokyo; "3pm pst" reads pst → local.
  let from: Zone;
  let to: Zone | null;
  if (hits.length >= 2) {
    from = hits[0].zone;
    to = hits[1].zone;
  } else if (hits.length === 1) {
    const before = t.slice(0, hits[0].index).trimEnd();
    const isTarget = /\b(?:in|to|into|for|at)$/.test(before) || !hm;
    from = isTarget ? localZone() : hits[0].zone;
    to = isTarget ? hits[0].zone : localZone();
  } else {
    from = localZone();
    to = null;
  }

  const instant = hm ? wallTimeToInstant(from.tz, hm[0], hm[1], ref) : ref;
  return { instant, isNow: !hm, from, to };
}

export function completeTimezone(d: TimezoneData) {
  return (d.to ? 0.7 : 0) + (d.isNow ? 0.1 : 0.3);
}
