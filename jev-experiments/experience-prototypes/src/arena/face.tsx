/** A contestant as a character: models are round, code players are square robots. Colour comes from --c. */
export type Mood = "calm" | "happy" | "puzzled";

export function Face({
  kind,
  size = 32,
  mood = "calm",
}: {
  kind: string;
  size?: number;
  mood?: Mood;
}) {
  const robot = kind === "code";

  return (
    <svg className="face" width={size} height={size} viewBox="0 0 44 44" aria-hidden="true">
      {robot ? (
        <>
          <line x1="22" y1="6" x2="22" y2="1.5" className="face-body-stroke" />
          <rect x="5" y="6" width="34" height="34" rx="7" className="face-body" />
        </>
      ) : (
        <circle cx="22" cy="23" r="18" className="face-body" />
      )}
      <circle cx="16" cy="21" r="3.2" className="face-eye" />
      <circle cx="28" cy="21" r="3.2" className="face-eye" />
      <circle cx="16.8" cy="21.6" r="1.5" className="face-pupil" />
      <circle cx="28.8" cy="21.6" r="1.5" className="face-pupil" />
      {mood === "happy" ? (
        <path d="M15 29 Q22 35 29 29" className="face-mouth" />
      ) : mood === "puzzled" ? (
        <path d="M16 31 Q20 28 23 31 T29 30" className="face-mouth" />
      ) : (
        <path d="M17 30 H27" className="face-mouth" />
      )}
    </svg>
  );
}
