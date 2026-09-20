// Recording tools opt into local credentials. Deployed handlers never import this module.
import "./credentials";
import { evaluate as request, type Payload } from "../server/gateway";
import { compose as generate } from "../server/compose";
export { GatewayError } from "../server/gateway";
const key = () => {
  const value = process.env.AI_GATEWAY_API_KEY;
  if (!value)
    throw new Error("Set AI_GATEWAY_API_KEY to record live evidence.");
  return value;
};
export const evaluate = (
  body: Payload,
  options: Omit<Parameters<typeof request>[1], "apiKey"> = {},
) => request(body, { ...options, apiKey: key() });
export const compose = (body: unknown, signal: AbortSignal) =>
  generate(body, signal, key());
