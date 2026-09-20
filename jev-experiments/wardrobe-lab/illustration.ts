import { COLORS, INITIAL_OUTFIT, item, type Outfit } from "./engine";
function path(
  ctx: CanvasRenderingContext2D,
  d: string,
  fill: string,
  stroke?: string,
  width = 1,
) {
  const p = new Path2D(d);
  ctx.fillStyle = fill;
  ctx.fill(p);
  if (stroke) {
    ctx.strokeStyle = stroke;
    ctx.lineWidth = width;
    ctx.stroke(p);
  }
}
export function drawPresenter(
  canvas: HTMLCanvasElement,
  outfit: Outfit = INITIAL_OUTFIT,
  time = 0,
) {
  const ctx = canvas.getContext("2d")!;
  const w = canvas.width,
    h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  ctx.save();
  ctx.scale(w / 512, h / 768);
  const bg = ctx.createLinearGradient(0, 0, 512, 768);
  bg.addColorStop(0, "#e5e6df");
  bg.addColorStop(1, "#cfdbd5");
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, 512, 768);
  ctx.fillStyle = "#eff0e8";
  ctx.beginPath();
  ctx.roundRect(65, 47, 382, 605, 185);
  ctx.fill();
  ctx.fillStyle = "#a1b5a24a";
  ctx.beginPath();
  ctx.ellipse(256, 715, 150, 26, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.save();
  ctx.translate(Math.sin(time * 0.6) * 3, Math.sin(time * 1.2) * 2);
  // Adult virtual presenter, drawn in code. This is never a camera image.
  path(
    ctx,
    "M163 514 Q153 593 161 726 L231 726 250 577 262 577 284 726 353 726 Q360 593 347 514Z",
    outfit.trousers === "cream" ? "#cabea5" : "#526378",
  );
  path(
    ctx,
    "M183 266 Q148 278 132 315 L104 474 Q99 500 118 511 Q138 515 147 486 L178 367Z",
    "#b98265",
  );
  path(
    ctx,
    "M329 266 Q364 278 380 315 L408 474 Q413 500 394 511 Q374 515 365 486 L334 367Z",
    "#b98265",
  );
  const shirt = outfit.shirt === "white" ? "#f5f1e8" : "#343b3e";
  path(
    ctx,
    "M197 252 157 272 129 345 167 362 177 331 164 529 Q256 550 348 529 L335 331 345 362 383 345 355 272 315 252Z",
    shirt,
    "#0000000c",
    2,
  );
  path(ctx, "M222 206 221 257 Q256 287 291 257 L290 205Z", "#be8a6b");
  if (outfit.jacket !== "none") {
    const g = item(outfit.jacket)!,
      scale =
        outfit.fit === "oversized"
          ? 3.3
          : outfit.fit === "fitted"
            ? 2.65
            : 2.95;
    ctx.save();
    ctx.translate(256 - scale * 50, 238);
    ctx.scale(scale, 3.1);
    path(ctx, g.path, COLORS[outfit.jacketColor], "#23322e55", 0.5);
    ctx.strokeStyle = "#ffffff55";
    ctx.lineWidth = 0.7;
    const seam = new Path2D(
      "M50 32V94 M34 43H44V56H34Z M56 43H66V56H56Z M35 22 42 39 50 31 58 39 65 22",
    );
    ctx.stroke(seam);
    if (outfit.jacket === "bomber") {
      ctx.fillStyle = "#00000022";
      ctx.fillRect(30, 87, 40, 7);
      ctx.strokeStyle = "#ddddcc";
      ctx.beginPath();
      ctx.moveTo(50, 33);
      ctx.lineTo(50, 87);
      ctx.stroke();
    }
    ctx.restore();
  }
  ctx.save();
  ctx.translate(256, 168);
  ctx.rotate(Math.sin(time * 0.55) * 0.025);
  ctx.translate(-256, -168);
  const skin = ctx.createLinearGradient(196, 112, 313, 230);
  skin.addColorStop(0, "#d9aa87");
  skin.addColorStop(1, "#bb7d60");
  ctx.fillStyle = skin;
  ctx.beginPath();
  ctx.ellipse(256, 163, 60, 78, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#3d312a";
  path(
    ctx,
    "M195 162 Q181 102 218 83 Q267 59 305 102 Q326 121 315 165 L301 123 Q253 145 209 122Z",
    "#3d312a",
  );
  ctx.strokeStyle = "#634336";
  ctx.lineWidth = 3;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(218, 161);
  ctx.quadraticCurveTo(228, 156, 238, 162);
  ctx.moveTo(275, 161);
  ctx.quadraticCurveTo(285, 155, 295, 161);
  ctx.stroke();
  const blink = time % 4.5 > 4.25;
  ctx.fillStyle = "#383830";
  for (const x of [230, 282]) {
    ctx.beginPath();
    ctx.ellipse(x, 172, 4, blink ? 1 : 4, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.strokeStyle = "#986749";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(254, 173);
  ctx.lineTo(249, 193);
  ctx.lineTo(260, 194);
  ctx.stroke();
  ctx.strokeStyle = "#875248";
  ctx.beginPath();
  ctx.moveTo(240, 211);
  ctx.quadraticCurveTo(256, 218, 272, 209);
  ctx.stroke();
  if (outfit.glasses !== "none") {
    const scale =
      outfit.glassesSize === "large"
        ? 1.5
        : outfit.glassesSize === "small"
          ? 1.05
          : 1.28;
    ctx.save();
    ctx.translate(256 - 50 * scale, 170 - 50 * scale);
    ctx.scale(scale, scale);
    path(
      ctx,
      item(outfit.glasses)!.path,
      COLORS[outfit.glassesColor],
      "#202927",
      1.8,
    );
    ctx.globalAlpha = 0.3;
    path(ctx, "M16 41 30 39 35 57 20 59Z M63 39 77 41 83 58 69 59Z", "#99b6b7");
    ctx.restore();
  }
  ctx.restore();
  ctx.restore();
  ctx.restore();
}
export function drawReference(canvas: HTMLCanvasElement, outfit: Outfit) {
  const ctx = canvas.getContext("2d")!;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "#f7f6f1";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.save();
  ctx.scale(canvas.width / 512, canvas.height / 512);
  if (outfit.jacket === "none") {
    path(
      ctx,
      "M180 135 135 155 105 238 152 258 166 210 159 360 352 360 345 210 360 258 408 238 377 155 332 135 310 165 203 165Z",
      outfit.shirt === "white" ? "#e7e1d4" : "#353d3b",
      "#999",
      2,
    );
  }
  if (outfit.jacket !== "none") {
    ctx.save();
    ctx.translate(61, 75);
    ctx.scale(3.9, 3.9);
    path(
      ctx,
      item(outfit.jacket)!.path,
      COLORS[outfit.jacketColor],
      "#34403888",
      0.5,
    );
    ctx.strokeStyle = "#ffffff66";
    ctx.lineWidth = 0.7;
    ctx.stroke(
      new Path2D(
        "M50 32V94 M35 44H44V55H35Z M56 44H65V55H56Z M35 22 42 40 50 32 58 40 65 22",
      ),
    );
    ctx.restore();
  }
  if (outfit.glasses !== "none") {
    ctx.save();
    ctx.translate(276, -48);
    ctx.scale(2.2, 2.2);
    path(
      ctx,
      item(outfit.glasses)!.path,
      COLORS[outfit.glassesColor],
      "#222f30",
      1,
    );
    ctx.restore();
  }
  ctx.restore();
}
export function referenceData(outfit: Outfit) {
  const canvas = document.createElement("canvas");
  canvas.width = 512;
  canvas.height = 512;
  drawReference(canvas, outfit);
  return canvas.toDataURL("image/jpeg", 0.85);
}
