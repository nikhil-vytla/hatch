/** Public credits distinguish original models, runtime adaptations and interaction references. */
export function BuilderCredits() {
  return (
    <details className="builder-credits">
      <summary>Builders and sources</summary>
      <div>
        <p>
          <a href="https://docs.typesafe.ai/introduction">Jev</a> is built by
          TypeSafe AI. This independent lab uses its hosted typed decisions.
        </p>
        <p>
          <a href="https://github.com/NandhaKishorM/laya">Laya</a> is created by
          Nandakishor M / Convai Innovations. Our local work implements its
          published encoder and scorer in MLX and evaluates pinned model
          revisions. The separate{" "}
          <a href="https://brainfunctioncollapse.com/laya">Laya playground</a>{" "}
          and{" "}
          <a href="https://github.com/wdobry/laya-playground">
            playground repository
          </a>{" "}
          are by Wojciech Dobry.
        </p>
        <p>
          Our shared-prefix, first-token MLX method is adapted from{" "}
          <a href="https://github.com/ekzhang/openjev-sglang">
            Eric Zhang's openjev-sglang
          </a>
          . It does not port SGLang's CUDA serving runtime. Full-option
          likelihood experiments were informed by{" "}
          <a href="https://github.com/daseinlabs/open-jev">
            daseinlabs/open-jev
          </a>
          .
        </p>
        <p>
          Routing references include{" "}
          <a href="https://github.com/fstandhartinger/auto-model-router">
            Florian Standhartinger's auto-model-router
          </a>{" "}
          and <a href="https://whichmodel.app.mintapis.com/">Whichmodel</a>. Our
          selector enforces its own documented restrictions and reports
          simulations separately from measurements.
        </p>
        <p>
          Interaction references include{" "}
          <a href="https://www.inkandswitch.com/patchwork/notebook/2024-version-control/">
            Ink &amp; Switch's Patchwork
          </a>
          , <a href="https://www.inkandswitch.com/potluck/">Potluck</a>,{" "}
          <a href="https://musiclab.chromeexperiments.com/">Chrome Music Lab</a>{" "}
          and{" "}
          <a href="https://maxbittker.com/making-sandspiel/">
            Max Bittker's Sandspiel
          </a>
          . Our simulation engines and scene implementations are original to
          this lab.
        </p>
        <p>
          The materials workbench and notebook styling draw on interaction
          studies by{" "}
          <a href="https://brainfunctioncollapse.com/">Wojciech Dobry</a>,{" "}
          <a href="https://rauno.me/craft/interaction-design">Rauno Freiberg</a>
          ,{" "}
          <a href="https://emilkowal.ski/ui/7-practical-animation-tips">
            Emil Kowalski
          </a>
          ,{" "}
          <a href="https://www.joshwcomeau.com/animation/linear-timing-function/">
            Josh W. Comeau
          </a>
          , <a href="https://paco.me/craft">Paco Coursey</a> and{" "}
          <a href="https://maggieappleton.com/garden">Maggie Appleton</a>. Their
          work is credited as inspiration; the scene code and artwork here are
          original.
        </p>
        <p>
          Music uses <a href="https://tonejs.github.io/">Tone.js</a>; 3D scenes
          use <a href="https://threejs.org/">Three.js</a>; interface motion uses{" "}
          <a href="https://motion.dev/">Motion</a>; routing diagrams use{" "}
          <a href="https://reactflow.dev/">React Flow</a>. Detailed pinned
          sources, protocols and limitations accompany each experiment.
        </p>
      </div>
    </details>
  );
}
