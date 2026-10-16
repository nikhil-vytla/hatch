/**
 * Automations: recurring prompts that spawn sessions with no human in the loop
 * (Open-Inspect's cron automations, minimum viable shape).
 */
export type Automation = {
  readonly id: string;
  readonly name: string;
  readonly prompt: string;
  readonly everyMs: number;
  readonly title?: string;
  enabled: boolean;
  lastRunAt: number | null;
  lastSessionId: string | null;
  runs: number;
  consecutiveFailures: number;
};

export type AutomationRunner = (automation: Automation) => Promise<string>;

export class Automations {
  private readonly items = new Map<string, Automation>();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly run: AutomationRunner,
    private readonly tickMs = 10_000,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.tickMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  add(input: {
    id: string;
    name: string;
    prompt: string;
    everyMs: number;
    title?: string;
  }): Automation {
    const automation: Automation = {
      ...input,
      enabled: true,
      lastRunAt: null,
      lastSessionId: null,
      runs: 0,
      consecutiveFailures: 0,
    };
    this.items.set(automation.id, automation);
    return automation;
  }

  remove(id: string): boolean {
    return this.items.delete(id);
  }

  list(): Automation[] {
    return [...this.items.values()];
  }

  get(id: string): Automation | undefined {
    return this.items.get(id);
  }

  /** Run due automations. Pauses one after 3 consecutive failures (Open-Inspect rule). */
  async tick(now = Date.now()): Promise<string[]> {
    const ran: string[] = [];
    for (const a of this.items.values()) {
      if (!a.enabled) continue;
      if (a.lastRunAt !== null && now - a.lastRunAt < a.everyMs) continue;
      a.lastRunAt = now;
      try {
        a.lastSessionId = await this.run(a);
        a.runs += 1;
        a.consecutiveFailures = 0;
        ran.push(a.id);
      } catch {
        a.consecutiveFailures += 1;
        if (a.consecutiveFailures >= 3) a.enabled = false;
      }
    }
    return ran;
  }
}
