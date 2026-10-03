# Who said that? for the Mac menu bar (prototype)

This menu-bar app records your conversation locally and writes a transcript sorted by speaker. It runs the same pipeline as the website's "Who said that?" scene (`jev-experiments/live-worlds/who-said-that/`): whisper-tiny.en, all-MiniLM-L6-v2 and Wespeaker CAM++, through Bun on this Mac. Nothing is uploaded.

## Build

Requires macOS 14+, the Xcode command-line tools (`swiftc`) and Bun.

```sh
cd jev-experiments/experience-prototypes && bun install --frozen-lockfile   # once, for the pipeline
../apps/who-said-that-mac/build.sh                                         # → build/WhoSaidThat.app
open ../apps/who-said-that-mac/build/WhoSaidThat.app
```

`build.sh` compiles `Sources/main.swift` and writes this checkout's path and your Bun path into the app's `Info.plist`. It then ad-hoc signs the app, so it only runs on the Mac that built it.

## Use

1. Click the two-people icon in the menu bar, then **Record me (5 s)** and say anything.
2. **Record my friend (5 s)**.
3. **Start the conversation**, talk, then **Stop and write the transcript**.
4. The transcript opens from `~/Documents/Who said that/`. Recordings are in `~/Library/Application Support/WhoSaidThat/`.

The first run asks for microphone access and downloads the models, about 93 MB.

## Status (1 Oct 2026)

- **Built and launched:** the app built with Swift 6.3 on macOS 26.6 and launched.
- **The pipeline it calls:** `cli.proto.ts` was run end to end on WAVs cut from the scripted café clip. It wrote a correct Markdown transcript in 7 s on an M4 Max.
- **Not tested:**
  - the microphone recording path, which needs a person to grant microphone access and speak
  - a screenshot of the open menu, because the terminal that ran the build has no Screen Recording permission
- **Prototype limits:** the 5-second tags are fixed, there's no live transcript while you talk, and errors only show as the menu's first line.
