/**
 * Each live scene's view, as the page shell renders it. Only the experiment page imports this, so
 * the scenes' code stays in their own chunks, loaded when a scene opens. Keyed by scene id: a scene
 * without a view fails the type check.
 */
import { lazy, type ReactNode } from "react";
import type { SceneId } from "./scenes";

/** What a view is given: the loaded record's result, and the companion record's, if the scene has one. */
export type ViewProps = { result: any; composition: any };

const Paste = lazy(() => import("./new-experiments").then((m) => ({ default: m.Paste })));
const GeneratedUI = lazy(() => import("./generated-ui").then((m) => ({ default: m.GeneratedUI })));
const LayoutStudy = lazy(() => import("./layout-study").then((m) => ({ default: m.LayoutStudy })));
const Games = lazy(() => import("./games").then((m) => ({ default: m.Games })));
const Music = lazy(() => import("./music-arranger").then((m) => ({ default: m.Music })));
const JudgmentsScene = lazy(() => import("./judgments-scene").then((m) => ({ default: m.JudgmentsScene })));
const Beverage = lazy(() => import("./cafe-jev").then((m) => ({ default: m.Beverage })));
const AgentExperiment = lazy(() => import("./agent-experiments").then((m) => ({ default: m.AgentExperiment })));
const BenchmarkReport = lazy(() => import("./formats/reports").then((m) => ({ default: m.BenchmarkReport })));
const AnswerKeyReport = lazy(() => import("./formats/reports").then((m) => ({ default: m.AnswerKeyReport })));
const IntentRecognition = lazy(() => import("./intent-recognition").then((m) => ({ default: m.IntentRecognition })));
const Handoff = lazy(() => import("./handoff").then((m) => ({ default: m.Handoff })));
const DecisionsArticle = lazy(() => import("./formats/decisions-article").then((m) => ({ default: m.DecisionsArticle })));
const OpenDecisions = lazy(() => import("./open-decisions").then((m) => ({ default: m.OpenDecisions })));
const DecoyArticle = lazy(() => import("./formats/decoy-article").then((m) => ({ default: m.DecoyArticle })));
const ProseArticle = lazy(() => import("./formats/prose-article").then((m) => ({ default: m.ProseArticle })));
const SpineArticle = lazy(() => import("./formats/spine-article").then((m) => ({ default: m.SpineArticle })));
const JudgeBench = lazy(() => import("./judgment-reliability").then((m) => ({ default: m.JudgeBench })));
const RewardBench = lazy(() => import("./rewardbench").then((m) => ({ default: m.RewardBench })));
const EyesVsState = lazy(() => import("./eyes-vs-state").then((m) => ({ default: m.EyesVsState })));
const CountWithMe = lazy(() => import("./count-with-me").then((m) => ({ default: m.CountWithMe })));
const ArcadeScene = lazy(() => import("./arcade-scene").then((m) => ({ default: m.ArcadeScene })));
const LocalModels = lazy(() => import("./local-models").then((m) => ({ default: m.LocalModels })));
const TetrisExperience = lazy(() => import("./tetris-experience").then((m) => ({ default: m.TetrisExperience })));
const DrawingFraming = lazy(() => import("./outcome-framing").then((m) => ({ default: m.DrawingFraming })));
const VisualSearch = lazy(() => import("./visual-search").then((m) => ({ default: m.VisualSearch })));
const Wardrobe = lazy(() => import("./wardrobe").then((m) => ({ default: m.Wardrobe })));
const IconStudio = lazy(() => import("./icon-studio").then((m) => ({ default: m.IconStudio })));
const RumourMill = lazy(() => import("./rumour-mill").then((m) => ({ default: m.RumourMill })));
const WinOver = lazy(() => import("./win-over").then((m) => ({ default: m.WinOver })));
const OceanReef = lazy(() => import("./ocean-reef").then((m) => ({ default: m.OceanReef })));
const ScreenSentry = lazy(() => import("./screen-sentry").then((m) => ({ default: m.ScreenSentry })));
const WhoSaidThat = lazy(() => import("./who-said-that").then((m) => ({ default: m.WhoSaidThat })));
const GhostBrush = lazy(() => import("./ghost-brush").then((m) => ({ default: m.GhostBrush })));

export const sceneViews: { readonly [Id in SceneId]: (props: ViewProps) => ReactNode } = {
  paste: ({ result }) => <Paste record={result} />,
  ui: ({ result, composition }) => (
    <>
      <GeneratedUI record={composition} />
      <LayoutStudy result={result} />
    </>
  ),
  games: ({ result }) => <Games result={result} />,
  music: ({ result }) => <Music result={result} />,
  "semantic-table": ({ result }) => <JudgmentsScene record={result} />,
  beverage: ({ result }) => <Beverage result={result} />,
  verify: ({ result }) => <AgentExperiment id="verify" result={result} />,
  search: ({ result }) => <AgentExperiment id="search" result={result} />,
  classify: ({ result }) => (
    <BenchmarkReport id="classify" result={result}>
      <IntentRecognition result={result} />
    </BenchmarkReport>
  ),
  handoff: ({ result }) => (
    <>
      <Handoff result={result} />
      <p className="fine">
        <a href="#experiment/decisions-in-ui">Decisions in an interface</a> reads this beside One box: what the same
        confidence does while someone types.
      </p>
    </>
  ),
  "decisions-in-ui": ({ result }) => <DecisionsArticle result={result} />,
  "open-decisions": ({ result }) => (
    <BenchmarkReport id="open-decisions" result={result}>
      <OpenDecisions />
    </BenchmarkReport>
  ),
  decoy: () => <DecoyArticle />,
  prose: () => <ProseArticle />,
  spine: () => <SpineArticle />,
  judge: ({ result }) => (
    <BenchmarkReport id="judge" result={result}>
      <JudgeBench result={result} />
    </BenchmarkReport>
  ),
  rewardbench2: ({ result }) => (
    <BenchmarkReport id="rewardbench2" result={result}>
      <RewardBench result={result} />
    </BenchmarkReport>
  ),
  eyes: () => <EyesVsState />,
  count: () => <CountWithMe />,
  snake: ({ result }) => <ArcadeScene result={result} />,
  "local-models": ({ result }) => (
    <BenchmarkReport id="local-models" result={result}>
      <LocalModels result={result} />
    </BenchmarkReport>
  ),
  "answer-key": ({ result }) => <AnswerKeyReport result={result} />,
  tetris: ({ result }) => <TetrisExperience result={result} />,
  "drawing-framing": ({ result }) => <DrawingFraming result={result} />,
  "visual-search": ({ result }) => <VisualSearch result={result} />,
  wardrobe: ({ result }) => <Wardrobe result={result} />,
  "icon-studio": ({ result }) => <IconStudio result={result} />,
  "rumour-mill": () => <RumourMill />,
  "win-over": () => <WinOver />,
  ocean: () => <OceanReef />,
  "screen-sentry": () => <ScreenSentry />,
  "who-said-that": () => <WhoSaidThat />,
  "ghost-brush": () => <GhostBrush />,
};
