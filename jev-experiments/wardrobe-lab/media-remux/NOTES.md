# Wardrobe media container repair

- Scope: inspect and, if needed, losslessly remux the two existing recorded WebM files. No new provider/model calls or app changes.
- Existing media manifests record capture wall time and original byte sizes. No exact WebM hashes are currently recorded. Tests check VP8/Opus signatures but do not inspect duration or seek metadata.
- FFmpeg is absent from PATH. Using the imageio-ffmpeg binary cached by uv outside the repository, with explicit stream copy and independent packet/hash verification.

## Lossless WebM duration and seek repair

- Reproduced the source-container defect: spoken playback reached readyState 4 but Chrome duration was Infinity. FFmpeg reported Duration N/A for both clips, and EBML inspection found no duration/cues.
- Used FFmpeg 7.1 stream copy with all streams, preserved timestamps, no negative-time shift and front-loaded cues. Both clips now have six valid seek entries. Control is 905,077 bytes /29.905s; spoken is 994,578 bytes /29.954s. Capture wall times remain unchanged, with separate container durations and original/current hashes in both manifests.
- Compared every encoded packet payload/order and DTS/PTS/time base before replacing files. The control retained 578 VP8 packets; spoken retained 577 VP8 and 111 Opus packets. Independent decoded video and audio hashes also matched. The muxer inferred missing VP8 packet-duration metadata as 1ms while preserving presentation timestamps; this explains the first overly strict verification rejection. No replacement occurred until the preservation checks passed.
- Chrome then reported finite duration and seek ranges for both files. Seeking to 4,29,13,1 seconds worked and playback resumed without media errors. Opened and inspected the browser screenshot. All binaries are below 2MB. Added artifact tests for duration, real cue targets, front-loaded indexes, exact hashes and sizes. The wardrobe suite passes 22 tests /138 assertions.
- Repair code and detailed proof are in media-remux/. No app code, new provider/model calls or commits. The brief read-only local review server had an unrelated favicon 404; footage and audio were unchanged.
