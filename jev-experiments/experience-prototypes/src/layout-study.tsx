/**
 * The earlier layout study behind Generative interfaces (ui.json), which the page loaded but
 * never showed. Its stored summary divided by all 20 briefs, counting the 8 rate-limited ones
 * as misses; this counts only the briefs that came back.
 */
import { Pane, Stat } from "./shared";

export function LayoutStudy({ result }: { result: any }) {
  const rows: any[] = result?.rows ?? [];
  const done = rows.filter((r) => !r.error);

  if (!done.length) return null;

  const layout = done.filter((r) => r.layout_correct).length;
  const revised = done.filter((r) => r.revision && !r.revision.error);
  const kept = revised.filter((r) => r.revision_preserved_layout).length;

  return (
    <Pane
      title="Does Jev pick the intended layout, and keep it on revision?"
      sub={`${rows.length} authored briefs`}
    >
      <div className="stats-row">
        <Stat
          label="Briefs that came back"
          value={`${done.length} of ${rows.length}`}
          note="The rest hit rate limits"
        />
        <Stat label="Chose the intended layout" value={`${layout} of ${done.length}`} />
        <Stat
          label="Kept the layout when asked to revise"
          value={`${kept} of ${revised.length}`}
          note="Each revision asked for the same layout, easier to scan"
        />
      </div>
      <p className="fine">
        The intended layouts are the fixture author's, not a universal best interface. The record's
        own summary reads 60% and 45% because it divides by all {rows.length} briefs, counting the
        unanswered ones as misses.
      </p>
    </Pane>
  );
}
