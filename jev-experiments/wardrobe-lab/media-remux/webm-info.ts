// Minimal read-only EBML inspection for the two recorded media artifacts.
type Element = { id: number; offset: number; data: number; end: number };
function variable(bytes: Buffer, at: number, keepMarker: boolean) {
  const first = bytes[at];
  if (!first) throw new Error(`Invalid EBML integer at ${at}`);
  let width = 1, mask = 0x80;
  while (!(first & mask)) { width++; mask >>= 1; }
  if (at + width > bytes.length) throw new Error("Truncated EBML integer");
  let value = keepMarker ? first : first & (mask - 1);
  let unknown = !keepMarker && value === mask - 1;
  for (let i = 1; i < width; i++) { value = value * 256 + bytes[at + i]; unknown &&= bytes[at + i] === 255; }
  return { width, value, unknown };
}
function elements(bytes: Buffer, start = 0, end = bytes.length): Element[] {
  const found: Element[] = [];
  for (let offset = start; offset < end;) {
    const id = variable(bytes, offset, true), size = variable(bytes, offset + id.width, false);
    const data = offset + id.width + size.width, next = size.unknown ? end : data + size.value;
    if (next > end || next <= offset) throw new Error("Invalid EBML element size");
    found.push({ id: id.value, offset, data, end: next }); offset = next;
  }
  return found;
}
function uint(bytes: Buffer, element: Element) {
  let value = 0;
  for (let i = element.data; i < element.end; i++) value = value * 256 + bytes[i];
  return value;
}
export function webmInfo(bytes: Buffer) {
  const segment = elements(bytes).find(e => e.id === 0x18538067);
  if (!segment) throw new Error("WebM segment missing");
  const children = elements(bytes, segment.data, segment.end);
  const info = children.find(e => e.id === 0x1549a966);
  const fields = info ? elements(bytes, info.data, info.end) : [];
  const scale = fields.find(e => e.id === 0x2ad7b1), duration = fields.find(e => e.id === 0x4489);
  const ticks = duration ? duration.end - duration.data === 8 ? bytes.readDoubleBE(duration.data) : bytes.readFloatBE(duration.data) : null;
  const cues = children.find(e => e.id === 0x1c53bb6b), cluster = children.find(e => e.id === 0x1f43b675);
  const points = cues ? elements(bytes, cues.data, cues.end).filter(e => e.id === 0xbb) : [];
  const positions = points.flatMap(point => elements(bytes, point.data, point.end).filter(e => e.id === 0xb7)
    .flatMap(track => elements(bytes, track.data, track.end).filter(e => e.id === 0xf1).map(e => segment.data + uint(bytes, e))));
  return {
    durationSeconds: ticks === null ? null : ticks * (scale ? uint(bytes, scale) : 1_000_000) / 1_000_000_000,
    cuePoints: points.length,
    cuesOffset: cues?.offset ?? null,
    firstClusterOffset: cluster?.offset ?? null,
    cuePositionsValid: positions.length > 0 && positions.every(at => at + 4 <= bytes.length && bytes.readUInt32BE(at) === 0x1f43b675),
  };
}
