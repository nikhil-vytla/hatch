# Scene lifetimes and public benchmark output

Scene cleanup now invalidates work before a delayed callback can change the next session. Wardrobe pauses the captured video element even after React clears its ref, releases its stream, and detaches speech callbacks. Arcade, Icons, Drawing, Café and Ghost Brush cancel unfinished work while preserving completed edits. Replay and benchmark reading reset only when their selected case changes.

These component fixes work with ordinary unmounting. Reconnecting effects in a retained scene also preserves the selected replay step and reading state. The navigation shell that keeps scenes mounted is a separate change; this PR does not add scene-to-note retention by itself.

The build also uses a pinned display projection for four benchmark candidate texts. It checks row identity and each text hash before replacing display text, preserves the original JSONL, and leaves labels, scores, counts and aggregate metrics unchanged. Missing, changed or ambiguous matches fail the build. Running the projection twice produces the same output.

## Verification

An exact archive of source commit `9eb695e1ad97949c91ed0600a32827c6dd25ffe7` passes frozen Bun installation, the production build, and **19 tests with 91 assertions**. No prepared public assets or working-tree changes were overlaid. The detached-video regression fails against canonical main with the expected missing pause and passes with the correction. [Command record and source hashes](verification.json).

```sh
cd jev-experiments/experience-prototypes
bun install --frozen-lockfile
bun run build
cd ../..
bun test jev-experiments/scene-lifetimes-2026-09-22
```

Sixteen tests execute maintained component callbacks with controlled requests, refs and timers. Three projection tests check reordered options, idempotence, changed/ambiguous inputs, and preservation of every other field in the real benchmark document. Callback tests do not reproduce React's full scheduler, browser media playback, or physical devices. Broader development-browser evidence belongs to its separate integrated source condition.

The GitHub workflow runs the same install, build and tests with Bun 1.3.14 and pinned action revisions. Its remote result is recorded after publication. The Vercel project, application root, dependencies and lockfile are unchanged. [Source and workflow patch](changes.patch).
