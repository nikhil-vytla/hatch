import { capitalize, collapse, tidy } from "./common";

export type TimerData = { seconds: number | null; label: string };

const UNIT: Record<string, number> = { h: 3600, m: 60, s: 1 };

export function parseTimer(text: string): TimerData {
  let rest = ` ${collapse(text).toLowerCase()} `;
  let seconds = 0;
  let found = false;

  const special: [RegExp, number][] = [
    [/\bpomodoro\b/, 25 * 60],
    [/\bhalf an? hour\b/, 30 * 60],
    [/\ban? hour\b/, 60 * 60],
    [/\ba minute\b/, 60],
  ];
  for (const [re, s] of special) {
    if (re.test(rest)) {
      seconds += s;
      found = true;
      if (re.source !== "\\bpomodoro\\b") rest = rest.replace(re, " ");
    }
  }

  const re = /(\d+(?:\.\d+)?)\s*(hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)\b/g;
  rest = rest.replace(re, (_, n: string, u: string) => {
    seconds += Number(n) * UNIT[u[0]];
    found = true;
    return " ";
  });

  // "1:30" style
  rest = rest.replace(/\b(\d{1,2}):(\d{2})\b/, (_, m: string, s: string) => {
    seconds += Number(m) * 60 + Number(s);
    found = true;
    return " ";
  });

  const label = tidy(rest.replace(/\b(?:timer|set|start|a|for|countdown|of)\b/g, " "));
  return { seconds: found ? Math.round(seconds) : null, label: capitalize(label) };
}

export function completeTimer(d: TimerData) {
  return (d.seconds ? 0.8 : 0) + (d.label ? 0.2 : 0);
}

export function formatClock(total: number) {
  const s = Math.max(0, Math.round(total));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = String(m).padStart(h ? 2 : 2, "0");
  const ss = String(sec).padStart(2, "0");
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}
