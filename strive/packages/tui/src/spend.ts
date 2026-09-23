// A session's spend, folded from its journal events with the daemon
// ledger's rules: complete calls cost what they cost, rejected calls nothing,
// broken calls their full hold; calls in flight are held.
import type { Event } from "@strive/protocol";
import { formatUsd } from "./format";

export class Spend {
  usdLimit?: number;
  tokenLimit?: number;
  spentUsd = 0;
  spentTokens = 0;
  private readonly held = new Map<number, number>();

  apply(e: Event): void {
    switch (e.type) {
      case "budgetSet":
        this.usdLimit = e.usdMicros;
        this.tokenLimit = e.tokens;
        return;
      case "modelCallStarted":
        this.held.set(e.call, e.reservedUsdMicros);
        return;
      case "modelCallFinished": {
        this.held.delete(e.call);
        const o = e.outcome;
        if (o.kind === "complete") {
          this.spentUsd += o.costUsdMicros;
                    const u = o.usage;
          this.spentTokens += u.input + u.output + u.cacheRead + u.cacheWrite + u.cacheWriteLong;
        } else if (o.kind === "broken") {
          this.spentUsd += o.costUsdMicros;
          this.spentTokens += o.tokens;
        }
        return;
      }
      case "sessionStarted":
      case "userMessage":
      case "recovered":
      case "effectStarted":
      case "effectFinished":
      case "approvalModeSet":
      case "approvalRequested":
            case "approvalDecided":
      case "checkpointed":
      case "rewound":
        return;
    }
  }

  summary(): string {
    const parts = [
      this.usdLimit === undefined
        ? `${formatUsd(this.spentUsd)} spent · no budget`
        : `${formatUsd(this.spentUsd)} of ${formatUsd(this.usdLimit)}`,
    ];
    if (this.tokenLimit !== undefined) parts.push(`${this.spentTokens} of ${this.tokenLimit} tokens`);
    const holding = [...this.held.values()].reduce((a, b) => a + b, 0);
    if (holding > 0) parts.push(`holding ${formatUsd(holding)}`);
    return parts.join(" · ");
  }
}
