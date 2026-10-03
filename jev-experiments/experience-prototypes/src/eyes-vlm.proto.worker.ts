/// <reference lib="webworker" />
/**
 * PROTOTYPE: times a real small vision-language model (SmolVLM-256M-Instruct) on a few Snake
 * frames in the visitor's browser. Opt-in; nothing leaves the browser. WebGPU when available,
 * otherwise WASM (much slower).
 */
import { AutoModelForVision2Seq, AutoProcessor, RawImage } from "@huggingface/transformers";

const MODEL = "HuggingFaceTB/SmolVLM-256M-Instruct";

self.onmessage = async (e: MessageEvent<{ frames: { tick: number; truth: string; blob: Blob }[] }>) => {
  try {
    const device = "gpu" in navigator ? "webgpu" : "wasm";

    self.postMessage({ type: "status", text: `Loading ${MODEL} on ${device}…` });

    const t0 = performance.now();
    const processor = await AutoProcessor.from_pretrained(MODEL);
    const model = await AutoModelForVision2Seq.from_pretrained(MODEL, {
      dtype: { embed_tokens: "fp16", vision_encoder: "q4", decoder_model_merged: "q4" },
      device,
    });

    self.postMessage({ type: "status", text: `Loaded in ${((performance.now() - t0) / 1000).toFixed(1)} s on ${device}. Asking…` });

    const times: number[] = [];

    for (const f of e.data.frames) {
      const image = await RawImage.fromBlob(f.blob);
      const messages = [
        {
          role: "user",
          content: [
            { type: "image" },
            {
              type: "text",
              text: "This is a Snake game on a 10 by 10 grid. The black square is the head, green squares are the body, the red dot is food. Which move gets the head closer to the food without hitting anything: left, straight or right (relative to the direction the snake is moving)? Answer with one word.",
            },
          ],
        },
      ];
      // Transformers.js types chat content as a string; SmolVLM's template takes image parts too.
      const text = processor.apply_chat_template(messages as any, { add_generation_prompt: true });
      const inputs = await processor(text, [image], { do_image_splitting: false });
      const t = performance.now();
      const out = (await model.generate({ ...inputs, max_new_tokens: 4, do_sample: false })) as any;
      const ms = performance.now() - t;
      const answer = processor
        .batch_decode(out.slice(null, [inputs.input_ids.dims.at(-1), null]), { skip_special_tokens: true })[0]
        .trim()
        .toLowerCase()
        .replace(/[^a-z]/g, "");

      times.push(ms);
      self.postMessage({ type: "row", row: { tick: f.tick, answer, truth: f.truth, ms } });
    }

    // The first frame includes shader compilation, so report it apart from the steady rate.
    const [first, ...rest] = times;
    const sorted = [...rest].sort((a, b) => a - b);
    const median = sorted.length ? sorted[Math.floor(sorted.length / 2)] : first;

    self.postMessage({
      type: "done",
      text: `SmolVLM-256M on ${device}: first frame ${first.toFixed(0)} ms (warm-up), then a median of ${median.toFixed(0)} ms a frame over ${rest.length}. At 10 moves a second a decision has 100 ms.`,
    });
  } catch (err) {
    self.postMessage({ type: "done", text: `Couldn't run the model here: ${err instanceof Error ? err.message : String(err)}` });
  }
};
