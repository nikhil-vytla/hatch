import { lazy, Suspense, useState } from "react";
const LiveTetris = lazy(() => import("./live-tetris").then(m => ({ default: m.LiveTetris })));
const Comparison = lazy(() => import("./outcome-framing").then(m => ({ default: m.Tetris })));

/**
 * Tetris opens on the recorded Jev comparison: that is where Jev's answers are. The play tab's
 * boards start on a code planner with an artificial delay until a lane is switched to Jev.
 */
export function TetrisExperience({ result }: { result: any }) {
  const [tab, setTab] = useState<"play" | "comparison">("comparison");
  return <div>
    <div className="pills" role="group" aria-label="Tetris experience" style={{ marginBottom: 24 }}>
      <button className={tab === "comparison" ? "active" : ""} aria-pressed={tab === "comparison"} onClick={() => setTab("comparison")}>Recorded Jev comparison</button>
      <button className={tab === "play" ? "active" : ""} aria-pressed={tab === "play"} onClick={() => setTab("play")}>Play & branch</button>
    </div>
    <Suspense fallback={<div className="loading-stage">Opening the game…</div>}>
      <div hidden={tab !== "play"}>
        <p className="fine">Both boards start on a code planner with an artificial delay, so nothing on these boards is Jev until you switch a lane to Live Jev (your key).</p>
        <LiveTetris active={tab === "play"} />
      </div>
      {tab === "comparison" && <Comparison result={result} />}
    </Suspense>
  </div>;
}
