import { PLACES, place, type World, type Resident } from "./engine";
export const VIEW = { width: 900, height: 590 };
export function residentPoint(w: World, r: Resident) {
  if (r.phase === "visiting" && r.target) {
    const p = place(r.target),
      visitors = w.residents.filter(
        (a) => a.target === p.id && a.phase === "visiting",
      ),
      i = visitors.findIndex((a) => a.id === r.id);
    return { x: p.x + (i - (visitors.length - 1) / 2) * 22, y: p.y + 18 };
  }
  return { x: r.x, y: r.y };
}
export function hitResident(w: World, x: number, y: number) {
  return w.residents
    .map((r) => ({ r, p: residentPoint(w, r) }))
    .sort(
      (a, b) =>
        Math.hypot(a.p.x - x, a.p.y - y) - Math.hypot(b.p.x - x, b.p.y - y),
    )
    .find((v) => Math.hypot(v.p.x - x, v.p.y - y) < 27)?.r.id;
}
export function paint(
  ctx: CanvasRenderingContext2D,
  w: World,
  selected: string,
  reduced: boolean,
  dark: boolean,
) {
  const C = {
    ground: dark ? "#25352e" : "#e7ebd7",
    path: dark ? "#4b5147" : "#e9dfc7",
    ink: dark ? "#f1ead5" : "#4f5946",
    paper: dark ? "#303f36" : "#faf2da",
    roof: dark ? "#aa7b61" : "#c8916b",
    tree: dark ? "#315343" : "#95b18c",
    trunk: "#8c7f60",
    shadow: dark ? "#13201d45" : "#68765218",
  };
  const t = w.time;
  ctx.clearRect(0, 0, 900, 590);
  ctx.fillStyle = C.ground;
  ctx.fillRect(0, 0, 900, 590);
  function rect(
    x: number,
    y: number,
    ww: number,
    hh: number,
    color: string,
    r = 8,
  ) {
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.roundRect(x, y, ww, hh, r);
    ctx.fill();
  }
  function circle(x: number, y: number, r: number, color: string) {
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
  }
  function line(
    x: number,
    y: number,
    xx: number,
    yy: number,
    color: string,
    width = 1,
  ) {
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(xx, yy);
    ctx.stroke();
  }
  function text(
    s: string,
    x: number,
    y: number,
    size = 14,
    color = C.ink,
    font = "sans-serif",
  ) {
    ctx.font = `${size}px ${font}`;
    ctx.textAlign = "center";
    ctx.fillStyle = color;
    ctx.fillText(s, x, y);
  }
  // Courtyard stone paths meet at an open noticeboard square.
  ctx.lineCap = "round";
  line(105, 224, 795, 224, C.path, 84);
  line(114, 472, 795, 472, C.path, 78);
  line(449, 203, 449, 458, C.path, 95);
  line(175, 226, 160, 474, C.path, 63);
  line(735, 227, 740, 474, C.path, 64);
  for (let i = 0; i < 26; i++) {
    const x = 100 + i * 29;
    line(x, 195, x + 3, 203, dark ? "#74796528" : "#ac9f7b24", 1);
    line(x + 5, 249, x + 12, 251, dark ? "#74796528" : "#ac9f7b24", 1);
    line(x, 488, x + 2, 496, dark ? "#74796528" : "#ac9f7b24", 1);
  }
  // Hedge border, original procedural plants and little flowers.
  for (let i = 0; i < 23; i++) {
    const x = 18 + i * 39;
    circle(x, 20, 27, C.tree);
    circle(x + 12, 574, 22, C.tree);
  }
  for (const [x, y] of [
    [49, 131],
    [849, 126],
    [59, 346],
    [842, 346],
    [296, 362],
    [607, 367],
  ]) {
    circle(x + 9, y + 17, 28, C.shadow);
    rect(x - 3, y, 6, 30, C.trunk, 2);
    circle(x, y - 9, 26, C.tree);
    circle(x - 15, y + 1, 21, C.tree);
    circle(x + 16, y + 4, 22, C.tree);
    circle(x - 9, y - 15, 6, dark ? "#537356" : "#beca97");
  }
  for (let i = 0; i < 22; i++) {
    const x = 282 + ((i * 59) % 337),
      y = i % 2 ? 540 : 71;
    circle(x, y, 2, i % 3 ? "#d6b575" : "#bd8680");
  }
  // Tables and benches create inhabited corners without blocking the walking paths.
  for (const [x, y] of [
    [287, 160],
    [310, 429],
    [613, 445],
  ]) {
    rect(x - 18, y + 8, 36, 7, C.trunk, 2);
    rect(x - 16, y - 1, 32, 7, dark ? "#76826c" : "#b9aa84", 2);
    line(x - 13, y + 13, x - 13, y + 19, C.trunk, 3);
    line(x + 13, y + 13, x + 13, y + 19, C.trunk, 3);
  }
  for (const p of PLACES) {
    if (p.id === "fountain") {
      circle(p.x + 4, p.y - 7, 49, C.shadow);
      circle(p.x, p.y - 16, 47, dark ? "#637b71" : "#c7c5ad");
      circle(p.x, p.y - 19, 37, dark ? "#416b73" : "#9abfc0");
      ctx.strokeStyle = dark ? "#6ca2a5" : "#d5e5d5";
      ctx.lineWidth = 1.5;
      for (let i = 0; i < 3; i++) {
        ctx.beginPath();
        ctx.ellipse(
          p.x,
          p.y - 19,
          12 + i * 8 + (reduced ? 0 : Math.sin(t * 1.8 + i) * 2),
          5 + i * 4,
          0,
          0,
          7,
        );
        ctx.stroke();
      }
      circle(p.x, p.y - 25, 7, dark ? "#9ab4ac" : "#e3ddc6");
      line(p.x, p.y - 26, p.x, p.y - 45, dark ? "#92bac0" : "#d7e5db", 3);
    } else if (p.id === "garden") {
      rect(p.x - 71, p.y - 59, 142, 69, C.shadow, 18);
      for (let k = 0; k < 3; k++) {
        rect(
          p.x - 65 + k * 45,
          p.y - 57,
          36,
          63,
          dark ? "#625e43" : "#bfa17a",
          4,
        );
        for (let j = 0; j < 4; j++) {
          const x = p.x - 48 + k * 45,
            y = p.y - 46 + j * 13;
          circle(x - 3, y, 6, j % 2 ? "#738e55" : "#91a568");
          circle(x + 4, y + 3, 6, j % 2 ? "#84995b" : "#b3b879");
        }
      }
      line(p.x - 80, p.y + 4, p.x + 80, p.y + 4, C.trunk, 3);
    } else if (p.id === "stage") {
      rect(p.x - 68, p.y - 30, 136, 47, C.shadow, 10);
      rect(p.x - 70, p.y - 37, 140, 46, dark ? "#77624f" : "#c4a486", 5);
      for (let i = 0; i < 7; i++)
        line(
          p.x - 60 + i * 20,
          p.y - 33,
          p.x - 60 + i * 20,
          p.y + 4,
          dark ? "#63513d" : "#a58767",
        );
      line(p.x - 69, p.y - 78, p.x - 69, p.y + 1, C.trunk, 5);
      line(p.x + 69, p.y - 78, p.x + 69, p.y + 1, C.trunk, 5);
      ctx.strokeStyle = C.trunk;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(p.x - 68, p.y - 78);
      ctx.quadraticCurveTo(p.x, p.y - 45, p.x + 68, p.y - 78);
      ctx.stroke();
      for (let i = 0; i < 7; i++) {
        const xx = p.x - 57 + i * 19,
          yy = p.y - 67 + Math.sin((i / 6) * Math.PI) * 12;
        circle(xx, yy, 3.5, w.weather === "rain" ? "#91a08a" : "#f1d68c");
      }
      text(
        w.weather === "rain" ? "☂" : "♪",
        p.x,
        p.y - 3,
        31,
        dark ? "#e5ba8b" : "#785c4a",
        "serif",
      );
    } else {
      const bw = p.id === "cafe" ? 145 : 133;
      rect(p.x - bw / 2 + 5, p.y - 98 + 8, bw, 116, C.shadow);
      rect(p.x - bw / 2, p.y - 101, bw, 116, C.paper, 9);
      rect(p.x - bw / 2 - 7, p.y - 112, bw + 14, 25, p.color, 5);
      for (let i = 0; i < 8; i++)
        line(
          p.x - bw / 2 + (i * bw) / 8,
          p.y - 110,
          p.x - bw / 2 + (i * bw) / 8,
          p.y - 92,
          dark ? "#eeeecc18" : "#ffffff26",
          2,
        );
      rect(p.x - 48, p.y - 69, 33, 35, dark ? "#779388" : "#bdd3c2", 3);
      rect(p.x + 15, p.y - 69, 33, 35, dark ? "#779388" : "#bdd3c2", 3);
      line(p.x - 31, p.y - 69, p.x - 31, p.y - 34, C.paper, 2);
      line(p.x + 31, p.y - 69, p.x + 31, p.y - 34, C.paper, 2);
      rect(p.x - 12, p.y - 45, 24, 57, dark ? "#726b52" : "#b5a87b", 2);
      circle(p.x + 5, p.y - 16, 2, C.paper);
      if (p.id !== "library") {
        for (let i = 0; i < 8; i++)
          rect(
            p.x - bw / 2 + (i * bw) / 8,
            p.y - 27,
            bw / 8,
            16,
            i % 2 ? C.paper : p.color,
            2,
          );
      } else
        for (let i = 0; i < 5; i++)
          rect(
            p.x - 46 + i * 5,
            p.y - 61,
            3,
            18,
            ["#ba9573", "#92a485", "#a58280"][i % 3],
            1,
          );
      text(
        p.id === "cafe"
          ? "CAFÉ"
          : p.id === "bakery"
            ? "BAKERY"
            : "BOOKS & QUIET",
        p.x,
        p.y - 76,
        p.id === "library" ? 9 : 12,
        p.color,
        "Georgia",
      );
    }
    text(p.name, p.x, p.y + 76, 15, C.ink, "Georgia");
    const visits = w.residents.filter(
        (r) => r.target === p.id && r.phase === "visiting",
      ).length,
      queue = w.residents.filter(
        (r) => r.target === p.id && r.phase === "queue",
      ).length;
    text(
      w.weather === "rain" && p.id === "stage"
        ? "closed for the shower"
        : `${visits}/${p.capacity} seats${queue ? ` · ${queue} waiting` : ""}`,
      p.x,
      p.y + 93,
      10,
      dark ? "#b4bcaa" : "#7a826e",
    );
  }
  // Noticeboard: all residents receive this same text, interpreted separately.
  rect(382, 279, 140, 53, C.shadow, 6);
  rect(379, 274, 140, 53, dark ? "#c7be9c" : "#f8eecf", 5);
  rect(389, 326, 5, 21, C.trunk, 1);
  rect(502, 326, 5, 21, C.trunk, 1);
  text("TODAY IN THE COURTYARD", 449, 290, 7, "#706a50");
  const notice = w.notice.length > 40 ? w.notice.slice(0, 38) + "…" : w.notice;
  text(notice, 449, 309, 9, "#56563e");
  // Colored source rings expose actual actor-level control. Selected residents get a label.
  const sorted = [...w.residents].sort(
    (a, b) => residentPoint(w, a).y - residentPoint(w, b).y,
  );
  for (const r of sorted) {
    const p = residentPoint(w, r),
      bob =
        !reduced && r.phase === "walking"
          ? Math.sin(t * 9 + Number(r.id.slice(1))) * 1.6
          : 0;
    const x = p.x,
      y = p.y + bob;
    const active = r.id === selected;
    circle(x, y + 4, 9, C.shadow);
    if (active) {
      ctx.strokeStyle = dark ? "#f2d083" : "#9a743e";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.ellipse(x, y + 4, 15, 8, 0, 0, 7);
      ctx.stroke();
    } else if (r.source === "jev" || r.source === "human") {
      ctx.strokeStyle = r.source === "jev" ? "#8e82b4" : "#c27e53";
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.ellipse(x, y + 4, 11, 5, 0, 0, 7);
      ctx.stroke();
    }
    line(
      x - 3,
      y,
      x - 4 + (r.phase === "walking" && !reduced ? Math.sin(t * 9) * 2 : 0),
      y + 7,
      "#4f5b50",
      3,
    );
    line(x + 3, y, x + 4, y + 7, "#4f5b50", 3);
    rect(x - 7, y - 14, 14, 17, r.color, 6);
    circle(
      x,
      y - 19,
      6,
      ["#e3c4a2", "#c79373", "#a87555", "#f0d6b4"][Number(r.id.slice(1)) % 4],
    );
    ctx.beginPath();
    ctx.arc(x, y - 20, 6, Math.PI, Math.PI * 2);
    ctx.fillStyle = ["#665543", "#a58d69", "#59514a"][
      Number(r.id.slice(1)) % 3
    ];
    ctx.fill();
    if (w.weather === "rain" && r.phase !== "visiting") {
      ctx.beginPath();
      ctx.arc(x, y - 28, 13, Math.PI, Math.PI * 2);
      ctx.fillStyle = r.color;
      ctx.fill();
      line(x, y - 28, x, y - 10, "#665c49", 1);
    }
    if (active) {
      rect(x - 27, y - 53, 54, 18, C.paper, 5);
      text(r.name, x, y - 40, 11, C.ink);
    }
  }
  if (w.weather === "rain") {
    ctx.fillStyle = dark ? "#93bcc40c" : "#62859810";
    ctx.fillRect(0, 0, 900, 590);
    for (let i = 0; i < 65; i++) {
      const x = ((i * 139 + (reduced ? 0 : t * 23)) % 940) - 20,
        y = ((i * 83 + (reduced ? 0 : t * 175)) % 640) - 25;
      line(x, y, x - 4, y + 10, dark ? "#acc6ce40" : "#70959b45", 1);
    }
  }
  text("BRAMBLE SQUARE", 452, 558, 9, dark ? "#b8bba1" : "#859074");
}
