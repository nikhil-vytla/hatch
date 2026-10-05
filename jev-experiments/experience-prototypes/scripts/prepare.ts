/**
 * Runs before every dev server and build: the live worlds' JSON build inputs, everything the
 * site publishes (scripts/publication-manifest.ts, written by scripts/publication.ts), then the
 * headline numbers computed from it.
 */
import { resolve } from "node:path";
import { prepareLiveWorlds } from "../../live-worlds/prepare";
import { buildHeadlines } from "../../packages/arena/src/headlines/build";
import { context, publish } from "./publication";

const ctx = context();

prepareLiveWorlds();
await publish(undefined, ctx);
console.log("Prepared recorded evidence and companion.");
// Headline numbers, computed from the files above; last, so every input exists.
buildHeadlines(ctx.lab, ctx.app, resolve(ctx.lab, "packages/arena/src/headlines"));
