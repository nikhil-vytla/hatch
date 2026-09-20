import { pipeline, env } from "@huggingface/transformers";
env.allowLocalModels = false;
let writer: any, vision: any;
const progress = (message: string) =>
  self.postMessage({ type: "progress", message });
const callback = (event: any) => {
  if (event.status === "progress")
    progress(
      `Downloading ${event.file ?? "model"}: ${Math.round(event.progress ?? 0)}%`,
    );
  else if (event.status === "done")
    progress("Model file ready. Preparing inference…");
};
self.onmessage = async (event: MessageEvent) => {
  const { kind, prompt, image } = event.data;
  try {
    const adapter =
      "gpu" in navigator ? await (navigator as any).gpu.requestAdapter() : null;
    const gpu = adapter !== null;
    let result: any;
    if (kind === "language") {
      if (!writer) {
        progress("Loading Qwen3-0.6B locally. The first download is large.");
        writer = await pipeline(
          "text-generation",
          "onnx-community/Qwen3-0.6B-ONNX",
          {
            device: gpu ? "webgpu" : "wasm",
            dtype: gpu ? "q4f16" : "q4",
            progress_callback: callback,
          },
        );
      }
      const candidates: string[] = [];
      for (let i = 0; i < 4; i++) {
        progress(`Writing candidate ${i + 1} of 4 locally…`);
        const response: any = await writer(
          [{ role: "user", content: prompt + " /no_think" }],
          {
            max_new_tokens: 220,
            do_sample: true,
            temperature: 0.75 + i * 0.1,
            top_p: 0.9,
          },
        );
        const generated = response[0].generated_text;
        const text =
          typeof generated === "string" ? generated : generated.at(-1).content;
        candidates.push(
          String(text)
            .replace(/<think>[\s\S]*?<\/think>/g, "")
            .trim(),
        );
      }
      result = {
        candidates,
        model: "onnx-community/Qwen3-0.6B-ONNX",
        device: gpu ? "webgpu" : "wasm",
      };
    } else {
      if (!vision) {
        progress("Loading the local ViT-GPT2 image captioner…");
        vision = await pipeline(
          "image-to-text",
          "Xenova/vit-gpt2-image-captioning",
          { device: "wasm", dtype: "q8", progress_callback: callback },
        );
      }
      progress("Describing the image locally…");
      const response: any = await vision(image, { max_new_tokens: 60 });
      result = {
        caption: response[0].generated_text,
        model: "Xenova/vit-gpt2-image-captioning",
        device: "wasm",
      };
    }
    self.postMessage({ type: "result", result });
  } catch (error) {
    self.postMessage({
      type: "error",
      message: error instanceof Error ? error.message : String(error),
    });
  }
};
