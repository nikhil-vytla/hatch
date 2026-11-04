/**
 * Doom audio engine: plays DMX sound lumps and Standard MIDI File music via the
 * Web Audio API. Designed to be wired into a WebAssembly module as its `imports`.
 *
 * @module doom-audio
 */

const MAX_MELODIC_VOICES = 24;
const LOOKAHEAD = 0.2;
const SCHED_INTERVAL_MS = 25;

/**
 * @typedef {Object} SfxVoice
 * @property {AudioBufferSourceNode} src
 * @property {GainNode} gain
 * @property {StereoPannerNode} pan
 * @property {number} endsAt
 */

/**
 * @typedef {Object} MelodicVoice
 * @property {string} key
 * @property {OscillatorNode} osc
 * @property {GainNode} gain
 * @property {number} ch
 * @property {number} note
 */

/**
 * @typedef {Object} MidiEvent
 * @property {number} time seconds from song start
 * @property {'on'|'off'|'prog'|'cc'} kind
 * @property {number} ch
 * @property {number} [note]
 * @property {number} [vel]
 * @property {number} [a] program number
 * @property {number} [c] controller number
 * @property {number} [v] controller value
 */

/**
 * Clamp a possibly-undefined/non-finite value.
 * @param {unknown} v
 * @param {number} lo
 * @param {number} hi
 * @returns {number}
 */
function clamp(v, lo, hi) {
  const n = Number(v);
  if (!Number.isFinite(n)) return lo;
  return n < lo ? lo : n > hi ? hi : n;
}

/**
 * @param {Object} opts
 * @param {() => WebAssembly.Memory} opts.getMemory returns the current wasm memory
 * @param {typeof AudioContext} [opts.AudioContextCtor]
 */
export function createDoomAudio({
  getMemory,
  AudioContextCtor = globalThis.AudioContext ?? globalThis.webkitAudioContext,
} = {}) {
  const enabled = typeof AudioContextCtor === 'function';

  /** @type {{sfxStarted:number, notesScheduled:number, errors:number}} */
  const counters = { sfxStarted: 0, notesScheduled: 0, errors: 0 };

  /** @type {Map<number, SfxVoice>} */
  const channels = new Map();
  /** @type {Map<string, AudioBuffer>} */
  const sfxCache = new Map();

  /** @type {AudioContext|null} */ let ctx = null;
  /** @type {GainNode|null} */ let masterGain = null;
  /** @type {GainNode|null} */ let musicGain = null;
  /** @type {AudioBuffer|null} */ let noiseBuffer = null;
  let masterVolume = 1;
  let musicVolume = 100 / 127;

  const music = {
    /** @type {{events:MidiEvent[], duration:number, index:number, startTime:number, looping:boolean}|null} */
    song: null,
    playing: false,
    paused: false,
    pausePos: 0,
    /** @type {ReturnType<typeof setInterval>|null} */
    timer: null,
    /** @type {Map<string, MelodicVoice>} */
    voices: new Map(),
    programs: new Int16Array(16),
    volumes: new Float32Array(16).fill(100 / 127),
  };

  // ---------------------------------------------------------------- context --

  /** Lazily create the AudioContext and master chain. */
  function ensureContext() {
    if (ctx) return ctx;
    ctx = new AudioContextCtor();
    masterGain = ctx.createGain();
    masterGain.gain.value = masterVolume;
    masterGain.connect(ctx.destination);
    musicGain = ctx.createGain();
    musicGain.gain.value = musicVolume;
    musicGain.connect(masterGain);
    return ctx;
  }

  /**
   * Copy `len` bytes at `ptr` out of wasm memory immediately.
   * @param {number} ptr
   * @param {number} len
   * @returns {Uint8Array|null}
   */
  function readBytes(ptr, len) {
    const mem = getMemory();
    if (!mem || !mem.buffer) return null;
    const buf = mem.buffer;
    let p = clamp(ptr, 0, buf.byteLength);
    let n = clamp(len, 0, buf.byteLength - p);
    if (n <= 0) return null;
    return new Uint8Array(buf, p, n).slice();
  }

  // --------------------------------------------------------------- sfx side --

  /**
   * Decode a DMX sound lump into an AudioBuffer (cached by ptr:len).
   * @param {number} ptr
   * @param {number} len
   * @returns {AudioBuffer|null}
   */
  function decodeSfx(ptr, len) {
    const key = ptr + ':' + len;
    const cached = sfxCache.get(key);
    if (cached) return cached;

    const bytes = readBytes(ptr, len);
    if (!bytes || bytes.length < 9) return null;
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (dv.getUint16(0, true) !== 3) return null;
    const rate = dv.getUint16(2, true) || 11025;
    let count = dv.getUint32(4, true);
    let offset = 8;
    count = Math.min(count, bytes.length - 8);
    if (count > 32) {
      offset += 16;
      count -= 32;
    }
    if (count <= 0) return null;

    const c = ensureContext();
    const buffer = c.createBuffer(1, count, clamp(rate, 1000, 192000));
    const out = buffer.getChannelData(0);
    for (let i = 0; i < count; i++) out[i] = (bytes[offset + i] - 128) / 128;
    sfxCache.set(key, buffer);
    return buffer;
  }

  /** @param {number} channel */
  function stopSfxChannel(channel) {
    const voice = channels.get(channel);
    if (!voice) return;
    channels.delete(channel);
    try {
      voice.src.onended = null;
      voice.src.stop();
    } catch { /* already stopped */ }
    try {
      voice.src.disconnect();
      voice.gain.disconnect();
      voice.pan.disconnect();
    } catch { /* ignore */ }
  }

  /**
   * @param {number} channel
   * @param {number} ptr
   * @param {number} len
   * @param {number} vol
   * @param {number} sep
   * @returns {number} channel
   */
  function startSfx(channel, ptr, len, vol, sep) {
    const buffer = decodeSfx(ptr, len);
    if (!buffer) return channel;
    const c = ensureContext();
    stopSfxChannel(channel);

    const src = c.createBufferSource();
    src.buffer = buffer;
    const gain = c.createGain();
    gain.gain.value = clamp(vol, 0, 127) / 127;
    const pan = c.createStereoPanner();
    pan.pan.value = clamp((clamp(sep, 0, 255) - 128) / 127, -1, 1);

    src.connect(gain);
    gain.connect(pan);
    pan.connect(masterGain);

    /** @type {SfxVoice} */
    const voice = { src, gain, pan, endsAt: c.currentTime + buffer.duration };
    src.onended = () => {
      if (channels.get(channel) === voice) channels.delete(channel);
      try {
        src.disconnect();
        gain.disconnect();
        pan.disconnect();
      } catch { /* ignore */ }
    };
    src.start();
    channels.set(channel, voice);
    counters.sfxStarted++;
    return channel;
  }

  // ------------------------------------------------------------ midi parser --

  /**
   * Parse an SMF (format 0/1) into a time-ordered event list in seconds.
   * @param {Uint8Array} bytes
   * @returns {{events: MidiEvent[], duration: number}|null}
   */
  function parseMidi(bytes) {
    const len = bytes.length;
    if (len < 14) return null;
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const id4 = (o) => String.fromCharCode(bytes[o], bytes[o + 1], bytes[o + 2], bytes[o + 3]);
    if (id4(0) !== 'MThd') return null;

    const headerLen = dv.getUint32(4);
    const division = dv.getUint16(12);
    if (division === 0 || (division & 0x8000) !== 0) return null; // PPQ only

    /** @type {Array<any>} */
    const raw = [];
    let order = 0;
    let p = 8 + headerLen;

    while (p + 8 <= len) {
      const id = id4(p);
      const chunkLen = dv.getUint32(p + 4);
      const start = p + 8;
      const end = Math.min(start + chunkLen, len);
      p = start + chunkLen;
      if (id !== 'MTrk') continue;

      let q = start;
      let tick = 0;
      let running = 0;
      const readVlq = () => {
        let v = 0, b = 0, n = 0;
        do {
          if (q >= end) return v;
          b = bytes[q++];
          v = (v << 7) | (b & 0x7f);
        } while ((b & 0x80) && ++n < 5);
        return v;
      };

      while (q < end) {
        tick += readVlq();
        if (q >= end) break;
        let status = bytes[q];
        if (status & 0x80) {
          q++;
          if (status < 0xf0) running = status;
        } else {
          if (!running) break;
          status = running;
        }

        if (status === 0xff) {
          const type = bytes[q++];
          const l = readVlq();
          if (type === 0x51 && l === 3 && q + 3 <= end) {
            const tempo = (bytes[q] << 16) | (bytes[q + 1] << 8) | bytes[q + 2];
            raw.push({ tick, order: order++, kind: 'tempo', tempo: tempo || 500000 });
          }
          q += l;
          if (type === 0x2f) break;
        } else if (status === 0xf0 || status === 0xf7) {
          q += readVlq();
        } else {
          const cmd = status & 0xf0;
          const ch = status & 0x0f;
          if (cmd === 0x90) {
            if (q + 2 > end) break;
            const note = bytes[q++], vel = bytes[q++];
            raw.push({ tick, order: order++, kind: vel > 0 ? 'on' : 'off', ch, note, vel });
          } else if (cmd === 0x80) {
            if (q + 2 > end) break;
            const note = bytes[q++], vel = bytes[q++];
            raw.push({ tick, order: order++, kind: 'off', ch, note, vel });
          } else if (cmd === 0xb0) {
            if (q + 2 > end) break;
            const c = bytes[q++], v = bytes[q++];
            raw.push({ tick, order: order++, kind: 'cc', ch, c, v });
          } else if (cmd === 0xc0) {
            if (q + 1 > end) break;
            raw.push({ tick, order: order++, kind: 'prog', ch, a: bytes[q++] });
          } else if (cmd === 0xd0) {
            q += 1;
          } else if (cmd === 0xa0 || cmd === 0xe0) {
            q += 2;
          } else {
            break;
          }
        }
      }
    }

    if (!raw.length) return null;
    raw.sort((a, b) => a.tick - b.tick || a.order - b.order);

    let secPerTick = 0.5 / division; // default 500000 us per quarter note
    let lastTick = 0;
    let t = 0;
    /** @type {MidiEvent[]} */
    const events = [];
    for (const e of raw) {
      t += (e.tick - lastTick) * secPerTick;
      lastTick = e.tick;
      if (e.kind === 'tempo') {
        secPerTick = e.tempo / 1e6 / division;
        continue;
      }
      events.push({ ...e, time: t });
    }
    return { events, duration: t };
  }

  // ------------------------------------------------------------------ synth --

  /** @param {number} note */
  const noteToFreq = (note) => 440 * Math.pow(2, (note - 69) / 12);

  /** @param {number} program GM program 0..127 */
  function waveformFor(program) {
    if (program < 32) return 'triangle';
    if (program < 80) return 'sawtooth';
    return 'square';
  }

  function getNoiseBuffer() {
    if (noiseBuffer) return noiseBuffer;
    const c = ensureContext();
    const n = Math.floor(c.sampleRate);
    noiseBuffer = c.createBuffer(1, n, c.sampleRate);
    const d = noiseBuffer.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
    return noiseBuffer;
  }

  /**
   * Begin releasing a voice at `when`, removing it from the active map.
   * @param {string} key
   * @param {number} when
   * @param {number} rel release time in seconds
   */
  function releaseVoice(key, when, rel) {
    const voice = music.voices.get(key);
    if (!voice) return;
    music.voices.delete(key);
    const g = voice.gain.gain;
    try {
      if (typeof g.cancelAndHoldAtTime === 'function') g.cancelAndHoldAtTime(when);
      else {
        g.cancelScheduledValues(when);
        g.setValueAtTime(Math.max(g.value, 0.0001), when);
      }
      g.linearRampToValueAtTime(0.0001, when + rel);
      voice.osc.stop(when + rel + 0.02);
    } catch { /* ignore */ }
    voice.osc.onended = () => {
      try {
        voice.osc.disconnect();
        voice.gain.disconnect();
      } catch { /* ignore */ }
    };
  }

  /** @param {number} when @param {number} rel */
  function releaseAllVoices(when, rel) {
    for (const key of Array.from(music.voices.keys())) releaseVoice(key, when, rel);
  }

  /**
   * @param {number} ch
   * @param {number} note
   * @param {number} vel
   * @param {number} when
   */
  function startNote(ch, note, vel, when) {
    const key = ch + ':' + note;
    if (music.voices.has(key)) releaseVoice(key, when, 0.02);

    const peak = (clamp(vel, 0, 127) / 127) * music.volumes[ch] * 0.15;
    if (!(peak > 0)) return;

    while (music.voices.size >= MAX_MELODIC_VOICES) {
      const oldest = music.voices.keys().next().value;
      if (oldest === undefined) break;
      releaseVoice(oldest, when, 0.02);
    }

    const osc = ctx.createOscillator();
    osc.type = waveformFor(music.programs[ch]);
    osc.frequency.setValueAtTime(noteToFreq(note), when);
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0, when);
    gain.gain.linearRampToValueAtTime(peak, when + 0.005);
    osc.connect(gain);
    gain.connect(musicGain);
    osc.start(when);
    music.voices.set(key, { key, osc, gain, ch, note });
    counters.notesScheduled++;
  }

  /**
   * @param {number} note
   * @param {number} vel
   * @param {number} when
   */
  function playDrum(note, vel, when) {
    let type = 'bandpass';
    let freq = 3000;
    let dur = 0.1;
    if (note === 35 || note === 36) { type = 'lowpass'; freq = 150; dur = 0.12; }
    else if (note === 38 || note === 40) { type = 'bandpass'; freq = 1800; dur = 0.15; }
    else if (note === 42 || note === 44 || note === 46) {
      type = 'highpass'; freq = 7000; dur = note === 46 ? 0.25 : 0.05;
    }

    const gainVal = (clamp(vel, 0, 127) / 127) * 0.25;
    if (!(gainVal > 0)) return;

    const src = ctx.createBufferSource();
    src.buffer = getNoiseBuffer();
    const filter = ctx.createBiquadFilter();
    filter.type = type;
    filter.frequency.value = freq;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(gainVal, when);
    gain.gain.exponentialRampToValueAtTime(0.0001, when + dur);
    src.connect(filter);
    filter.connect(gain);
    gain.connect(musicGain);
    src.onended = () => {
      try {
        src.disconnect();
        filter.disconnect();
        gain.disconnect();
      } catch { /* ignore */ }
    };
    src.start(when, Math.random() * 0.4, dur + 0.02);
    counters.notesScheduled++;
  }

  /**
   * Apply one scheduled MIDI event to the audio graph.
   * @param {MidiEvent} e
   * @param {number} when
   */
  function applyEvent(e, when) {
    if (e.kind === 'prog') {
      music.programs[e.ch] = e.a | 0;
      return;
    }
    if (e.kind === 'cc') {
      if (e.c === 7) music.volumes[e.ch] = clamp(e.v, 0, 127) / 127;
      return;
    }
    if (e.ch === 9) {
      if (e.kind === 'on') playDrum(e.note, e.vel, when);
      return;
    }
    if (e.kind === 'on') startNote(e.ch, e.note, e.vel, when);
    else releaseVoice(e.ch + ':' + e.note, when, 0.08);
  }

  // -------------------------------------------------------------- scheduler --

  function scheduleTick() {
    try {
      const song = music.song;
      if (!song || music.paused || !ctx) return;
      const now = ctx.currentTime;
      const horizon = now + LOOKAHEAD;
      let guard = 8192;

      while (guard-- > 0) {
        if (song.index >= song.events.length) {
          const endTime = song.startTime + song.duration;
          if (song.looping && song.duration > 0) {
            if (endTime > horizon) break;
            song.startTime = endTime;
            song.index = 0;
            continue;
          }
          if (endTime <= now) {
            music.playing = false;
            stopScheduler();
            music.song = null;
          }
          break;
        }
        const e = song.events[song.index];
        const when = song.startTime + e.time;
        if (when > horizon) break;
        song.index++;
        applyEvent(e, Math.max(when, now));
      }
    } catch {
      counters.errors++;
    }
  }

  function startScheduler() {
    if (music.timer !== null) return;
    music.timer = setInterval(scheduleTick, SCHED_INTERVAL_MS);
    scheduleTick();
  }

  function stopScheduler() {
    if (music.timer !== null) {
      clearInterval(music.timer);
      music.timer = null;
    }
  }

  function resetChannelState() {
    music.programs.fill(0);
    music.volumes.fill(100 / 127);
  }

  // ------------------------------------------------------------------ music --

  /**
   * @param {number} ptr
   * @param {number} len
   * @param {number} looping
   * @returns {number} 0
   */
  function musPlay(ptr, len, looping) {
    stopMusic(0.01);
    const bytes = readBytes(ptr, len);
    if (!bytes) return 0;
    const parsed = parseMidi(bytes);
    if (!parsed || !parsed.events.length) return 0;

    const c = ensureContext();
    resetChannelState();
    music.song = {
      events: parsed.events,
      duration: parsed.duration,
      index: 0,
      startTime: c.currentTime + 0.05,
      looping: !!looping,
    };
    music.paused = false;
    music.playing = true;
    musicGain.gain.cancelScheduledValues(c.currentTime);
    musicGain.gain.setValueAtTime(musicVolume, c.currentTime);
    startScheduler();
    return 0;
  }

  /**
   * @param {number} rel seconds for the release ramp
   */
  function stopMusic(rel) {
    stopScheduler();
    if (ctx) releaseAllVoices(ctx.currentTime + 0.005, rel);
    music.song = null;
    music.playing = false;
    music.paused = false;
  }

  // ------------------------------------------------------------------ public --

  const api = {
    /**
     * @param {number} channel
     * @param {number} ptr
     * @param {number} len
     * @param {number} vol 0..127
     * @param {number} sep 0 left .. 128 centre .. 255 right
     * @returns {number} channel
     */
    sfx_start(channel, ptr, len, vol, sep) {
      if (!enabled) return 0;
      try {
        return startSfx(channel | 0, ptr, len, vol, sep);
      } catch {
        counters.errors++;
        return channel | 0;
      }
    },
    /** @param {number} channel @returns {number} 0 */
    sfx_stop(channel) {
      if (!enabled) return 0;
      try {
        stopSfxChannel(channel | 0);
      } catch {
        counters.errors++;
      }
      return 0;
    },
    /**
     * @param {number} channel
     * @param {number} vol
     * @param {number} sep
     * @returns {number} 0
     */
    sfx_update(channel, vol, sep) {
      if (!enabled) return 0;
      try {
        const voice = channels.get(channel | 0);
        if (voice && ctx) {
          const now = ctx.currentTime;
          voice.gain.gain.setTargetAtTime(clamp(vol, 0, 127) / 127, now, 0.01);
          voice.pan.pan.setTargetAtTime(
            clamp((clamp(sep, 0, 255) - 128) / 127, -1, 1), now, 0.01,
          );
        }
      } catch {
        counters.errors++;
      }
      return 0;
    },
    /** @param {number} channel @returns {number} 1 if playing */
    sfx_playing(channel) {
      if (!enabled) return 0;
      try {
        return channels.has(channel | 0) ? 1 : 0;
      } catch {
        counters.errors++;
        return 0;
      }
    },
    /** @param {number} ptr @param {number} len @param {number} looping @returns {number} 0 */
    mus_play(ptr, len, looping) {
      if (!enabled) return 0;
      try {
        return musPlay(ptr, len, looping);
      } catch {
        counters.errors++;
        return 0;
      }
    },
    /** @returns {number} 0 */
    mus_stop() {
      if (!enabled) return 0;
      try {
        stopMusic(0.03);
      } catch {
        counters.errors++;
      }
      return 0;
    },
    /** @param {number} v 0..127 @returns {number} 0 */
    mus_volume(v) {
      if (!enabled) return 0;
      try {
        musicVolume = clamp(v, 0, 127) / 127;
        if (musicGain && ctx && !music.paused) {
          musicGain.gain.setTargetAtTime(musicVolume, ctx.currentTime, 0.01);
        }
      } catch {
        counters.errors++;
      }
      return 0;
    },
    /** @param {number} p 1 = pause, 0 = resume @returns {number} 0 */
    mus_pause(p) {
      if (!enabled) return 0;
      try {
        const on = !!p;
        if (on) {
          if (music.paused) return 0;
          music.paused = true;
          if (ctx && music.song) {
            music.pausePos = Math.max(0, ctx.currentTime - music.song.startTime);
          } else {
            music.pausePos = 0;
          }
          stopScheduler();
          if (ctx && musicGain) {
            const now = ctx.currentTime;
            const g = musicGain.gain;
            g.cancelScheduledValues(now);
            g.setValueAtTime(g.value, now);
            g.linearRampToValueAtTime(0, now + 0.02);
            releaseAllVoices(now + 0.01, 0.03);
          }
        } else {
          if (!music.paused) return 0;
          music.paused = false;
          if (ctx && musicGain && music.song) {
            const now = ctx.currentTime;
            music.song.startTime = now + 0.03 - music.pausePos;
            const evs = music.song.events;
            let i = 0;
            while (i < evs.length && evs[i].time < music.pausePos) i++;
            music.song.index = i;
            const g = musicGain.gain;
            g.cancelScheduledValues(now);
            g.setValueAtTime(0, now);
            g.linearRampToValueAtTime(musicVolume, now + 0.03);
            music.playing = true;
            startScheduler();
          }
        }
      } catch {
        counters.errors++;
      }
      return 0;
    },

    /** @returns {AudioContext|null} */
    get context() {
      return ctx;
    },

    /** @returns {{sfxStarted:number, sfxActive:number, musicPlaying:boolean, notesScheduled:number, errors:number}} */
    get stats() {
      return {
        sfxStarted: counters.sfxStarted,
        sfxActive: channels.size,
        musicPlaying: music.playing,
        notesScheduled: counters.notesScheduled,
        errors: counters.errors,
      };
    },

    /** @param {number} v 0..1 */
    setMasterVolume(v) {
      masterVolume = clamp(v, 0, 1);
      if (!enabled) return;
      try {
        if (masterGain && ctx) {
          masterGain.gain.setTargetAtTime(masterVolume, ctx.currentTime, 0.01);
        }
      } catch {
        counters.errors++;
      }
    },

    /**
     * Connect the master output to an extra node (used by tests to record).
     * @param {AudioNode} node
     * @returns {AudioNode}
     */
    tap(node) {
      if (!enabled) return node;
      try {
        ensureContext();
        masterGain.connect(node);
      } catch {
        counters.errors++;
      }
      return node;
    },

    /** Resume the AudioContext (call from a user gesture). @returns {Promise<void>} */
    resume() {
      if (!enabled) return Promise.resolve();
      try {
        return ensureContext().resume().catch(() => {});
      } catch {
        counters.errors++;
        return Promise.resolve();
      }
    },
  };

  return {
    imports: {
      sfx_start: api.sfx_start,
      sfx_stop: api.sfx_stop,
      sfx_update: api.sfx_update,
      sfx_playing: api.sfx_playing,
      mus_play: api.mus_play,
      mus_stop: api.mus_stop,
      mus_volume: api.mus_volume,
      mus_pause: api.mus_pause,
    },
    resume: api.resume,
    get context() {
      return api.context;
    },
    get stats() {
      return api.stats;
    },
    setMasterVolume: api.setMasterVolume,
    tap: api.tap,
  };
}
