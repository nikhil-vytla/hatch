import { useEffect, useRef } from "react";
const palettes: Record<string, string[]> = {
  garden: ["#1d302b", "#3c5f48", "#94b196", "#eddcac"],
  night: ["#182238", "#38476c", "#9faace", "#eee3b8"],
  ocean: ["#152e3c", "#2b6777", "#a4cdb4", "#f3ca88"],
  warm: ["#362329", "#975447", "#d7a376", "#ffe3ae"],
  neon: ["#251e38", "#655082", "#b77fad", "#8acbb6"],
  monochrome: ["#22262a", "#555d62", "#a5adb0", "#e9ece6"],
};
export function MotionArt({
  scene = "garden",
  small = false,
  paused = false,
  parameters = {},
}: {
  scene?: string;
  small?: boolean;
  paused?: boolean;
  parameters?: Record<string, string>;
}) {
  const ref = useRef<HTMLCanvasElement>(null),
    key = JSON.stringify(parameters);
  useEffect(() => {
    const canvas = ref.current!,
      ctx = canvas.getContext("2d")!;
    let frame = 0,
      width = 1,
      height = 1;
    const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
    const p = palettes[parameters.palette ?? scene] ?? palettes.garden,
      terrain = parameters.terrain ?? "hills",
      movement = parameters.motion ?? "drift";
    const count = small
      ? 14
      : parameters.density === "sparse"
        ? 12
        : parameters.density === "dense"
          ? 64
          : 32;
    function draw(time: number) {
      const t = paused || reduced ? 4 : time / 1000,
        s = width / 700;
      ctx.fillStyle = p[0];
      ctx.fillRect(0, 0, width, height);
      const glow = ctx.createRadialGradient(
        width * 0.76,
        height * 0.25,
        2,
        width * 0.76,
        height * 0.25,
        width * 0.4,
      );
      glow.addColorStop(0, p[3] + "24");
      glow.addColorStop(1, p[3] + "00");
      ctx.fillStyle = glow;
      ctx.fillRect(0, 0, width, height);
      ctx.fillStyle = p[3];
      ctx.beginPath();
      ctx.arc(width * 0.76, height * 0.24, 24 * s, 0, Math.PI * 2);
      ctx.fill();
      if (terrain !== "stars")
        for (let layer = 0; layer < 3; layer++) {
          ctx.fillStyle = [p[1], p[1] + "bb", p[2] + "30"][layer];
          ctx.beginPath();
          ctx.moveTo(0, height);
          for (let x = 0; x <= width; x += 5)
            ctx.lineTo(
              x,
              height * (0.63 + layer * 0.12) +
                Math.sin(
                  (x / width) * (terrain === "waves" ? 12 : 5) +
                    layer * 2 +
                    (terrain === "waves" ? t * 0.7 : 0),
                ) *
                  height *
                  (terrain === "flat"
                    ? 0.015
                    : terrain === "waves"
                      ? 0.04
                      : 0.1),
            );
          ctx.lineTo(width, height);
          ctx.fill();
        }
      if (terrain === "buildings") {
        for (let i = 0; i < 10; i++) {
          const x = (i * width) / 10,
            h = height * (0.16 + Math.sin(i * 13) ** 2 * 0.33);
          ctx.fillStyle = i % 2 ? p[0] : p[1];
          ctx.fillRect(x, height * 0.85 - h, width / 12, h);
          for (let j = 0; j < 4; j++) {
            ctx.fillStyle =
              p[3] + (Math.sin(i * 3 + j + t * 0.3) > 0.2 ? "bb" : "28");
            ctx.fillRect(
              x + 8 * s,
              height * 0.85 - h + 14 * s + j * 18 * s,
              7 * s,
              8 * s,
            );
          }
        }
      } else if (terrain === "hills") {
        for (let i = 0; i < 12; i++) {
          const x = ((i + 0.4) * width) / 12,
            y = height * (0.62 + Math.sin(i * 6) * 0.1),
            h = (35 + Math.sin(i * 4) * 24) * s;
          ctx.strokeStyle = p[2] + "99";
          ctx.lineWidth = 2 * s;
          ctx.beginPath();
          ctx.moveTo(x, y + h);
          ctx.quadraticCurveTo(
            x + Math.sin(t + i) * 7 * s,
            y + h * 0.3,
            x + Math.sin(t + i) * 10 * s,
            y,
          );
          ctx.stroke();
          ctx.fillStyle = p[2];
          ctx.beginPath();
          ctx.ellipse(
            x + Math.sin(t + i) * 10 * s,
            y,
            6 * s,
            14 * s,
            Math.sin(t + i) * 0.25,
            0,
            Math.PI * 2,
          );
          ctx.fill();
        }
      }
      for (let i = 0; i < count; i++) {
        let x =
            (((i * 137.5 + Math.sin(t * 0.35 + i) * 25) % 700) / 700) * width,
          y =
            (0.1 + ((i * 71) % 270) / 500) * height +
            Math.sin(t * 0.7 + i * 3) * 12 * s;
        if (movement === "orbit") {
          x =
            width * 0.5 +
            Math.cos(t * 0.2 + i * 3) * width * (0.12 + (i % 5) * 0.055);
          y =
            height * 0.45 +
            Math.sin(t * 0.2 + i * 3) * height * (0.12 + (i % 5) * 0.055);
        }
        if (movement === "bounce")
          y = height * 0.6 - Math.abs(Math.sin(t + i)) * height * 0.4;
        if (movement === "grow")
          y = height * (0.7 - ((t * 0.025 + i * 0.073) % 1) * 0.6);
        const scale =
            movement === "pulse" ? 1 + Math.sin(t * 1.5 + i) * 0.5 : 1,
          size =
            (small
              ? (i % 3) + 1
              : parameters["shape" + (i % 4)]
                ? 4 + (i % 5)
                : (i % 3) + 1) *
            s *
            scale;
        ctx.globalAlpha = 0.5 + Math.sin(t + i) * 0.25;
        ctx.fillStyle = p[3];
        ctx.strokeStyle = p[2];
        ctx.lineWidth = 1.3 * s;
        ctx.save();
        ctx.translate(x, y);
        ctx.rotate(Math.sin(t * 0.3 + i) * 0.3);
        ctx.beginPath();
        const shape = parameters["shape" + (i % 4)] ?? "circle";
        if (shape === "leaf")
          ctx.ellipse(0, 0, size * 0.5, size, 0, 0, Math.PI * 2);
        else if (shape === "triangle") {
          ctx.moveTo(0, -size);
          ctx.lineTo(size, size);
          ctx.lineTo(-size, size);
          ctx.closePath();
        } else if (shape === "star") {
          for (let j = 0; j < 10; j++) {
            const r = j % 2 ? size * 0.4 : size,
              a = (j * Math.PI) / 5 - Math.PI / 2;
            ctx.lineTo(Math.cos(a) * r, Math.sin(a) * r);
          }
          ctx.closePath();
        } else if (shape === "line") {
          ctx.moveTo(-size, 0);
          ctx.lineTo(size, 0);
          ctx.stroke();
        } else ctx.arc(0, 0, size, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }
      ctx.globalAlpha = 1;
      if (!small && terrain === "hills") {
        ctx.fillStyle = p[0];
        ctx.beginPath();
        ctx.ellipse(
          width * 0.5,
          height * 0.84,
          width * 0.2,
          height * 0.065,
          0,
          0,
          Math.PI * 2,
        );
        ctx.fill();
        ctx.strokeStyle = p[2] + "44";
        for (let i = 0; i < 5; i++) {
          ctx.beginPath();
          ctx.ellipse(
            width * 0.5,
            height * 0.84,
            width * (0.07 + i * 0.025 + Math.sin(t) * 0.003),
            height * 0.02,
            0,
            0,
            Math.PI * 2,
          );
          ctx.stroke();
        }
      }
      if (!paused && !reduced) frame = requestAnimationFrame(draw);
    }
    const resize = () => {
      cancelAnimationFrame(frame);
      const r = canvas.getBoundingClientRect();
      width = r.width;
      height = r.height;
      canvas.width = Math.round(width * devicePixelRatio);
      canvas.height = Math.round(height * devicePixelRatio);
      ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
      frame = requestAnimationFrame(draw);
    };
    const observer = new ResizeObserver(resize);
    observer.observe(canvas);
    resize();
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [scene, small, paused, key]);
  return (
    <canvas
      ref={ref}
      className="motion-art"
      aria-label={`Animated ${scene} scene. Procedural rendering controlled by scene choices.`}
    />
  );
}
