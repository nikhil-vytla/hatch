// Test-only process fixture. Uses each backend's native output framing. It is
// deliberately able to attack the gateway and Deno permissions; it is no CLI.
const lines = Deno.stdin.readable.pipeThrough(new TextDecoderStream()).getReader();
let buffer = "";
async function readLine() {
  while (!buffer.includes("\n")) {
    const {value, done} = await lines.read();
    if (done) throw new Error("gateway pipe closed");
    buffer += value;
  }
  const end = buffer.indexOf("\n");
  const line = buffer.slice(0, end);
  buffer = buffer.slice(end + 1);
  return JSON.parse(line);
}
const data = await readLine();
const {mode, backend, protocol} = data;
if (mode === "crash_before_call") Deno.exit(7);
if (mode === "hang") await new Promise(() => {});
if (mode === "flood") { console.log("x".repeat(1000000)); Deno.exit(0); }
if (mode === "escape") {
  const operations = [
    () => Deno.readTextFile("/etc/passwd"),
    () => Deno.readTextFile("/Users/nikhil/.codex/auth.json"),
    () => Deno.writeTextFile("/tmp/strive-escape", "bad"),
    () => Deno.env.get("OPENAI_API_KEY"),
    () => new Deno.Command("/usr/bin/true").output(),
    () => Deno.connect({hostname: "127.0.0.1", port: 9}),
    () => Deno.connect({hostname: "192.0.2.1", port: 443}),
    () => Deno.connect({transport: "unix", path: "/tmp/agent.sock"}),
    () => Deno.dlopen("/usr/lib/libSystem.B.dylib", {}),
  ];
  for (const operation of operations) {
    try { await operation(); throw new Error("ESCAPED"); }
    catch (e) { if (!(e instanceof Deno.errors.NotCapable)) throw e; }
  }
  console.error("ESCAPES_DENIED:" + operations.length);
}
let request = protocol === "anthropic-text/1"
  ? {model: data.model, messages: [{role: "user", content: data.input}], max_tokens: data.max_output_tokens}
  : {model: data.model, input: [{role: "system", content: "Fixture harness added context"}, {role: "user", content: data.input}], max_output_tokens: data.max_output_tokens};
if (mode === "tools") request.tools = [{type: "function", name: "shell"}];
if (mode === "hosted_tools") request.tools = [{type: "web_search"}];
if (mode === "wrong_model") request.model = "unapproved";
if (mode === "oversize") request.input = "x".repeat(100000);
if (mode === "billing") request.service_tier = "priority";
if (mode === "session") request.previous_response_id = "opaque-session";
const call = async (suffix = "") => {
  console.log(JSON.stringify({gateway_request: JSON.stringify(request), token: data.token, path: "/generation" + suffix}));
  const response = await readLine();
  return {status: response.status, ok: response.status === 200, json: async () => JSON.parse(response.body)};
};
if (mode === "auxiliary_first") { await call("/title"); Deno.exit(8); }
const response = await call();
if (!response.ok) Deno.exit(9);
const result = await response.json();
if (["second", "retry", "title", "subagent", "compaction"].includes(mode)) {
  const extra = await call();
  if (extra.status !== 403) throw new Error("second call forwarded");
}
if (mode === "crash_after_response") Deno.exit(7);
let text = protocol === "anthropic-text/1" ? result.content[0].text : result.output[0].content[0].text;
if (mode === "malformed") { console.log("not-json"); Deno.exit(0); }
if (mode === "forged_output") text = "forged";
if (mode === "echo_model") console.error(JSON.stringify({model: data.model, tokens: 0, cost: 0}));
if (backend === "opencode") console.log(JSON.stringify({type: "text", part: {text}, usage: {tokens: 0}}));
if (backend === "codex") console.log(JSON.stringify({type: "item.completed", item: {type: "agent_message", text}, usage: {tokens: 0}}));
if (backend === "claude-code") console.log(JSON.stringify({type: "result", result: text, is_error: false, total_cost_usd: 0}));
Deno.exit(0);
