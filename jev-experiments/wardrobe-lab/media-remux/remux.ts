// One-time local repair. No network, credentials, model calls or transcoding.
import { createHash } from "node:crypto";
import { copyFileSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { webmInfo } from "./webm-info";

const ffmpeg = process.env.FFMPEG_BIN ?? "ffmpeg";
const root = fileURLToPath(new URL("../", import.meta.url));
const temp = mkdtempSync(join(tmpdir(), "wardrobe-remux-"));
const digest = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
function run(args: string[]) {
  const result = Bun.spawnSync([ffmpeg, ...args], { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString();
}
function packetRows(path: string) {
  const output = run(["-v", "error", "-copyts", "-i", path, "-map", "0", "-c", "copy", "-f", "framehash", "-hash", "sha256", "-"]);
  return { timeBases: output.split("\n").filter(line => line.startsWith("#tb ")), rows: output.split("\n").filter(line => line && !line.startsWith("#")).map(line => line.split(",").map(part => part.trim())) };
}
const evidence: any = { method: "All streams copied without decoding or encoding; original packet payload/order and timestamps compared before replacing each file.", command: "ffmpeg -copyts -i INPUT -map 0 -c copy -map_metadata 0 -avoid_negative_ts disabled -cues_to_front 1 OUTPUT.webm", ffmpeg: run(["-version"]).split("\n")[0], artifacts: [] };
const staged: { output: string; path: string; metaPath: string; meta: unknown }[] = [];
for (const [stem, manifestName] of [["try-on-demo", "recording.json"], ["spoken-try-on-demo", "spoken-recording.json"]]) {
  const path = join(root, "assets", `${stem}.webm`), before = readFileSync(path), infoBefore = webmInfo(before);
  if (infoBefore.durationSeconds !== null || infoBefore.cuePoints) throw new Error(`${stem} already has duration/cues; refusing a second repair`);
  const original = join(temp, `${stem}-original.webm`), output = join(temp, `${stem}-indexed.webm`);
  copyFileSync(path, original);
  const packetInfoBefore = packetRows(original), packetsBefore = packetInfoBefore.rows;
  run(["-v", "error", "-copyts", "-i", original, "-map", "0", "-c", "copy", "-map_metadata", "0", "-avoid_negative_ts", "disabled", "-cues_to_front", "1", output]);
  const after = readFileSync(output), infoAfter = webmInfo(after), packetInfoAfter = packetRows(output), packetsAfter = packetInfoAfter.rows;
  const payload = (rows: string[][]) => rows.map(row => [row[0], row[4], row[5]].join(",")).join("\n");
  if (payload(packetsBefore) !== payload(packetsAfter)) throw new Error(`${stem}: packet payload changed`);
  const timestampsEqual = JSON.stringify(packetsBefore.map(row => row.slice(0, 3))) === JSON.stringify(packetsAfter.map(row => row.slice(0, 3))) && JSON.stringify(packetInfoBefore.timeBases) === JSON.stringify(packetInfoAfter.timeBases);
  if (!timestampsEqual) throw new Error(`${stem}: packet timestamp/time base changed`);
  if (!infoAfter.durationSeconds || !infoAfter.cuePositionsValid || after.length >= 2_000_000) throw new Error(`${stem}: invalid repaired media`);
  const decodedBefore = run(["-v", "error", "-i", original, "-map", "0", "-vsync", "0", "-f", "streamhash", "-hash", "sha256", "-"]).trim();
  const decodedAfter = run(["-v", "error", "-i", output, "-map", "0", "-vsync", "0", "-f", "streamhash", "-hash", "sha256", "-"]).trim();
  if (decodedBefore !== decodedAfter) throw new Error(`${stem}: decoded stream changed`);
  const artifact = { file: `assets/${stem}.webm`, before: { bytes: before.length, sha256: digest(before), ...infoBefore }, after: { bytes: after.length, sha256: digest(after), ...infoAfter }, encodedPackets: { count: packetsBefore.length, payloadSequenceSha256: digest(payload(packetsBefore)), unchanged: true, timestampsAndTimeBasesUnchanged: timestampsEqual, timeBases: packetInfoBefore.timeBases, byStream: Object.fromEntries([...new Set(packetsBefore.map(row => row[0]))].map(index => [index, { packets: packetsBefore.filter(row => row[0] === index).length, declaredPacketDurationsBefore: [...new Set(packetsBefore.filter(row => row[0] === index).map(row => Number(row[3])))], declaredPacketDurationsAfter: [...new Set(packetsAfter.filter(row => row[0] === index).map(row => Number(row[3])))], payloadSequenceSha256: digest(payload(packetsBefore.filter(row => row[0] === index))) }])) } };
  const metaPath = join(root, manifestName), meta = JSON.parse(readFileSync(metaPath, "utf8"));
  meta.videoBytes = after.length;
  meta.videoSha256 = digest(after);
  meta.containerDurationSeconds = infoAfter.durationSeconds;
  meta.mediaPostprocessing = { operation: "lossless WebM remux for finite duration and front-loaded seek cues", originalVideoBytes: before.length, originalVideoSha256: digest(before), evidenceFile: "media-remux/verification.json", unchangedEncodedPackets: true, captureWallTimePreservedIn: "actualRecordedSeconds" };
  staged.push({ output, path, metaPath, meta });
  evidence.artifacts.push({ ...artifact, decodedStreams: { method: "ffmpeg -i INPUT -map 0 -vsync 0 -f streamhash -hash sha256 -; default raw video and PCM audio", beforeAndAfterEqual: true, hashes: decodedBefore.split("\n") } });
}
for (const change of staged) { renameSync(change.output, change.path); writeFileSync(change.metaPath, JSON.stringify(change.meta, null, 2) + "\n"); }
writeFileSync(join(root, "media-remux/verification.json"), JSON.stringify(evidence, null, 2) + "\n");
console.log(JSON.stringify(evidence, null, 2));
