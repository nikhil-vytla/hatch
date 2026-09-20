import {
  connectWardrobe,
  type VideoEvent,
} from "../experience-prototypes/server/wardrobe-stream";
import {
  DEMO_COMMANDS,
  FAL_MODEL,
  INITIAL_OUTFIT,
  demoOutfits,
  fullPrompt,
} from "./engine";
import { drawPresenter, referenceData } from "./illustration";
const canvas = document.querySelector<HTMLCanvasElement>("#source")!,
  output = document.querySelector<HTMLVideoElement>("#output")!,
  button = document.querySelector<HTMLButtonElement>("#record")!,
  status = document.querySelector<HTMLPreElement>("#status")!;
const nonce = (window as any).__WARDROBE_RECORDING_NONCE__,
  pipeline = (window as any).__WARDROBE_SPOKEN_PIPELINE__;
const api = async (path: string, body: BodyInit, type = "application/json") => {
  const r = await fetch(path, {
    method: "POST",
    headers: { "X-Recording-Nonce": nonce, "Content-Type": type },
    body,
  });
  const value = await r.json();
  if (!r.ok) throw new Error(value.error ?? "Recording bridge failed");
  return value;
};
let animation = 0;
const started = performance.now();
function draw() {
  drawPresenter(canvas, INITIAL_OUTFIT, (performance.now() - started) / 1000);
  animation = requestAnimationFrame(draw);
}
draw();
button.onclick = async () => {
  button.disabled = true;
  const events: VideoEvent[] = [],
    outfits = pipeline
      ? pipeline.turns.map((r: any) => ({
          id: r.id,
          text: r.text,
          before: r.before,
          after: r.after,
          audio: r.audio,
          speechSeconds: r.seconds,
        }))
      : demoOutfits(),
    chunks: BlobPart[] = [],
    timers: ReturnType<typeof setTimeout>[] = [];
  const audioContext = pipeline ? new AudioContext() : null;
  await audioContext?.resume();
  const audioDestination = audioContext?.createMediaStreamDestination();
  const audioBuffers: AudioBuffer[] = audioContext
    ? await Promise.all(
        outfits.map(async (o: any) =>
          audioContext.decodeAudioData(
            await (await fetch("/" + o.audio)).arrayBuffer(),
          ),
        ),
      )
    : [];
  let recorder: MediaRecorder | null = null,
    videoBytes = 0,
    renderedSeconds = 0,
    error = "",
    recordingStart = 0;
  const metadata: any = {
    model: FAL_MODEL,
    created: new Date().toISOString(),
    source: "actual-provider-output",
    input:
      "original code-illustrated adult presenter; canvas.captureStream; no camera or microphone",
    commandSource: pipeline
      ? "Actual local MLX Whisper transcripts of macOS synthetic speech"
      : "authored demonstration text, not speech transcription",
    outfitStateSource: pipeline
      ? "Actual sequential Jev responses with catalog and focused-pronoun guards; no expected states substituted"
      : "Authored deterministic demoOutfits, NOT Jev-selected",
    schedule: pipeline?.schedule ?? "Authored states at 7.5-second intervals",
    speechIncluded: Boolean(pipeline),
    declaredSeconds: 30,
    commands: outfits.map((c: any) => ({ id: c.id, text: c.text })),
    events,
    status: "connecting",
  };
  const session = connectWardrobe({
    input: canvas.captureStream(20),
    initial: {
      prompt: fullPrompt(pipeline ? INITIAL_OUTFIT : outfits[0].after),
      reference: referenceData(pipeline ? INITIAL_OUTFIT : outfits[0].after),
      revision: pipeline ? 0 : 1,
    },
    maxSeconds: 60,
    token: async (signal) => {
      const r = await fetch("/token", {
        method: "POST",
        headers: {
          "X-Recording-Nonce": nonce,
          "Content-Type": "application/json",
        },
        body: "{}",
        signal,
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error);
      return data.token;
    },
    onEvent: (event) => {
      events.push(event);
      status.textContent = events
        .map(
          (e) =>
            `${(e.elapsedMs / 1000).toFixed(1)}s ${e.type}${e.revision ? ` · revision ${e.revision}` : ""}${e.detail ? ` · ${e.detail}` : ""}`,
        )
        .join("\n");
    },
    onStream: (stream) => {
      output.srcObject = stream;
      void output.play();
    },
    onError: (message) => {
      error = message;
    },
  });
  try {
    const remote = await session.ready;
    if (output.readyState < 2)
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(
          () =>
            reject(
              new Error(
                "Remote track received but no decoded video frames arrived.",
              ),
            ),
          8000,
        );
        output.onloadeddata = () => {
          clearTimeout(timeout);
          resolve();
        };
      });
    if (!output.videoWidth || !output.videoHeight)
      throw new Error("Provider returned no visible frames.");
    metadata.dimensions = {
      width: output.videoWidth,
      height: output.videoHeight,
    };
    const mime = [
      "video/webm;codecs=vp8,opus",
      "video/webm;codecs=vp8",
      "video/webm",
    ].find((type) => MediaRecorder.isTypeSupported(type));
    if (!mime) throw new Error("This browser cannot record WebM.");
    const capture = new MediaStream([
      ...remote.getVideoTracks(),
      ...(audioDestination?.stream.getAudioTracks() ?? []),
    ]);
    recorder = new MediaRecorder(capture, {
      mimeType: mime,
      videoBitsPerSecond: 280000,
      audioBitsPerSecond: 48000,
    });
    recorder.ondataavailable = (e) => {
      if (e.data.size) chunks.push(e.data);
    };
    const stopped = new Promise<void>((resolve) => {
      recorder!.onstop = () => resolve();
    });
    recorder.start(1000);
    recordingStart = performance.now();
    metadata.status = "recording";
    for (let i = pipeline ? 0 : 1; i < outfits.length; i++)
      timers.push(
        setTimeout(() => {
          if (audioContext && audioDestination) {
            const source = audioContext.createBufferSource();
            source.buffer = audioBuffers[i];
            source.connect(audioDestination);
            source.start();
            events.push({
              type: "synthetic-speech-played",
              elapsedMs: performance.now() - recordingStart,
              revision: i + 1,
            });
            timers.push(
              setTimeout(
                () =>
                  session.update({
                    prompt: fullPrompt(outfits[i].after),
                    reference: referenceData(outfits[i].after),
                    revision: i + 1,
                  }),
                Math.round(audioBuffers[i].duration * 1000) + 150,
              ),
            );
          } else
            session.update({
              prompt: fullPrompt(outfits[i].after),
              reference: referenceData(outfits[i].after),
              revision: i + 1,
            });
        }, i * 7500),
      );
    await new Promise((resolve) => timers.push(setTimeout(resolve, 30000)));
    if (recorder.state !== "inactive") recorder.stop();
    await stopped;
    renderedSeconds = (performance.now() - recordingStart) / 1000;
    const blob = new Blob(chunks, { type: mime });
    videoBytes = blob.size;
    if (videoBytes < 10000)
      throw new Error("Provider video recording was empty or too short.");
    await api("/video", blob, "video/webm");
    metadata.status = error ? "interrupted" : "complete";
  } catch (e) {
    error = e instanceof Error ? e.message : "Recording failed";
    metadata.status = "unavailable";
    if (recorder?.state === "recording") recorder.stop();
  } finally {
    timers.forEach(clearTimeout);
    session.close();
    await audioContext?.close();
    cancelAnimationFrame(animation);
    metadata.actualRecordedSeconds = renderedSeconds;
    metadata.videoBytes = videoBytes;
    metadata.error = error || null;
    metadata.prompts = outfits.map((o: any, i: number) => ({
      revision: i + 1,
      text: o.text,
      outfit: o.after,
      prompt: fullPrompt(o.after),
    }));
    await api("/metadata", JSON.stringify(metadata));
    status.textContent += `\n\n${metadata.status.toUpperCase()} ${videoBytes} bytes · ${renderedSeconds.toFixed(1)}s${error ? `\n${error}` : ""}`;
  }
};
