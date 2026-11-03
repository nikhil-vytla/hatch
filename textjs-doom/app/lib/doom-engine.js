// Runs doom.wasm (doomgeneric compiled for wasm32-wasi) anywhere WebAssembly
// runs: the browser, Bun or Node. It ships a tiny in-memory WASI so the only
// "file system" is the WAD you hand it, plus scratch files Doom writes
// (default.cfg, savegames), which stay in memory.

const ESUCCESS = 0, EBADF = 8, EINVAL = 28, ENOENT = 44, ENOSYS = 52;

class ExitError extends Error {
  constructor(code) { super(`doom exited with code ${code}`); this.code = code; }
}

function makeWasi(files, log) {
  let mem = null;
  const dv = () => new DataView(mem.buffer);
  const u8 = () => new Uint8Array(mem.buffer);
  const dec = new TextDecoder();
  const fds = new Map(); // fd -> { path, pos } ; fd 3 is the preopened "." dir
  let nextFd = 4;
  const lineBuf = { 1: "", 2: "" };

  const str = (ptr, len) => dec.decode(u8().subarray(ptr, ptr + len));
  const norm = (p) => p.replace(/^\.\//, "").replace(/^\/+/, "");

  const wasi = {
    args_sizes_get: (argc, size) => { dv().setUint32(argc, 0, true); dv().setUint32(size, 0, true); return 0; },
    args_get: () => 0,
    environ_sizes_get: (c, s) => { dv().setUint32(c, 0, true); dv().setUint32(s, 0, true); return 0; },
    environ_get: () => 0,
    clock_time_get: (_id, _prec, out) => {
      dv().setBigUint64(out, BigInt(Math.round(performance.now() * 1e6)), true);
      return 0;
    },
    clock_res_get: (_id, out) => { dv().setBigUint64(out, 1000n, true); return 0; },
    random_get: (buf, len) => { const b = u8(); for (let i = 0; i < len; i++) b[buf + i] = (Math.random() * 256) | 0; return 0; },
    proc_exit: (code) => { throw new ExitError(code); },
    sched_yield: () => 0,
    poll_oneoff: () => ENOSYS,

    fd_prestat_get: (fd, out) => {
      if (fd !== 3) return EBADF;
      dv().setUint8(out, 0); dv().setUint32(out + 4, 1, true); return 0;
    },
    fd_prestat_dir_name: (fd, ptr, len) => { if (fd !== 3) return EBADF; u8()[ptr] = 46; return 0; },
    fd_fdstat_get: (fd, out) => {
      const d = dv();
      // filetype: 2 = char device (stdio), 3 = directory, 4 = regular file
      d.setUint8(out, fd <= 2 ? 2 : fd === 3 ? 3 : 4);
      d.setUint16(out + 2, 0, true);
      d.setBigUint64(out + 8, 0xffffffffn, true);
      d.setBigUint64(out + 16, 0xffffffffn, true);
      return fd <= 3 || fds.has(fd) ? 0 : EBADF;
    },
    fd_fdstat_set_flags: () => 0,
    fd_filestat_get: (fd, out) => {
      const f = fds.get(fd); if (!f) return EBADF;
      const d = dv(); for (let i = 0; i < 64; i += 8) d.setBigUint64(out + i, 0n, true);
      d.setUint8(out + 16, 4); d.setBigUint64(out + 32, BigInt(files.get(f.path).length), true);
      return 0;
    },
    path_filestat_get: (_fd, _flags, p, plen, out) => {
      const path = norm(str(p, plen)); const data = files.get(path); if (!data) return ENOENT;
      const d = dv(); for (let i = 0; i < 64; i += 8) d.setBigUint64(out + i, 0n, true);
      d.setUint8(out + 16, 4); d.setBigUint64(out + 32, BigInt(data.length), true);
      return 0;
    },
    path_open: (_dirfd, _df, p, plen, oflags, _rb, _ri, _fdflags, outFd) => {
      const path = norm(str(p, plen));
      const O_CREAT = 1, O_TRUNC = 8;
      if (!files.has(path)) { if (!(oflags & O_CREAT)) return ENOENT; files.set(path, new Uint8Array(0)); }
      if (oflags & O_TRUNC) files.set(path, new Uint8Array(0));
      const fd = nextFd++; fds.set(fd, { path, pos: 0 });
      dv().setUint32(outFd, fd, true);
      return 0;
    },
    fd_close: (fd) => { fds.delete(fd); return 0; },
    fd_seek: (fd, offset, whence, out) => {
      const f = fds.get(fd); if (!f) return EBADF;
      const size = files.get(f.path).length; const off = Number(offset);
      f.pos = whence === 0 ? off : whence === 1 ? f.pos + off : size + off;
      dv().setBigUint64(out, BigInt(f.pos), true);
      return 0;
    },
    fd_tell: (fd, out) => { const f = fds.get(fd); if (!f) return EBADF; dv().setBigUint64(out, BigInt(f.pos), true); return 0; },
    fd_read: (fd, iovs, n, outN) => {
      const f = fds.get(fd); if (!f) { dv().setUint32(outN, 0, true); return fd === 0 ? 0 : EBADF; }
      const data = files.get(f.path); const d = dv(); const b = u8(); let total = 0;
      for (let i = 0; i < n; i++) {
        const ptr = d.getUint32(iovs + i * 8, true), len = d.getUint32(iovs + i * 8 + 4, true);
        const chunk = data.subarray(f.pos, Math.min(data.length, f.pos + len));
        b.set(chunk, ptr); f.pos += chunk.length; total += chunk.length;
        if (chunk.length < len) break;
      }
      d.setUint32(outN, total, true);
      return 0;
    },
    fd_write: (fd, iovs, n, outN) => {
      const d = dv(); const b = u8(); let total = 0;
      for (let i = 0; i < n; i++) {
        const ptr = d.getUint32(iovs + i * 8, true), len = d.getUint32(iovs + i * 8 + 4, true);
        const chunk = b.slice(ptr, ptr + len); total += len;
        if (fd === 1 || fd === 2) {
          lineBuf[fd] += dec.decode(chunk);
          let nl; while ((nl = lineBuf[fd].indexOf("\n")) >= 0) { log(lineBuf[fd].slice(0, nl)); lineBuf[fd] = lineBuf[fd].slice(nl + 1); }
        } else {
          const f = fds.get(fd); if (!f) return EBADF;
          const old = files.get(f.path); const end = f.pos + len;
          const grown = end > old.length ? new Uint8Array(end) : old;
          if (grown !== old) grown.set(old);
          grown.set(chunk, f.pos); f.pos = end; files.set(f.path, grown);
        }
      }
      d.setUint32(outN, total, true);
      return 0;
    },
    path_create_directory: () => 0,
    path_remove_directory: () => 0,
    path_unlink_file: (_fd, p, plen) => { files.delete(norm(str(p, plen))); return 0; },
    path_rename: (_fd, a, al, _fd2, b, bl) => {
      const from = norm(str(a, al)), to = norm(str(b, bl));
      if (!files.has(from)) return ENOENT; files.set(to, files.get(from)); files.delete(from); return 0;
    },
  };
  // Anything we did not implement answers ENOSYS instead of failing to link.
  const proxy = new Proxy(wasi, { get: (t, k) => t[k] ?? (() => ENOSYS) });
  return { imports: proxy, setMemory: (m) => { mem = m; } };
}

// Doom key codes (doomkeys.h).
export const DoomKey = {
  RIGHT: 0xae, LEFT: 0xac, UP: 0xad, DOWN: 0xaf, STRAFE_L: 0xa0, STRAFE_R: 0xa1,
  USE: 0xa2, FIRE: 0xa3, ESCAPE: 27, ENTER: 13, TAB: 9, BACKSPACE: 0x7f,
  RSHIFT: 0x80 + 0x36, RALT: 0x80 + 0x38, PAUSE: 0xff,
  F1: 0x80 + 0x3b, F2: 0x80 + 0x3c, F3: 0x80 + 0x3d, F4: 0x80 + 0x3e, F5: 0x80 + 0x3f,
  F6: 0x80 + 0x40, F7: 0x80 + 0x41, F8: 0x80 + 0x42, F9: 0x80 + 0x43, F10: 0x80 + 0x44,
  F11: 0x80 + 0x57, F12: 0x80 + 0x58,
};

/**
 * Boot Doom.
 * @param {{ wasm: BufferSource | WebAssembly.Module, wad: Uint8Array, log?: (line: string) => void,
 *           onFrame?: () => void, now?: () => number }} opts
 */
export async function createDoom({ wasm, wad, log = () => {}, onFrame = () => {}, now = () => performance.now() }) {
  const files = new Map([["doom1.wad", wad]]);
  const w = makeWasi(files, log);
  const t0 = now();
  let frames = 0;
  const imports = {
    wasi_snapshot_preview1: w.imports,
    textjs: {
      ticks_ms: () => (now() - t0) >>> 0,
      frame: () => { frames++; onFrame(); },
    },
  };
  const module = wasm instanceof WebAssembly.Module ? wasm : await WebAssembly.compile(wasm);
  const instance = await WebAssembly.instantiate(module, imports);
  const ex = instance.exports;
  w.setMemory(ex.memory);
  ex._initialize?.();
  ex.tx_init(0);

  const width = ex.tx_width(), height = ex.tx_height();
  const rgba = new Uint8Array(width * height * 4);
  let exited = null;

  return {
    width, height, files, t0,
    /** The game's own tic counter (35Hz) at time `ms` on the same clock as `now`. */
    ticAt(ms) { return Math.floor(((ms - t0) * 35) / 1000); },
    get frames() { return frames; },
    get exited() { return exited; },
    /** Advance the game: runs every 35Hz tic that is due, then draws once. */
    tick() {
      if (exited !== null) return;
      try { ex.tx_tick(); } catch (e) { if (e instanceof ExitError) exited = e.code; else throw e; }
    },
    key(pressed, doomKey) { ex.tx_push_key(pressed ? 1 : 0, doomKey); },
    /** Copy the framebuffer (XRGB8888, little endian = B,G,R,X) into an RGBA array. */
    pixels() {
      const src = new Uint8Array(ex.memory.buffer, ex.tx_framebuffer(), width * height * 4);
      for (let i = 0; i < src.length; i += 4) {
        rgba[i] = src[i + 2]; rgba[i + 1] = src[i + 1]; rgba[i + 2] = src[i]; rgba[i + 3] = 255;
      }
      return { width, height, data: rgba };
    },
  };
}
