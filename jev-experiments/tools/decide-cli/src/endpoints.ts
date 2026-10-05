/**
 * Where `jev-lab` sends requests: `--endpoint` specs over the shared adapters in
 * packages/jev-client/src/endpoints.ts.
 *
 *   jev                         Jev through the Vercel AI Gateway (AI_GATEWAY_API_KEY, billed to you)
 *   systemone:http://host:port  SGLang's /v1/systemone, or packages/arena/open-decisions/server.py on MLX
 *   decisions:http://host:port  SGLang's /v1/decisions (noul and choice; score is best effort)
 */
import {
  decisionsEndpoint,
  jevEndpoint,
  systemoneEndpoint,
  type Endpoint,
} from "../../../packages/jev-client/src/endpoints";

export {
  EndpointError,
  fromDecisionsAnswers,
  toDecisionsRequest,
  type Endpoint,
  type Reply,
} from "../../../packages/jev-client/src/endpoints";
export type { Answers } from "../../../packages/jev-client/src/wire";

export function endpoint(spec: string, opts: { model?: string; usdPerMTok?: number } = {}): Endpoint {
  if (spec === "jev") return jevEndpoint({ apiKey: process.env.AI_GATEWAY_API_KEY, usdPerMTok: opts.usdPerMTok });

  const [kind, ...rest] = spec.split(":");
  const base = rest.join(":").replace(/\/$/, "");

  if (kind === "systemone" && base.startsWith("http")) return systemoneEndpoint(base, opts);

  if (kind === "decisions" && base.startsWith("http")) return decisionsEndpoint(base, opts);

  throw new Error(`Unknown endpoint "${spec}". Use jev, systemone:http://host:port or decisions:http://host:port.`);
}
