/** Provider-free regression probes from independent playable-owner review. */
import { routeTask } from '../../routing/router';
import { defaultPolicy } from '../../routing/policy';
import { executeDestination } from '../../routing/execute';
import type { Route, Task } from '../../routing/types';
const task: Task = { id: 'review', prompt: 'Analyze this fixture', context: 'public fixture text only', outputTokens: 20 };
const route: Route = { id: 'fixture', model: 'fixture', available: true, local: true, capabilities: ['text'], tools: [], contextTokens: 10000, maxOutputTokens: 100, quality: { value: .5, basis: 'measured', evidence: 'test fixture' }, latencyMs: { value: 1, basis: 'measured', evidence: 'test fixture' }, pricing: { inputPerMillion: 1, outputPerMillion: 1, basis: 'configured', evidence: 'test fixture' }, destination: { kind: 'openai-compatible', endpoint: 'http://127.0.0.1:1' } };
const ok = async () => ({ status: 'ok' as const, actualModel: 'fixture', usage: null, costUsd: 0, artifact: { kind: 'answer' as const, text: 'Fixture analysis' } });
const controller = new AbortController();
const cancelledVerification = await routeTask(task, { routes: [route], policy: { ...defaultPolicy, allowQualityEscalation: true } }, { signal: controller.signal, execute: ok, verify: async () => { controller.abort(); return { adequate: true, evidence: 'fixture', latencyMs: 0, costUsd: 0 }; } });
let classifierCalls = 0;
const cap = await routeTask(task, { routes: [route], policy: { ...defaultPolicy, maxCostUsd: 0 } }, { execute: ok, classifier: async () => { classifierCalls++; return { source: 'hosted', category: 'repository-analysis', difficulty: .5, confidence: .5, latencyMs: 0, costUsd: 1, evidence: 'Synthetic $1 charge; no actual network or spend.' }; } });
let redirectedRequests = 0;
const receiver = Bun.serve({ hostname: '0.0.0.0', port: 0, fetch() { redirectedRequests++; return Response.json({ model: 'redirected-fixture', choices: [{ message: { content: JSON.stringify({ kind: 'answer', text: 'Redirect received task.' }) } }] }); } });
// 127.0.0.2 is local to this test machine but is outside the executor's allowed host list.
// A redirect to a real remote host follows the same code path; this probe sends no remote traffic.
const sender = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch() { return Response.redirect(`http://127.0.0.2:${receiver.port}`, 307); } });
let redirected;
try { redirected = await executeDestination({ ...route, destination: { kind: 'openai-compatible', endpoint: `http://127.0.0.1:${sender.port}` } }, task, { outputTokens: 20 }); }
finally { sender.stop(true); receiver.stop(true); }
const mcp = Bun.spawn(['bun', 'jev-experiments/roadmap/routing/mcp.ts'], { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe', env: { ...process.env, JEV_ROUTER_CONFIG: '' } });
mcp.stdin.write('null\n'); mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'ping' }) + '\n'); mcp.stdin.end();
const [stdout, stderr, exitCode] = await Promise.all([new Response(mcp.stdout).text(), new Response(mcp.stderr).text(), mcp.exited]);
console.log(JSON.stringify({ capturedAt: new Date().toISOString(), cancelledVerification: { expected: 'cancelled', actual: cancelledVerification.status, artifactRetained: !!cancelledVerification.outcome.artifact }, classifierUnderZeroCap: { expectedCalls: 0, actualCalls: classifierCalls, status: cap.status }, redirectGuard: { expectedReceiverCalls: 0, actualReceiverCalls: redirectedRequests, status: redirected?.status, actualModel: redirected?.actualModel }, malformedMcp: { expectedExitCode: 0, actualExitCode: exitCode, stdout, stderr } }, null, 2));
