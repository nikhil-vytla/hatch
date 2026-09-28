import { useEffect, useRef, useState } from "react";
import { downloadSource } from "./download";
import { isRepositoryPath, sourceRevision } from "./revision";
import {
  pinnedSource,
  sourceExcerpt,
  sourceFileName,
  sourceSha256,
  type SourceFile,
  type SourceMarkers,
} from "./source";
import "./source-code.css";

type Fingerprint = {
  status: "pending" | "ready" | "unavailable";
  sha256: string | null;
};
const pending: Fingerprint = { status: "pending", sha256: null };

export function useSourceFingerprint(source: SourceFile): Fingerprint {
  const [result, setResult] = useState<{ text: string; value: Fingerprint }>();
  useEffect(() => {
    let active = true;
    sourceSha256(source).then(
      (sha256) => {
        if (active)
          setResult({ text: source.text, value: { status: "ready", sha256 } });
      },
      () => {
        if (active)
          setResult({
            text: source.text,
            value: { status: "unavailable", sha256: null },
          });
      },
    );
    return () => {
      active = false;
    };
  }, [source.text]);
  // Source changes hide the previous hash during render, before effect cleanup.
  return result?.text === source.text ? result.value : pending;
}

export function SourceCode({
  source,
  markers,
  title,
  className = "",
  downloadLabel = "Download source",
}: {
  source: SourceFile;
  markers?: SourceMarkers;
  title: string;
  className?: string;
  downloadLabel?: string;
}) {
  const excerpt = sourceExcerpt(source, markers);
  const fingerprint = useSourceFingerprint(source);
  const revision = sourceRevision(source.path, fingerprint.sha256);
  const repository = pinnedSource(source.path, revision?.commit);
  const [copied, setCopied] = useState<{ text: string; message: string }>();
  const mounted = useRef(false);
  const copyRevision = useRef(0);
  const displayed = useRef(excerpt?.text);
  displayed.current = excerpt?.text;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      copyRevision.current++;
    };
  }, []);
  async function copy() {
    if (!excerpt) return;
    const revision = ++copyRevision.current;
    let message: string;
    try {
      await navigator.clipboard.writeText(excerpt.text);
      message = "Code copied.";
    } catch {
      message = "Copy unavailable. Select the code or download the source.";
    }
    if (
      mounted.current &&
      revision === copyRevision.current &&
      displayed.current === excerpt.text
    )
      setCopied({ text: excerpt.text, message });
  }
  return (
    <figure className={`source-code ${className}`}>
      <figcaption>
        <span>
          {title}
          <small>
            {sourceFileName(source)}
            {excerpt
              ? ` · lines ${excerpt.startLine}–${excerpt.endLine}`
              : " · excerpt unavailable"}
          </small>
        </span>
        <span className="source-code-meta">TypeScript · bundled source</span>
      </figcaption>
      {excerpt ? (
        <pre tabIndex={0} aria-label={`${title} code, horizontally scrollable`}>
          <code>{excerpt.text}</code>
        </pre>
      ) : (
        <p className="source-code-unavailable">
          The source changed and this excerpt is unavailable. Download the
          complete file below.
        </p>
      )}
      <div className="source-code-actions">
        {excerpt && (
          <button
            type="button"
            onClick={() => void copy()}
            aria-label={`Copy ${title} code`}
          >
            Copy code
          </button>
        )}
        <button type="button" onClick={() => downloadSource(source)}>
          {downloadLabel}
        </button>
        {repository && revision ? (
          <a
            href={`${repository}${excerpt ? `#L${excerpt.startLine}` : ""}`}
            aria-label={`Source at commit ${revision.commit}`}
          >
            Source at {revision.commit.slice(0, 8)} ↗
          </a>
        ) : (
          <span className="source-code-meta">
            {fingerprint.status === "pending"
              ? "Checking source revision…"
              : fingerprint.status === "unavailable"
                ? "Source revision unverified"
                : "Local / unpublished source"}
          </span>
        )}
        <span role="status">
          {copied?.text === excerpt?.text ? copied?.message : ""}
        </span>
      </div>
      <details className="source-code-fingerprint">
        <summary>Source fingerprint</summary>
        <p>
          SHA-256 of the complete file bundled with this page.
          {revision &&
            ` Its bytes match ${revision.basis === "build" ? "build" : "repository"} commit ${revision.commit}.`}
        </p>
        <code>
          {fingerprint.sha256 ??
            (fingerprint.status === "pending"
              ? "Calculating…"
              : "Unavailable in this browser")}
        </code>
        {isRepositoryPath(source.path) && <small>{source.path}</small>}
      </details>
    </figure>
  );
}
