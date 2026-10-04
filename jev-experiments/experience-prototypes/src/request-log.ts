/**
 * Published request logs (JSON Lines next to a scene's data), read on demand. Some recordings keep
 * their requests only in these logs, so "Build this" fetches the log when it's opened, not before:
 * the larger ones run to megabytes.
 */
const logs = new Map<string, Promise<Record<string, unknown>[]>>();

export function readLog(url: string): Promise<Record<string, unknown>[]> {
  let log = logs.get(url);

  if (!log) {
    log = fetch(url)
      .then((r) => {
        if (!r.ok) throw new Error(`${url}: ${r.status}`);

        return r.text();
      })
      .then((text) =>
        text
          .split("\n")
          .filter((line) => line.trim())
          .map((line) => JSON.parse(line) as Record<string, unknown>),
      );
    // A failed read can be retried by opening the fold again.
    log.catch(() => logs.delete(url));
    logs.set(url, log);
  }

  return log;
}

/** A loader for "Build this": the log's rows, narrowed to the request(s) a receipt stands for. */
export const fromLog =
  (url: string, pick: (rows: Record<string, unknown>[]) => unknown): (() => Promise<unknown>) =>
  () =>
    readLog(url).then(pick);
