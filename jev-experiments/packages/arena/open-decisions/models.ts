/**
 * The open models asked the way SGLang's /v1/decisions asks: on a laptop through server.py (the
 * method ported to MLX), or on real SGLang on an NVIDIA L4. Shared by the arena cards and the Open
 * decisions page. Every model is Apache-2.0.
 */
import { PALETTE, type Swatch } from "../src/data/palette";

export type OpenModel = {
  /** File id in recordings/ (open-decisions.<task>.<id>.jsonl, one-box.<id>.jsonl.gz). */
  id: string;
  name: string;
  repo: string;
  quantisation: string;
  licence: string;
  runtime: "mlx" | "sglang";
  /** How it was served, for card policies and the page. */
  method: string;
  color: Swatch;
};

const MLX = "SGLang's /v1/systemone method (prompt format 1) ported to MLX, on an Apple M4 Max";
const SGLANG = "real SGLang /v1/systemone (nightly 0.5.6.post3), NVIDIA L4, Triton attention, no radix cache";

export const OPEN_MODELS: OpenModel[] = [
  { id: "qwen3-0.6b", name: "Qwen3-0.6B", repo: "mlx-community/Qwen3-0.6B-4bit", quantisation: "4-bit", licence: "Apache-2.0", runtime: "mlx", method: MLX, color: PALETTE.openWine },
  { id: "qwen3.5-0.8b", name: "Qwen3.5-0.8B", repo: "mlx-community/Qwen3.5-0.8B-8bit", quantisation: "8-bit", licence: "Apache-2.0", runtime: "mlx", method: MLX, color: PALETTE.open },
  { id: "qwen3-4b", name: "Qwen3-4B-Instruct-2507 on a laptop", repo: "mlx-community/Qwen3-4B-Instruct-2507-4bit", quantisation: "4-bit", licence: "Apache-2.0", runtime: "mlx", method: MLX, color: PALETTE.openDeep },
  {
    id: "sglang-l4.qwen3-4b",
    name: "Qwen3-4B-Instruct-2507 on SGLang",
    repo: "Qwen/Qwen3-4B-Instruct-2507",
    quantisation: "BF16",
    licence: "Apache-2.0",
    runtime: "sglang",
    method: SGLANG,
    color: PALETTE.openRose,
  },
];

/** The method text for card provenance when a card mixes runtimes. */
export const METHOD = "SGLang's decision method (prompt format 1), via MLX on a Mac or real SGLang on an L4";

export const openModel = (id: string) => OPEN_MODELS.find((m) => m.id === id);
