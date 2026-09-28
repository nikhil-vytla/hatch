/** `$D.DDDD`, rounded up so a nonzero cost never shows as zero. Matches the daemon's format. */
export function formatUsd(micros: number): string {
  const units = Math.ceil(micros / 100);

  return `$${Math.floor(units / 10_000)}.${String(units % 10_000).padStart(4, "0")}`;
}
