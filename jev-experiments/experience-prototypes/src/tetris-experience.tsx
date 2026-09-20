import { lazy, Suspense, useState } from "react";
const LiveTetris = lazy(() => import("./live-tetris").then(m => ({ default: m.LiveTetris })));
const Comparison = lazy(() => import("./outcome-framing").then(m => ({ default: m.Tetris })));

export function TetrisExperience({ result }: { result: any }) {
  const [tab, setTab] = useState<"play" | "comparison">("play");
  return <div>
    <div className="pills" role="group" aria-label="Tetris experience" style={{ marginBottom: 24 }}>
      <button className={tab === "play" ? "active" : ""} onClick={() => setTab("play")}>Play & branch</button>
      <button className={tab === "comparison" ? "active" : ""} onClick={() => setTab("comparison")}>Recorded framing comparison</button>
    </div>
    <Suspense fallback={<div className="loading-stage">Opening the game…</div>}>
      <div hidden={tab !== "play"}><LiveTetris active={tab === "play"} /></div>
      {tab === "comparison" && <Comparison result={result} />}
    </Suspense>
  </div>;
}
