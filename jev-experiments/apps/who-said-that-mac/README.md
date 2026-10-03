# Who said that? for the Mac menu bar (prototype tool)

This menu-bar app records a room on your Mac and writes a transcript sorted into conversations and speakers. It runs the same logic as the website's "Who said that?" scene (`jev-experiments/live-worlds/who-said-that/`), through Bun on this Mac:
- whisper-tiny.en, all-MiniLM-L6-v2 and Wespeaker CAM++ for the signals
- the free typed decisions for speaker, conversation and topic

Nothing is uploaded.

## Build

You need macOS 14+, the Xcode command-line tools (`swiftc`) and Bun.

```sh
cd jev-experiments/experience-prototypes && bun install --frozen-lockfile   # once, for the pipeline
../apps/who-said-that-mac/build.sh                                         # → build/WhoSaidThat.app
open ../apps/who-said-that-mac/build/WhoSaidThat.app
```

`build.sh` does three things:
1. compiles `Sources/main.swift`
2. writes this checkout's path and your Bun path into the app's `Info.plist`
3. ad-hoc signs the app, so it only runs on the Mac that built it

## Use

1. Click the two-people icon in the menu bar, then **Start listening**. The menu counts the time.
2. **Stop and write the transcript**. This runs `bun live-worlds/who-said-that/cli.ts room.wav --out …`.
3. The transcript opens from `~/Documents/Who said that/`. The recording is in `~/Library/Application Support/WhoSaidThat/room.wav`.

The first run asks for microphone access and downloads the models, about 93 MB.

## Status (2 Oct 2026)

- **Built:** the app built with Swift 6.3 on macOS 26.6.
- **The command it runs:** run on the "Two tables" scenario WAV, it wrote a two-conversation transcript in 10.5 s on an M4 Max.
- **Not tested:** the microphone recording path. It needs a person to grant microphone access and speak.
- **Prototype limits:**
  - one microphone, so only the loudness signal tells tables apart, which is weak
  - no live transcript while you talk
  - errors only show as the menu's first line
  - the free lane only; Jev is not called
