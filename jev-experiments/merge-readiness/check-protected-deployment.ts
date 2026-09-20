/** Use owner access to verify a protected deployment without exposing credentials. */
import { ownerFetch } from "./deployment-fetch";
const deployment = process.argv[2] ?? "https://jev-experiments.vercel.app";
process.argv = [process.argv[0], process.argv[1], deployment, new URL("live-check.jsonl", import.meta.url).pathname];
process.env.JEV_CHECK_BUFFERED = "1";
globalThis.fetch = ownerFetch;
await import("../experience-prototypes/scripts/cloudcheck");
