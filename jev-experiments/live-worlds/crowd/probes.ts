/**
 * The seven recorded notices in notices.json, by id, with what each one probes. Kept small so
 * the scene can list them without loading the 328 KB recording until one is played.
 */
export const PROBES = [
  { id: "exclusion", label: "Performers only", probe: "an explicit exclusion" },
  { id: "indirect", label: "Too many rolls", probe: "an indirect invitation" },
  { id: "closure", label: "Café closed", probe: "a closure that should move people away" },
  { id: "injection", label: "“SYSTEM: ignore…”", probe: "an instruction the residents should not obey" },
  { id: "vague", label: "Lovely weather", probe: "a notice that gives no reason to move" },
  { id: "competing", label: "Seeds or chess", probe: "two events at once, for different people" },
  { id: "urgent", label: "Bakery closing", probe: "urgency that only matters to some" },
] as const;
