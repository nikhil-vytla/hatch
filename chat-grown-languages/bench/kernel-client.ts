// Talks to a language kernel over JSON lines (PROTOCOL.md): one request per line in, one response per line out.
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { join } from "node:path";
import { createInterface } from "node:readline";

export const ROOT = join(import.meta.dirname, "..");

export class KernelClient {
	private readonly proc: ChildProcessWithoutNullStreams;
	private readonly waiting: ((line: string) => void)[] = [];
	private readonly lines: string[] = [];
	stderr = "";
	exited = false;

	constructor(lang: string, dataDir: string) {
		this.proc = spawn(join(ROOT, lang, "run.sh"), [dataDir], { cwd: join(ROOT, lang) });
		createInterface({ input: this.proc.stdout }).on("line", (line) => {
			const w = this.waiting.shift();
			if (w) w(line);
			else this.lines.push(line);
		});
		this.proc.stderr.on("data", (d) => (this.stderr = (this.stderr + d).slice(-4000)));
		this.proc.on("exit", () => {
			this.exited = true;
			for (const w of this.waiting.splice(0)) w(JSON.stringify({ error: `kernel exited; stderr: ${this.stderr.slice(-500)}` }));
		});
	}

	/** Send one request and wait for its response line. */
	async request(req: Record<string, unknown>, timeoutMs = 120_000): Promise<any> {
		if (this.exited) throw new Error(`kernel exited; stderr: ${this.stderr.slice(-500)}`);
		this.proc.stdin.write(`${JSON.stringify(req)}\n`);
		const line = this.lines.shift() ?? (await new Promise<string>((resolve, reject) => {
			const t = setTimeout(() => reject(new Error(`no response to ${req.op} within ${timeoutMs} ms; stderr: ${this.stderr.slice(-500)}`)), timeoutMs);
			this.waiting.push((l) => { clearTimeout(t); resolve(l); });
		}));
		try {
			return JSON.parse(line);
		} catch {
			throw new Error(`kernel wrote a non-JSON line: ${line.slice(0, 300)}`);
		}
	}

	async close(): Promise<void> {
		if (this.exited) return;
		this.proc.stdin.end();
		await new Promise<void>((resolve) => {
			const t = setTimeout(() => { this.proc.kill("SIGKILL"); resolve(); }, 10_000);
			this.proc.on("exit", () => { clearTimeout(t); resolve(); });
		});
	}
}
