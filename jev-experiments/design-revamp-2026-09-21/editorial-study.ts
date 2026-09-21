import { createScene, paint, step, type Scene } from "../roadmap/materials/engine";

declare const ENGINE_SHA: string;
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
try {
  const beforeCanvas = $<HTMLCanvasElement>("before");
  const afterCanvas = $<HTMLCanvasElement>("after");
  const timeline = $<HTMLInputElement>("tick");
  const playButton = $<HTMLButtonElement>("play");
  const status = $("status");
  const darkPreference = matchMedia("(prefers-color-scheme: dark)");
  const motionPreference = matchMedia("(prefers-reduced-motion: reduce)");
  const themes = $("theme");
  let explicitTheme = false;
  let tick = 24;
  let playing = false;
  let playFromBeginning = true;
  let frame = 0;
  let lastStep = 0;

  // Compute matched starting states once. Only the custom contact rule changes.
  const a = createScene("empty");
  for (let x = 0; x < a.width; x++) paint(a, x, 63, 3, 0);
  for (let y = 43; y < 63; y++) {
    paint(a, 14, y, 3, 0); paint(a, 81, y, 3, 0);
    if (y >= 45) for (let x = 15; x < 81; x++) paint(a, x, y, 2, 0);
  }
  for (let y = 5; y < 31; y++) paint(a, 47, y, 7, 2);
  const b = structuredClone(a);
  a.rule.contact = "none";
  a.rule.instruction = "A powder that falls without reacting to water.";
  a.label = "Contact comparison A";
  b.label = "Contact comparison B";
  const snapshots: [Scene, Scene][] = [[structuredClone(a), structuredClone(b)]];
  for (let i = 0; i < 96; i++) {
    step(a); step(b);
    snapshots.push([structuredClone(a), structuredClone(b)]);
  }

  function draw(canvas: HTMLCanvasElement, scene: Scene) {
    const context = canvas.getContext("2d");
    if (!context) throw new Error("This browser cannot draw the comparison.");
    const style = getComputedStyle(document.documentElement);
    const color = (name: string) => style.getPropertyValue(name).trim();
    const colors = [color("--field"), "#d0a45c", color("--water"), color("--stone"), color("--wood"), "#dd673e", "#aac8c5", color("--grain")];
    const size = canvas.width / scene.width;
    const inset = canvas.getBoundingClientRect().width / scene.width >= 3 ? .7 : 0;
    context.fillStyle = colors[0];
    context.fillRect(0, 0, canvas.width, canvas.height);
    scene.cells.forEach((cell, i) => {
      if (!cell) return;
      context.fillStyle = colors[cell];
      const x = (i % scene.width) * size;
      const y = Math.floor(i / scene.width) * size;
      // Insets reveal the discrete grid without drawing a decorative grid overlay.
      context.fillRect(x, y, size - inset, size - inset);
    });
  }

  function count(scene: Scene, material: number) {
    return scene.cells.reduce((total, cell) => total + Number(cell === material), 0);
  }
  const initialWood = count(snapshots[0][0], 4);
  function render() {
    const [left, right] = snapshots[tick];
    draw(beforeCanvas, left); draw(afterCanvas, right);
    const leftGrains = count(left, 7), rightGrains = count(right, 7);
    const wood = count(right, 4) - initialWood;
    $("before-count").textContent = `${leftGrains} grains · no new wood`;
    $("after-count").textContent = `${rightGrains} grains · ${wood} new wood cells`;
    beforeCanvas.setAttribute("aria-label", `Branch A at step ${tick}: ${leftGrains} grains, no new wood.`);
    afterCanvas.setAttribute("aria-label", `Branch B at step ${tick}: ${rightGrains} grains, ${wood} new wood cells.`);
    timeline.value = String(tick);
    timeline.setAttribute("aria-valuetext", `${tick} of 96 steps`);
    $("tick-value").textContent = `${tick} / 96 steps`;
  }
  function pause() {
    playing = false;
    cancelAnimationFrame(frame);
    playButton.textContent = tick === 96 ? "Replay" : playFromBeginning ? "Play from start" : "Play";
  }
  function animate(now: number) {
    if (!playing) return;
    if (now - lastStep >= 65) {
      lastStep = now;
      tick = Math.min(96, tick + 1);
      render();
      if (tick === 96) { pause(); status.textContent = "Comparison complete. Scrub to inspect any earlier step."; return; }
    }
    frame = requestAnimationFrame(animate);
  }
  playButton.addEventListener("click", () => {
    if (playing) { pause(); status.textContent = `Paused at step ${tick}.`; return; }
    if (tick === 96 || playFromBeginning) tick = 0;
    playFromBeginning = false;
    playing = true; lastStep = performance.now();
    playButton.textContent = "Pause";
    status.textContent = "Playing both branches. Pause or move the time control to inspect.";
    render(); frame = requestAnimationFrame(animate);
  });
  timeline.addEventListener("input", () => { tick = Number(timeline.value); playFromBeginning = false; pause(); render(); });
  timeline.addEventListener("change", () => { status.textContent = `Paused at step ${tick}. Both branches use the same starting scene.`; });
  $("reset").addEventListener("click", () => { tick = 0; playFromBeginning = false; pause(); render(); status.textContent = "Both branches restored to the starting scene."; });
  $("enlarge").addEventListener("click", () => {
    const expanded = $("branches").classList.toggle("expanded");
    $("enlarge").setAttribute("aria-expanded", String(expanded));
    $("enlarge").textContent = expanded ? "Side by side" : "Larger figures";
    status.textContent = expanded ? "Figures enlarged and stacked. The selected step is unchanged." : "Figures shown side by side.";
  });
  $("export").addEventListener("click", () => {
    const blob = new Blob([JSON.stringify({ format: "jev-material-comparison-1", engineSha256: ENGINE_SHA, tick, branches: snapshots[tick] }, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url; link.download = `jev-contact-comparison-step-${tick}.json`; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    status.textContent = `Saved both scenes at step ${tick}. Each branches entry uses the materials scene format.`;
  });
  $("copy").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText($("rule-code").textContent ?? "");
      $("copy").textContent = "Copied";
      status.textContent = "Copied the contact-rule excerpt.";
    } catch {
      $("copy").textContent = "Select code";
      const range = document.createRange(); range.selectNodeContents($("rule-code"));
      const selection = getSelection(); selection?.removeAllRanges(); selection?.addRange(range);
      status.textContent = "Clipboard unavailable. Code is selected for manual copying.";
    }
  });
  function setTheme(dark: boolean) {
    document.documentElement.dataset.theme = dark ? "dark" : "light";
    themes.textContent = dark ? "Light" : "Dark";
    themes.setAttribute("aria-label", dark ? "Use light theme" : "Use dark theme");
    render();
  }
  themes.addEventListener("click", () => { explicitTheme = true; setTheme(document.documentElement.dataset.theme !== "dark"); });
  darkPreference.addEventListener("change", () => { if (!explicitTheme) setTheme(darkPreference.matches); });
  motionPreference.addEventListener("change", () => { if (motionPreference.matches) { pause(); status.textContent = "Motion preference changed. Use the time control or explicitly start playback."; } });
  document.addEventListener("visibilitychange", () => { if (document.hidden) pause(); });
  window.addEventListener("pagehide", pause);
  setTheme(darkPreference.matches);
  $("engine-version").textContent = `materials-1 · engine SHA-256 ${ENGINE_SHA}`;
  const observer = new ResizeObserver(render);
  observer.observe(beforeCanvas);
  window.addEventListener("pagehide", () => observer.disconnect());
  window.addEventListener("pageshow", () => observer.observe(beforeCanvas));
  document.querySelectorAll<HTMLButtonElement | HTMLInputElement>("[disabled]").forEach(control => control.disabled = false);
  status.textContent = "Paused at step 24. Use the time control or play from the start.";
} catch {
  $("status").textContent = "The figure could not start in this browser. The note and source below are still available.";
  $("before-count").textContent = "Figure unavailable.";
  $("after-count").textContent = "Figure unavailable.";
  $("before").hidden = true;
  $("after").hidden = true;
  $<HTMLButtonElement>("theme").disabled = true;
  $<HTMLButtonElement>("copy").disabled = false;
  const retry = document.createElement("button");
  retry.type = "button";
  retry.className = "quiet";
  retry.textContent = "Retry figure";
  retry.addEventListener("click", () => location.reload());
  $("status").after(retry);
}
