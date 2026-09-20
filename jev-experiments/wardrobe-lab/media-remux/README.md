# Finite, seekable wardrobe recordings

The original MediaRecorder WebM files had no Duration element or Cues. Chrome decoded the spoken clip but reported `duration === Infinity`; FFmpeg reported `Duration: N/A` for both files. Both containers now have finite duration, six cue points and a seek index before the first media cluster.

| Clip | Original bytes | Current bytes | Saved media timeline |
| --- | ---: | ---: | ---: |
| Authored control | 904,639 | 905,077 | 29.905s |
| Spoken pipeline | 994,156 | 994,578 | 29.954s |

The original capture wall times remain unchanged in the recording manifests. Their `containerDurationSeconds` fields describe the saved packets. No frames or audio packets were cut to produce these durations.

## Method and preservation checks

FFmpeg 7.1 copied every stream into a seekable local output file:

```sh
ffmpeg -copyts -i INPUT.webm -map 0 -c copy -map_metadata 0 \
  -avoid_negative_ts disabled -cues_to_front 1 OUTPUT.webm
```

FFmpeg's [stream-copy mode](https://ffmpeg.org/ffmpeg.html#Streamcopy) avoids decoding and re-encoding. Its [WebM cue option](https://ffmpeg.org/ffmpeg-formats.html#matroska) moves the seek index before the media data. The binary came from imageio-ffmpeg's uv cache outside the repository. No provider or model call ran.

[verification.json](verification.json) records exact original/current file SHA256 hashes, parsed duration/cues and packet evidence. All 578 control VP8 packets and all 577 spoken VP8 plus 111 Opus packets retained identical payloads, ordering, DTS, PTS and time bases. Independent hashes of decoded video and PCM audio also matched. The muxer filled previously unspecified VP8 packet-duration metadata with 1ms defaults; packet presentation times and decoded content did not change. Opus packet durations stayed 60ms.

[remux.ts](remux.ts) contains the repair and preservation checks. It requires `FFMPEG_BIN` or an `ffmpeg` executable and refuses already indexed files. It stages both outputs before replacing the originals. Original backup files and the dependency binary remain outside the repository; no duplicate footage is included here.

## Verification

```sh
bun test jev-experiments/wardrobe-lab
bun jev-experiments/wardrobe-lab/media-remux/serve.ts
# Read-only local playback at http://127.0.0.1:8898 for five minutes.
```

The wardrobe suite passes 22 tests with 138 assertions. The new artifact tests parse EBML metadata, verify cue offsets point to actual clusters, require cues before the first cluster, and verify exact manifest hashes and byte lengths. Existing tests retain the separate control/spoken provenance and VP8/Opus track checks.

Chrome reports 29.905s and 29.954s, with finite seekable ranges. Both clips sought to 4, 29, 13 and 1 seconds, reached `readyState === 4`, and resumed playback without a media error. The [browser observations](browser.json) and [inspected screenshot](browser.png) record that check. The local review page produced only an unrelated missing favicon request. All changed binary files remain below 2MB.
