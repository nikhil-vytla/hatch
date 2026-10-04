/**
 * "Build this": a fold with copyable code that reproduces the request behind what the visitor
 * just saw, in the TypeSafe Python and JavaScript SDKs, as the raw gateway call, and through the
 * repo's CLI when the scene's study is one it runs. Generated from the scene's real request
 * object (build-this-snippets.ts); nothing is typed in by hand and no snippet holds a key.
 */
import { useMemo, useState } from "react";
import {
  cliSnippet,
  collectRequests,
  curlSnippet,
  DOCS,
  expectedAnswers,
  pythonSnippet,
  typescriptSnippet,
  type CliStudy,
} from "./build-this-snippets";
import "./build-this.css";

type Tab = "python" | "typescript" | "curl" | "cli";

const TAB_LABEL: Record<Tab, string> = { python: "Python", typescript: "TypeScript", curl: "curl", cli: "This repo's CLI" };

export function BuildThis({
  request,
  load,
  response,
  study,
  rebuilt = false,
  note,
  label = "Build this",
}: {
  request?: unknown;
  /** For requests kept only in a published log: fetched when the fold is first opened. */
  load?: () => Promise<unknown>;
  response?: unknown;
  study?: CliStudy;
  /** The request comes from code for this input, because the record didn't keep it. */
  rebuilt?: boolean;
  /** Says where a rebuilt request comes from, when it isn't a recording that lost its requests. */
  note?: string;
  label?: string;
}) {
  const [loaded, setLoaded] = useState<{ request: unknown } | null>(null);
  const [failed, setFailed] = useState(false);
  const requests = useMemo(() => collectRequests(loaded ? loaded.request : request), [loaded, request]);
  const [tab, setTab] = useState<Tab>("python");
  const [copied, setCopied] = useState<Tab | null>(null);
  // Scenes that animate re-render every frame; the code changes only with the request or tab.
  const code = useMemo(
    () =>
      !requests.length
        ? ""
        : tab === "python"
          ? pythonSnippet(requests)
          : tab === "typescript"
            ? typescriptSnippet(requests)
            : tab === "curl"
              ? curlSnippet(requests)
              : cliSnippet(study ?? "fool"),
    [requests, tab, study],
  );

  if (!requests.length && !load) return null;

  const open = (e: React.SyntheticEvent<HTMLDetailsElement>) => {
    if (!e.currentTarget.open || !load || loaded) return;

    setFailed(false);
    load().then(
      (r) => setLoaded({ request: r }),
      () => setFailed(true),
    );
  };

  const tabs: Tab[] = study ? ["python", "typescript", "curl", "cli"] : ["python", "typescript", "curl"];
  const answers = response === undefined ? null : expectedAnswers(response);
  const questions = requests.reduce((n, r) => n + Object.keys(r.request.questions).length, 0);

  const copy = () => {
    void navigator.clipboard?.writeText(code).then(() => {
      setCopied(tab);
      setTimeout(() => setCopied(null), 1500);
    });
  };

  return (
    <details className="build-this" onToggle={open}>
      <summary>{label}</summary>
      {!requests.length ? (
        <p className="build-this-intro" role="status">
          {failed
            ? "The request didn't load. Close and reopen this to try again."
            : loaded
              ? "There's no recorded request for this example."
              : "Loading the request…"}
        </p>
      ) : (
        <>
          <p className="build-this-intro">
            {rebuilt ? "The request this scene sends for this example" : `The exact ${requests.length === 1 ? "request" : `${requests.length} requests`} behind this`} (
            {questions.toLocaleString("en-US")} question{questions === 1 ? "" : "s"}), ready to run with your own <code>AI_GATEWAY_API_KEY</code>.
            {note ? ` ${note}` : rebuilt ? " The recording kept the answers but not the request, so this one is rebuilt with code for the same input." : ""}
          </p>
          <div className="build-this-tabs" role="tablist" aria-label="Language">
            {tabs.map((t) => (
              <button key={t} type="button" role="tab" aria-selected={tab === t} className={tab === t ? "active" : ""} onClick={() => setTab(t)}>
                {TAB_LABEL[t]}
              </button>
            ))}
            <button type="button" className="build-this-copy" onClick={copy}>
              {copied === tab ? "Copied" : "Copy"}
            </button>
          </div>
          <pre className="build-this-code" role="tabpanel" aria-label={`${TAB_LABEL[tab]} code`}>
            {code}
          </pre>
          {answers !== null && (
            <details className="build-this-answers">
              <summary>What came back here</summary>
              <pre className="build-this-code">{JSON.stringify(answers, null, 2)}</pre>
            </details>
          )}
        </>
      )}
      <p className="build-this-docs">
        From TypeSafe's docs: <a href={DOCS.python} target="_blank" rel="noreferrer">Python SDK</a> ·{" "}
        <a href={DOCS.javascript} target="_blank" rel="noreferrer">JavaScript SDK</a> ·{" "}
        <a href={DOCS.http} target="_blank" rel="noreferrer">HTTP API</a>. The curl call is what this site's server sends; the
        SDK calls point the same clients at the same gateway route.
      </p>
    </details>
  );
}
