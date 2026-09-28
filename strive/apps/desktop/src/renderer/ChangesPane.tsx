// What the agent changed in the workspace: since the last prompt, or over
// the whole session. From the checkpoints strive takes before each prompt,
// against the files as they are now.
import type { FileChange, SessionChangesResult } from "@strive/protocol";
import { useEffect, useState } from "react";
import { Diff } from "./DiffView";
import { diffLines } from "./diff";
import { Icon } from "./icons";

type Scope = "prompt" | "session";

type Props = {
  /** Checkpoint numbers, oldest first. */
  checkpoints: number[];
  /** Changes whenever the files may have: an edit finished, a turn ended. */
  version: number;
  load: (checkpoint: number) => Promise<SessionChangesResult>;
  onClose: () => void;
};

export function ChangesPane({ checkpoints, version, load, onClose }: Props) {
  const [scope, setScope] = useState<Scope>("prompt");
  const [result, setResult] = useState<SessionChangesResult>();
  const [failed, setFailed] = useState<string>();
  const from = scope === "prompt" ? checkpoints.at(-1) : checkpoints[0];

  useEffect(() => {
    let live = true;

    if (from !== undefined)
      load(from).then(
        (r) => live && (setResult(r), setFailed(undefined)),
        (e: Error) => live && setFailed(e.message),
      );

    return () => {
      live = false;
    };
  }, [from, version, load]);

  const counts = (result?.files ?? []).reduce(
    (sum, f) => {
      for (const row of diffLines(f.before ?? "", f.after ?? "")) {
        if (row.kind === "add") sum.added++;
        else if (row.kind === "remove") sum.removed++;
      }

      return sum;
    },
    { added: 0, removed: 0 },
  );

  return (
    <aside className="changes-pane" aria-label="changes">
      <div className="changes-head">
        <div className="segmented" role="tablist">
          {(["prompt", "session"] as const).map((s) => (
            <button key={s} type="button" role="tab" aria-selected={scope === s} onClick={() => setScope(s)}>
              {s === "prompt" ? "Since last prompt" : "Whole session"}
            </button>
          ))}
        </div>
        <span className="spacer" />
        <button type="button" className="icon-button" onClick={onClose} aria-label="close changes" title="Close (⌘D)">
          <Icon name="x" />
        </button>
      </div>
      <div className="changes-body">
        {from === undefined && <p className="faint pad">No checkpoints yet: one is taken before each prompt.</p>}
        {failed && <p className="danger pad">Couldn't read the changes: {failed}</p>}
        {result && from !== undefined && (
          <>
            <p className="changes-summary">
              {result.files.length === 0
                ? "No changes"
                : `${result.files.length}${result.more ? "+" : ""} changed ${result.files.length === 1 ? "file" : "files"}`}
              {counts.added > 0 && <span className="plus"> +{counts.added}</span>}
              {counts.removed > 0 && <span className="minus"> −{counts.removed}</span>}
            </p>
            {result.files.map((f) => (
              <FileSection key={f.path} file={f} />
            ))}
          </>
        )}
      </div>
    </aside>
  );
}

const STATUS = { added: "A", modified: "M", deleted: "D" } as const;

function FileSection({ file }: { file: FileChange }) {
  const [open, setOpen] = useState(true);

  return (
    <section className={`file ${file.status}`}>
      <button type="button" className="file-head" aria-expanded={open} onClick={() => setOpen(!open)}>
        <Icon name="chevron" className={open ? "open" : ""} />
        <span className={`status ${file.status}`}>{STATUS[file.status]}</span>
        <span className="mono path">{file.path}</span>
      </button>
      {open &&
        (file.opaque ? (
          <p className="faint small pad">Binary, or too large to show.</p>
        ) : (
          <Diff before={file.before ?? ""} after={file.after ?? ""} path={file.path} />
        ))}
    </section>
  );
}
