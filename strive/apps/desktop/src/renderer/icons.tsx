// Line icons, drawn on a 16px grid with the text's color.

const PATHS = {
  folder: "M2.5 4.5a1 1 0 0 1 1-1h3l1.5 1.5h4.5a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1z",
  layout: "M2.5 3.5h11v9h-11zM9.5 3.5v9M9.5 8h4",
  grip: "M6 4h.01M10 4h.01M6 8h.01M10 8h.01M6 12h.01M10 12h.01",
  hand: "M8 2.5v6M5.5 4.5v5M10.5 4v5M13 6v3.5a4.5 4.5 0 0 1-9 0v-1.5L3 6.5",
  check: "M3.5 8.5l3 3 6-7",
  x: "M4.5 4.5l7 7M11.5 4.5l-7 7",
  chevron: "M6 4l4 4-4 4",
  terminal: "M2.5 3.5h11v9h-11zM5 6.5l2 1.5-2 1.5M8.5 10h2.5",
  file: "M4 2.5h5l3 3v8H4zM9 2.5v3h3",
  pencil: "M10.5 3l2.5 2.5-7 7H3.5V10z",
  plug: "M6 2.5v3M10 2.5v3M4.5 5.5h7v2a3.5 3.5 0 0 1-7 0zM8 11v2.5",
  shield: "M8 2.5l5 2v3.5c0 3-2.2 5-5 5.5-2.8-.5-5-2.5-5-5.5V4.5z",
  spark: "M8 2v3.5M8 10.5V14M2 8h3.5M10.5 8H14M3.8 3.8l2.4 2.4M9.8 9.8l2.4 2.4M3.8 12.2l2.4-2.4M9.8 6.2l2.4-2.4",
  arrow: "M8 13V3.5M4 7.5l4-4 4 4",
  stop: "M5 5h6v6H5z",
  spinner: "M8 2.5a5.5 5.5 0 1 1-5.5 5.5",
  diff: "M5 2.5v7M1.5 6h7M3 13.5h5M11 2.5v11M13.5 11L11 13.5 8.5 11",
  sidebar: "M2.5 3.5h11v9h-11zM6 3.5v9",
  plus: "M8 3.5v9M3.5 8h9",
  command:
    "M6 6V4.5A1.5 1.5 0 1 0 4.5 6H6zm0 0h4m-4 0v4m4-4V4.5A1.5 1.5 0 1 1 11.5 6H10zm0 0v4m0 0h1.5a1.5 1.5 0 1 1-1.5 1.5V10zm0 0H6m0 0v1.5A1.5 1.5 0 1 1 4.5 10H6z",
  rewind: "M3.5 7.5a4.5 4.5 0 1 1 1.3 3.2M3.5 3.5v4h4",
  chevronDown: "M4 6l4 4 4-4",
  bulb: "M6.2 11.5h3.6M6.7 13.5h2.6M8 2.5a4 4 0 0 0-2.4 7.2c.4.3.6.8.6 1.3v.5h3.6V11c0-.5.2-1 .6-1.3A4 4 0 0 0 8 2.5z",
  key: "M10 2.5a3.5 3.5 0 1 1-2.9 5.4L2.5 12.5v1h2v-1.5H6v-1.5h1.5l.6-.6A3.5 3.5 0 0 1 10 2.5zM10.8 5.2h.01",
  copy: "M5.5 5.5V3.5a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-2M3.5 5.5h6a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-6a1 1 0 0 1-1-1v-6a1 1 0 0 1 1-1z",
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name, className = "" }: { name: IconName; className?: string }) {
  return (
    <svg className={`icon icon-${name} ${className}`} viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
      <path d={PATHS[name]} />
    </svg>
  );
}
