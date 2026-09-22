/** A commit whose complete file bytes matched the bundled raw source at load time. */
export type SourceRevision = {
  path: string;
  sha256: string;
  commit: string;
  basis: "build" | "repository";
};

const revisions = new Map<string, SourceRevision>();

export function isRepositoryPath(path: string): boolean {
  return (
    !/[:\\\u0000-\u001f\u007f]/.test(path) &&
    !path.split("/").some((part) => !part || part === "." || part === "..")
  );
}

/** Called by the first-party raw-source loader, never inferred from HEAD in the UI. */
export function registerSourceRevision(revision: SourceRevision): void {
  if (
    isRepositoryPath(revision.path) &&
    /^[a-f0-9]{64}$/.test(revision.sha256) &&
    /^[a-f0-9]{40}$/.test(revision.commit) &&
    (revision.basis === "build" || revision.basis === "repository")
  )
    revisions.set(revision.path, { ...revision });
}

/** The current displayed bytes must match, including after a source edit or HMR. */
export function sourceRevision(
  path: string,
  sha256: string | null,
): SourceRevision | undefined {
  const revision = revisions.get(path);
  return revision?.sha256 === sha256 ? { ...revision } : undefined;
}
