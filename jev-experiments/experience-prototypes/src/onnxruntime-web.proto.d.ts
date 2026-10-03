// PROTOTYPE: onnxruntime-web ships types that its package "exports" field hides from TypeScript's
// bundler resolution; this declares the little of it the Who said that? worker uses.
declare module "onnxruntime-web" {
  export class Tensor {
    constructor(type: "float32", data: Float32Array, dims: number[]);
    readonly data: Float32Array;
  }

  export class InferenceSession {
    static create(model: Uint8Array | string, options?: { graphOptimizationLevel?: "disabled" | "basic" | "extended" | "all" }): Promise<InferenceSession>;
    run(feeds: Record<string, Tensor>): Promise<Record<string, Tensor>>;
  }
}
