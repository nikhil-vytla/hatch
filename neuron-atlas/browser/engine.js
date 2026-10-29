const ORT_BASE = "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.30.0/dist/";
const TRANSFORMERS = "https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.0";
const PENALTY = 1.1;
const CACHE_NAME = "atlas-models";

let ortWebGpuP = null;
let ortWasmP = null;
let transformersP = null;

function errText(e) {
  return e && (e.message || String(e)) ? (e.message || String(e)) : String(e);
}

async function importOrt(useWebGPU) {
  const key = useWebGPU ? "webgpu" : "wasm";
  if (key === "webgpu" && !ortWebGpuP) ortWebGpuP = import(ORT_BASE + "ort.webgpu.min.mjs");
  if (key === "wasm" && !ortWasmP) ortWasmP = import(ORT_BASE + "ort.min.mjs");
  const mod = await (useWebGPU ? ortWebGpuP : ortWasmP);
  mod.env.wasm.wasmPaths = ORT_BASE;
  if (!useWebGPU) {
    // run wasm inference in a worker so token generation never blocks the page
    mod.env.wasm.proxy = true;
    if (self.crossOriginIsolated) {
      mod.env.wasm.numThreads = navigator.hardwareConcurrency || 1;
    }
  }
  return mod;
}

async function importTransformers() {
  if (!transformersP) transformersP = import(TRANSFORMERS);
  return transformersP;
}

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url.pathname}`);
  return res.json();
}

async function fetchBuffer(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url.pathname}`);
  return res.arrayBuffer();
}

async function loadModelBytes(url, onProgress) {
  let cache = null;
  try {
    if ("caches" in window) cache = await caches.open(CACHE_NAME);
  } catch {
    cache = null;
  }

  if (cache) {
    try {
      const hit = await cache.match(url.href);
      if (hit) {
        const buf = await hit.arrayBuffer();
        onProgress(buf.byteLength, buf.byteLength, true);
        return new Uint8Array(buf);
      }
    } catch {
      /* cache reads are best effort */
    }
  }

  const res = await fetch(url.href);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);

  const total = Number(res.headers.get("content-length")) || 0;
  if (cache) {
    try {
      const put = cache.put(url.href, res.clone());
      if (put && typeof put.catch === "function") put.catch(() => {});
    } catch {
      /* a full or unavailable cache must not break loading */
    }
  }

  if (!res.body) {
    const buf = await res.arrayBuffer();
    onProgress(buf.byteLength, buf.byteLength, false);
    return new Uint8Array(buf);
  }

  const reader = res.body.getReader();
  let received = 0;
  const chunks = [];
  let buffer = total > 0 ? new Uint8Array(total) : null;
  onProgress(0, total, false);

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;

    if (buffer && received + value.byteLength <= buffer.length) {
      buffer.set(value, received);
    } else if (buffer) {
      chunks.push(buffer.subarray(0, received));
      chunks.push(value);
      buffer = null;
    } else {
      chunks.push(value);
    }

    received += value.byteLength;
    onProgress(received, total, false);
  }

  let bytes;
  if (buffer) {
    bytes = received === buffer.length ? buffer : buffer.slice(0, received);
  } else {
    bytes = new Uint8Array(received);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
  }

  onProgress(received, total || received, false);
  return bytes;
}

async function detectWebGPU(params, onStatus) {
  if (!navigator.gpu || params.get("backend") === "wasm") return false;
  try {
    const adapter = await navigator.gpu.requestAdapter();
    // a software (fallback) adapter is far slower than wasm
    if (adapter && (adapter.isFallbackAdapter || adapter.info?.isFallbackAdapter)) return false;
    if (!adapter) {
      onStatus("No WebGPU adapter is available, so the WASM backend will be used.", "warn");
      return false;
    }
    return true;
  } catch (e) {
    onStatus(
      "WebGPU could not be initialized (" + errText(e) + "). The WASM backend will be used instead.",
      "warn"
    );
    return false;
  }
}

function outputTensor(output, name, index) {
  if (Array.isArray(output)) return output[index];
  return output[name] || output[Object.keys(output)[index]];
}

export async function loadEngine(modelUrl, { onProgress, onStatus } = {}) {
  const progress = typeof onProgress === "function" ? onProgress : () => {};
  const status = typeof onStatus === "function" ? onStatus : () => {};
  const url = modelUrl instanceof URL ? modelUrl : new URL(modelUrl, location.href);
  const modelDir = new URL(".", url);
  const params = new URLSearchParams(location.search);

  status("Loading metadata…");
  let meta, colnorm;
  try {
    const [metaJson, normBuffer] = await Promise.all([
      fetchJson(new URL("steer_meta.json", modelDir)),
      fetchBuffer(new URL("colnorm.f32", modelDir)),
    ]);
    meta = metaJson;
    colnorm = new Float32Array(normBuffer);
    const expected = meta.n_layers * meta.d_mlp;
    if (colnorm.length !== expected) {
      throw new Error(`colnorm.f32 has ${colnorm.length} values, expected ${expected}.`);
    }
  } catch (e) {
    throw new Error("Could not load model metadata: " + errText(e));
  }

  status("Loading tokenizer…");
  let tokenizer;
  try {
    const { AutoTokenizer } = await importTransformers();
    tokenizer = await AutoTokenizer.from_pretrained(meta.model);
  } catch (e) {
    throw new Error("Could not load the tokenizer for " + meta.model + ": " + errText(e));
  }

  status("Checking WebGPU…");
  const wantWebGPU = await detectWebGPU(params, status);

  status("Downloading model…");
  let bytes;
  try {
    bytes = await loadModelBytes(url, progress);
  } catch (e) {
    throw new Error("Could not download the model: " + errText(e));
  }

  status("Creating " + (wantWebGPU ? "WebGPU" : "WASM") + " session…");
  let ort, backend, session;
  try {
    ort = await importOrt(wantWebGPU);
    backend = wantWebGPU ? "webgpu" : "wasm";
    session = await ort.InferenceSession.create(bytes, {
      executionProviders: [backend],
      graphOptimizationLevel: "all",
    });
  } catch (e) {
    if (!wantWebGPU) {
      throw new Error("Could not start the model: " + errText(e));
    }
    status("WebGPU could not start the model (" + errText(e) + "). Falling back to WASM.", "warn");
    try {
      ort = await importOrt(false);
      backend = "wasm";
      session = await ort.InferenceSession.create(bytes, {
        executionProviders: ["wasm"],
        graphOptimizationLevel: "all",
      });
    } catch (e2) {
      throw new Error("Could not start the model: " + errText(e2));
    }
  }

  const inputNames = session.inputNames || [];
  const supportsKv = inputNames.some((name) => name.startsWith("past_key_values."));
  const fileName = url.pathname.split("/").pop() || "";
  const kvParam = params.get("kv");
  const kvRequested = kvParam === null
    ? /_kv/i.test(fileName)
    : !(kvParam === "0" || kvParam === "false");
  const useKv = supportsKv && kvRequested;
  if (kvRequested && !supportsKv) {
    status("This model has no KV-cache inputs; running without a cache.", "warn");
  }
  if (supportsKv && (!meta.n_kv_heads || !meta.head_dim)) {
    const pastName = inputNames.find((name) => name === "past_key_values.0.key");
    const md = pastName && session.inputMetadata && session.inputMetadata[pastName];
    const dims = md && (md.dimensions || md.shape);
    if (dims && dims.length === 4) {
      meta.n_kv_heads = Number(dims[1]) || meta.n_kv_heads;
      meta.head_dim = Number(dims[3]) || meta.head_dim;
    }
  }

  let emptyPast = null;

  function buildSteer(adds, scale) {
    const steer = new Float32Array(meta.n_layers * meta.d_mlp);
    for (const add of adds) {
      const index = add.layer * meta.d_mlp + add.neuron;
      const norm = colnorm[index];
      if (!Number.isFinite(norm) || norm === 0) continue;
      steer[index] += (add.value * scale * meta.resid_median[add.layer]) / norm;
    }
    return steer;
  }

  async function encodePrompt(prompt) {
    const full = meta.chat_template_prefix.before + prompt + meta.chat_template_prefix.after;
    const encoded = await tokenizer(full, { add_special_tokens: false });
    const data = encoded.input_ids.data;
    const ids = Array.from(data, (value) => Number(value));
    if (!ids.length) throw new Error("The prompt tokenized to zero tokens.");
    return ids;
  }

  function emptyKvPast() {
    const nKv = Number(meta.n_kv_heads) || 1;
    const headDim = Number(meta.head_dim) || 1;
    const past = [];
    for (let i = 0; i < meta.n_layers; i++) {
      past.push(new ort.Tensor("float32", new Float32Array(0), [1, nKv, 0, headDim]));
      past.push(new ort.Tensor("float32", new Float32Array(0), [1, nKv, 0, headDim]));
    }
    return past;
  }

  function makeKvState() {
    return { past: emptyKvPast(), seqLen: 0 };
  }

  // the wasm proxy worker takes ownership of input buffers, so a tensor reused across runs must be copied each time
  const fresh = (t) => new ort.Tensor(t.type, t.data.slice(), t.dims);

  async function infer(seq, steerTensor) {
    const ids = BigInt64Array.from(seq, (value) => BigInt(value));
    const feed = {
      input_ids: new ort.Tensor("int64", ids, [1, seq.length]),
      steer: fresh(steerTensor),
    };
    if (supportsKv) {
      const mask = new BigInt64Array(seq.length).fill(1n);
      feed.attention_mask = new ort.Tensor("int64", mask, [1, seq.length]);
      if (!emptyPast) emptyPast = emptyKvPast();
      for (let i = 0; i < meta.n_layers; i++) {
        feed[`past_key_values.${i}.key`] = fresh(emptyPast[2 * i]);
        feed[`past_key_values.${i}.value`] = fresh(emptyPast[2 * i + 1]);
      }
    }
    const output = await session.run(feed);
    const tensor = outputTensor(output, "logits", 0);
    return Float32Array.from(tensor.data);
  }

  async function inferKv(state, tokens, steerTensor) {
    const length = tokens.length;
    const maskLength = state.seqLen + length;
    const ids = BigInt64Array.from(tokens, (value) => BigInt(value));
    const mask = new BigInt64Array(maskLength).fill(1n);
    const feed = {
      input_ids: new ort.Tensor("int64", ids, [1, length]),
      steer: fresh(steerTensor),
      attention_mask: new ort.Tensor("int64", mask, [1, maskLength]),
    };
    for (let i = 0; i < meta.n_layers; i++) {
      feed[`past_key_values.${i}.key`] = state.past[2 * i];
      feed[`past_key_values.${i}.value`] = state.past[2 * i + 1];
    }
    const output = await session.run(feed);
    const present = [];
    for (let i = 0; i < meta.n_layers; i++) {
      present.push(outputTensor(output, `present.${i}.key`, 1 + 2 * i));
      present.push(outputTensor(output, `present.${i}.value`, 2 + 2 * i));
    }
    state.past = present;
    state.seqLen = maskLength;
    return Float32Array.from(outputTensor(output, "logits", 0).data);
  }

  function applyPenalty(logits, seq) {
    const seen = new Set(seq);
    for (const token of seen) {
      if (logits[token] > 0) logits[token] /= PENALTY;
      else logits[token] *= PENALTY;
    }
  }

  function argmax(logits) {
    let best = 0;
    let bestValue = logits[0];
    for (let i = 1; i < logits.length; i++) {
      if (logits[i] > bestValue) {
        bestValue = logits[i];
        best = i;
      }
    }
    return best;
  }

  function makeSource(promptIds, steerTensor, stream) {
    return {
      seq: promptIds.slice(),
      ids: [],
      text: "",
      stream,
      done: false,
      steer: fresh(steerTensor),
      cache: useKv ? makeKvState() : null,
    };
  }

  async function advance(source, maxTokensValue, eosSet, onToken, signal) {
    if (source.done || signal?.aborted) return;
    if (source.ids.length >= maxTokensValue) {
      source.done = true;
      return;
    }

    let logits;
    if (source.cache) {
      const tokens = source.seq.slice(source.cache.seqLen);
      if (!tokens.length) {
        source.done = true;
        return;
      }
      logits = await inferKv(source.cache, tokens, source.steer);
    } else {
      logits = await infer(source.seq, source.steer);
    }
    applyPenalty(logits, source.seq);
    const next = argmax(logits);

    source.seq.push(next);
    source.ids.push(next);
    if (eosSet.has(next)) source.done = true;

    source.text = await tokenizer.decode(source.ids, { skip_special_tokens: true });
    onToken(source.stream, source.text);
  }

  async function generate({
    prompt = "",
    terms = [],
    scale = 1,
    maxTokens = 48,
    onToken = () => {},
    signal,
    onStatus,
  } = {}) {
    const requested = Math.floor(Number(maxTokens));
    const maxTokensValue = Number.isFinite(requested) ? Math.min(128, Math.max(1, requested)) : 48;
    const adds = (terms || []).map((t) => ({
      layer: Number(t.layer),
      neuron: Number(t.neuron),
      value: Number(t.dose),
    }));
    const promptIds = await encodePrompt(prompt);
    const pushedSteer = buildSteer(adds, scale);
    const eosSet = new Set(meta.eos || []);
    const zeroSteer = new Float32Array(meta.n_layers * meta.d_mlp);

    const normal = makeSource(
      promptIds,
      new ort.Tensor("float32", zeroSteer, [meta.n_layers, meta.d_mlp]),
      "normal"
    );
    const pushed = makeSource(
      promptIds,
      new ort.Tensor("float32", pushedSteer, [meta.n_layers, meta.d_mlp]),
      "pushed"
    );

    if (typeof onStatus === "function") {
      onStatus(adds.length
        ? `Running · ${adds.length} neuron${adds.length === 1 ? "" : "s"} pushed`
        : "Running · zero steer");
    }

    let generated = 0;
    let firstTokenAt = null;
    const emit = (stream, text) => {
      if (firstTokenAt == null) firstTokenAt = performance.now();
      generated++;
      onToken(stream, text);
    };

    while (!(normal.done && pushed.done)) {
      if (signal?.aborted) break;
      if (!normal.done) await advance(normal, maxTokensValue, eosSet, emit, signal);
      if (backend === "webgpu" && !signal?.aborted) {
        await new Promise((resolve) => setTimeout(resolve));
      }
      if (signal?.aborted) break;
      if (!pushed.done) await advance(pushed, maxTokensValue, eosSet, emit, signal);
      if (backend === "webgpu" && !signal?.aborted) {
        await new Promise((resolve) => setTimeout(resolve));
      }
    }

    const seconds = firstTokenAt == null ? 0 : Math.max((performance.now() - firstTokenAt) / 1000, 0.001);
    return {
      normal: normal.text,
      pushed: pushed.text,
      tokens: generated,
      tokensPerSecond: seconds ? generated / seconds : 0,
    };
  }

  return { backend, meta, generate, useKv };
}
