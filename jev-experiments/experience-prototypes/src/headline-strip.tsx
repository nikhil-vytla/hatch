/**
 * The headline strip at the top of an experiment page: a verdict, two to four big numbers and a
 * share card. The numbers come from packages/arena/src/headlines/headlines.json, which the build
 * computes from each scene's recorded data (see headlines/build.ts); nothing is typed in here.
 */
import { useEffect, useRef, useState } from "react";
import doc from "../../packages/arena/src/headlines/headlines.json";
import type { Headlines, Share } from "../../packages/arena/src/headlines/headlines";
import { renderShareCard } from "./share-card";
import "./headline-strip.css";

const headlines: Headlines = doc;

export const headlineFor = (id: string) => headlines.scenes.find((h) => h.id === id) ?? null;

export const homeHeadline = () => headlines.home;

const SITE = "https://jev-experiments.vercel.app";

export function ShareCardButton({ id, title, share }: { id: string; title: string; share: Share }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [blob, setBlob] = useState<Blob | null>(null);
  const [status, setStatus] = useState("");

  useEffect(() => () => {
    if (url) URL.revokeObjectURL(url);
  }, [url]);

  const open = async () => {
    setStatus("Drawing the card…");
    dialog.current?.showModal();

    try {
      const b = await renderShareCard({ title, big: share.big, ring: share.ring, sentence: share.sentence, url: `${SITE}/#${id === "home" ? "/" : `experiment/${id}`}` });

      setBlob(b);
      setUrl(URL.createObjectURL(b));
      setStatus("");
    } catch (e) {
      setStatus(e instanceof Error ? e.message : "The card could not be drawn.");
    }
  };

  const copy = async () => {
    if (!blob) return;

    try {
      await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
      setStatus("Copied the image.");
    } catch {
      setStatus("This browser won't copy images; use Download instead.");
    }
  };

  return (
    <>
      <button type="button" className="headline-share" onClick={() => void open()}>
        Share card
      </button>
      <dialog ref={dialog} className="headline-dialog" aria-label={`Share card: ${title}`} onClose={() => setStatus("")}>
        {url ? <img src={url} alt={`${share.big}. ${share.sentence}`} width={600} height={315} /> : <div className="headline-dialog-blank" />}
        <p className="headline-dialog-status" role="status">
          {status}
        </p>
        <div className="headline-dialog-actions">
          {url && (
            <a className="headline-share" href={url} download={`jev-${id}.png`}>
              Download
            </a>
          )}
          {blob && (
            <button type="button" className="headline-share" onClick={() => void copy()}>
              Copy image
            </button>
          )}
          <button type="button" className="headline-share headline-share-quiet" onClick={() => dialog.current?.close()}>
            Close
          </button>
        </div>
      </dialog>
    </>
  );
}

export function HeadlineStrip({ id, title }: { id: string; title: string }) {
  const h = headlineFor(id);

  if (!h) return null;

  return (
    <section className="headline-strip" aria-label="Headline result">
      <p className="headline-verdict">{h.verdict}</p>
      <dl className="headline-stats">
        {h.stats.map((s) => (
          <div key={s.label}>
            <dt>{s.label}</dt>
            <dd>{s.value}</dd>
          </div>
        ))}
      </dl>
      <div className="headline-foot">
        <span>From {h.source}</span>
        <ShareCardButton id={id} title={title} share={h.share} />
      </div>
    </section>
  );
}
