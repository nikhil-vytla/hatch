// Browser-only media adapter. No key, local credential loader or server secret.
import { encode, decode } from "@msgpack/msgpack";
import { FAL_MODEL, SESSION_SECONDS } from "../../wardrobe-lab/engine";
export type VideoEvent = {
  type: string;
  elapsedMs: number;
  detail?: string;
  revision?: number;
};
export type VideoUpdate = {
  prompt: string;
  reference?: string;
  revision: number;
};
export type VideoSession = {
  update: (update: VideoUpdate) => void;
  close: () => void;
  ready: Promise<MediaStream>;
};
export function connectWardrobe(options: {
  input: MediaStream;
  initial: VideoUpdate;
  token: (signal: AbortSignal) => Promise<string>;
  onStream?: (stream: MediaStream) => void;
  onEvent?: (event: VideoEvent) => void;
  onError?: (message: string) => void;
  maxSeconds?: number;
  createSocket?: (url: string) => WebSocket;
  createPeer?: (config: RTCConfiguration) => RTCPeerConnection;
}): VideoSession {
  const started = Date.now(),
    abort = new AbortController();
  let closed = false,
    socket: WebSocket | null = null,
    peer: RTCPeerConnection | null = null,
    remote: MediaStream | null = null;
  let latest = options.initial;
  let resolveReady!: (stream: MediaStream) => void,
    rejectReady!: (e: Error) => void;
  const ready = new Promise<MediaStream>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  // A UI may subscribe to events without awaiting ready. Rejection remains
  // visible to callers that do await it, without an unhandled rejection.
  void ready.catch(() => {});
  const emit = (type: string, detail?: string, revision?: number) =>
    options.onEvent?.({
      type,
      elapsedMs: Date.now() - started,
      detail,
      revision,
    });
  const iceQueue: RTCIceCandidateInit[] = [];
  const close = () => {
    if (closed) return;
    closed = true;
    abort.abort();
    clearTimeout(cap);
    clearTimeout(connectTimeout);
    if (socket) {
      socket.onmessage = null;
      socket.onopen = null;
      socket.onerror = null;
      socket.onclose = null;
      if (socket.readyState === 0 || socket.readyState === 1)
        socket.close(1000, "Visitor disconnected");
    }
    peer?.close();
    options.input.getTracks().forEach((t) => t.stop());
    remote?.getTracks().forEach((t) => t.stop());
    rejectReady(new Error("Video session ended."));
    emit("disconnected");
  };
  const fail = (message: string) => {
    if (closed) return;
    emit("error", message);
    options.onError?.(message);
    rejectReady(new Error(message));
    close();
  };
  const cap = setTimeout(
    () => {
      emit("time-limit", "The bounded video session ended.");
      close();
    },
    Math.min(SESSION_SECONDS, options.maxSeconds ?? SESSION_SECONDS) * 1000,
  );
  const connectTimeout = setTimeout(
    () =>
      fail(
        "The video provider did not return a stream in 25 seconds. The code avatar is still available.",
      ),
    25000,
  );
  const send = (message: Record<string, unknown>) => {
    if (!closed && socket?.readyState === 1) socket.send(encode(message));
  };
  const sendUpdate = () => {
    send({
      prompt: latest.prompt,
      ...(latest.reference ? { reference_image_url: latest.reference } : {}),
      request_id: `wardrobe-${latest.revision}`,
    });
    emit("prompt-sent", undefined, latest.revision);
  };
  async function receive(data: any) {
    if (closed) return;
    const message =
      typeof data === "string"
        ? JSON.parse(data)
        : (decode(
            new Uint8Array(
              data instanceof Blob ? await data.arrayBuffer() : data,
            ),
          ) as any);
    if (closed) return;
    const type = message.type;
    if (
      (type === "x-fal-error" || message.status === "error") &&
      message.error === "TIMEOUT"
    ) {
      emit("provider-idle");
      return;
    }
    if (
      message.status === "error" ||
      type === "error" ||
      type === "x-fal-error"
    ) {
      const raw =
        message.error ?? message.message ?? message.detail ?? message.reason;
      const description =
        typeof raw === "string"
          ? raw
              .replace(/(?:https?:|wss?:)\/\/\S+/g, "[provider URL]")
              .replace(/data:[^\s]+/g, "[image data]")
              .slice(0, 500)
          : "Provider rejected the session.";
      fail(`The video provider rejected this session: ${description}`);
      return;
    }
    if (["iceservers", "iceServers"].includes(type)) {
      if (peer) return;
      const servers =
        message.iceservers ?? message.iceServers ?? message.ice_servers;
      if (!Array.isArray(servers))
        throw new Error("Invalid ICE configuration.");
      peer = (
        options.createPeer ?? ((config) => new RTCPeerConnection(config))
      )({
        iceServers: servers.map((s: any) => ({
          urls: s.urls,
          username: s.username,
          credential: s.credential,
        })),
      });
      const activePeer = peer;
      options.input
        .getVideoTracks()
        .forEach((track) => activePeer.addTrack(track, options.input));
      activePeer.ontrack = (event) => {
        if (closed) {
          event.track.stop();
          return;
        }
        remote = event.streams[0] ?? new MediaStream([event.track]);
        clearTimeout(connectTimeout);
        emit("remote-stream");
        options.onStream?.(remote);
        resolveReady(remote);
      };
      activePeer.onicecandidate = (event) => {
        if (event.candidate)
          send({ type: "icecandidate", candidate: event.candidate.toJSON() });
      };
      activePeer.onconnectionstatechange = () => {
        if (activePeer.connectionState === "failed")
          fail("The video connection failed. Your outfit state is preserved.");
      };
      const offer = await activePeer.createOffer();
      if (closed) return;
      await activePeer.setLocalDescription(offer);
      if (closed) return;
      send({ type: "offer", sdp: offer.sdp });
      emit("offer-sent");
    } else if (type === "answer" && peer) {
      await peer.setRemoteDescription({ type: "answer", sdp: message.sdp });
      if (closed) return;
      for (const candidate of iceQueue.splice(0))
        await peer.addIceCandidate(candidate);
      emit("answer-received");
    } else if (type === "icecandidate") {
      if (peer?.remoteDescription)
        await peer.addIceCandidate(message.candidate);
      else iceQueue.push(message.candidate);
    } else if (type === "ice-restart" && peer && message.turn_config) {
      peer.setConfiguration({
        iceServers: [
          {
            urls: message.turn_config.server_url,
            username: message.turn_config.username,
            credential: message.turn_config.credential,
          },
        ],
      });
      const offer = await peer.createOffer({ iceRestart: true });
      if (closed) return;
      await peer.setLocalDescription(offer);
      if (closed) return;
      send({ type: "offer", sdp: offer.sdp });
      emit("ice-restart");
    } else if (type === "prompt_ack" || type === "set_image_ack") {
      if (message.success === false)
        fail("The provider could not apply the latest wardrobe change.");
      else emit(type);
    } else if (type === "generation_started") emit(type);
  }
  void (async () => {
    try {
      emit("authenticating");
      const token = await options.token(abort.signal);
      if (closed) return;
      socket = (options.createSocket ?? ((url) => new WebSocket(url)))(
        `wss://fal.run/${FAL_MODEL}?fal_jwt_token=${encodeURIComponent(token)}`,
      );
      socket.binaryType = "arraybuffer";
      socket.onopen = () => {
        if (closed) {
          socket?.close();
          return;
        }
        emit("signaling-connected");
        sendUpdate();
      };
      socket.onmessage = (event) => {
        void receive(event.data).catch(() =>
          fail("The provider sent an invalid video signaling message."),
        );
      };
      socket.onerror = () =>
        fail(
          "The video signaling connection could not open. Check the fal key and account access.",
        );
      socket.onclose = () => {
        if (!closed)
          fail(
            "The provider closed the video session. Your outfit state is preserved.",
          );
      };
    } catch {
      if (!closed)
        fail(
          "Could not authorize this video session. Check your fal key and try again.",
        );
    }
  })();
  return {
    ready,
    close,
    update(update) {
      if (closed || update.revision < latest.revision) return;
      latest = update;
      if (socket?.readyState === 1) sendUpdate();
    },
  };
}
