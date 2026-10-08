/**
 * Shared compute-plane HTTP contract.
 * Implemented by: local shim (Node), Modal (Python), later other providers.
 * Consumed by: Cloudflare Worker control plane (and optional Node hybrid).
 */
export type ComputeAuthor = {
  readonly name: string;
  readonly email: string;
};

export type ComputeCreateSandbox = {
  readonly cloneUrl?: string;
  readonly seedFiles?: Record<string, string>;
  readonly author?: ComputeAuthor;
};

export type ComputeSandbox = {
  readonly id: string;
  readonly branch: string;
  /** Present on local shim; Modal may omit and use sandbox-local paths only. */
  readonly repoDir?: string;
};

export type ComputeFileArtifact = {
  readonly path: string;
  readonly status: string;
  readonly content: string | null;
  readonly truncated: boolean;
  readonly binary: boolean;
};

export type ComputeArtifacts = {
  readonly diff: string;
  readonly files: readonly ComputeFileArtifact[];
};

export type ComputeDelta =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "tool"; readonly name: string; readonly status: string }
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: "idle" };

export type ComputeClientOptions = {
  readonly baseUrl: string;
  readonly token?: string;
  readonly fetch?: typeof fetch;
};

export class ComputeClient {
  private readonly baseUrl: string;
  private readonly token: string | undefined;
  private readonly fetchFn: typeof fetch;

  constructor(opts: ComputeClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, "");
    this.token = opts.token;
    this.fetchFn = opts.fetch ?? fetch;
  }

  private headers(json = true): HeadersInit {
    const h: Record<string, string> = {};
    if (json) h["content-type"] = "application/json";
    if (this.token) h.authorization = `Bearer ${this.token}`;
    return h;
  }

  async health(): Promise<{ ok: boolean; backend: string }> {
    const r = await this.fetchFn(`${this.baseUrl}/health`);
    if (!r.ok) throw new Error(`compute health ${r.status}`);
    return (await r.json()) as { ok: boolean; backend: string };
  }

  async createSandbox(body: ComputeCreateSandbox): Promise<ComputeSandbox> {
    const r = await this.fetchFn(`${this.baseUrl}/v1/sandboxes`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error(`createSandbox ${r.status}: ${await r.text()}`);
    return (await r.json()) as ComputeSandbox;
  }

  async destroySandbox(id: string): Promise<{ ok: boolean; diskGone: boolean }> {
    const r = await this.fetchFn(`${this.baseUrl}/v1/sandboxes/${id}`, {
      method: "DELETE",
      headers: this.headers(false),
    });
    if (!r.ok) throw new Error(`destroySandbox ${r.status}: ${await r.text()}`);
    return (await r.json()) as { ok: boolean; diskGone: boolean };
  }

  async artifacts(id: string): Promise<ComputeArtifacts> {
    const r = await this.fetchFn(`${this.baseUrl}/v1/sandboxes/${id}/artifacts`, {
      headers: this.headers(false),
    });
    if (!r.ok) throw new Error(`artifacts ${r.status}: ${await r.text()}`);
    return (await r.json()) as ComputeArtifacts;
  }

  async commit(
    id: string,
    message: string,
    author: ComputeAuthor,
  ): Promise<{ sha: string; branch: string }> {
    const r = await this.fetchFn(`${this.baseUrl}/v1/sandboxes/${id}/commit`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ message, author }),
    });
    if (!r.ok) throw new Error(`commit ${r.status}: ${await r.text()}`);
    return (await r.json()) as { sha: string; branch: string };
  }

  /** NDJSON stream of ComputeDelta lines. */
  async *prompt(
    id: string,
    text: string,
    model?: { providerID: string; modelID: string },
  ): AsyncGenerator<ComputeDelta> {
    const r = await this.fetchFn(`${this.baseUrl}/v1/sandboxes/${id}/prompt`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ text, model }),
    });
    if (!r.ok) throw new Error(`prompt ${r.status}: ${await r.text()}`);
    if (!r.body) throw new Error("prompt: empty body");
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const parts = buf.split("\n");
      buf = parts.pop() ?? "";
      for (const line of parts) {
        if (!line.trim()) continue;
        yield JSON.parse(line) as ComputeDelta;
      }
    }
    if (buf.trim()) yield JSON.parse(buf) as ComputeDelta;
  }
}
