# Music arranger v2

The replacement plays, draws and exports one eight-bar score. Six procedural phrase families make falling lines, arches, inverted contours, rests and syncopation available alongside ascending phrases. Jev chooses a palette and then four complete phrases using the brief, harmony and selected history. The implementation fixes the old rendering mismatches, but the new recordings still show limited model choice diversity.

## What the recordings show

All 14 authored cases completed: the eight original briefs and six additional explicit contour briefs, with one declared seed per brief. Each arrangement uses one global call and four sequential phrase calls. The 70 completed calls retain their exact input state, candidate events, answer distributions, provider attempts and final score in [music-v2.jsonl](music-v2.jsonl). Existing historical recordings were left intact; this is a new formulation, not a retroactive replacement of the original experiment.

Jev chose an arch for **31 of 32 phrases on the broad original briefs**. One phrase used a breath. The engine supplies six families, but contextual selection alone did not create much variety on these inputs.

| Explicit request | Matching phrases | Planned phrases |
| --- | ---: | ---: |
| Rising | 3 | 4 |
| Falling | 4 | 4 |
| Arch | 4 | 4 |
| Inverted | 3 | 4 |
| Breath and rests | 1 | 4 |
| Syncopated | 2 | 4 |
| Total | 17 | 24 |

These counts describe choices among labeled candidates, not listener preference. Overall, the 56 selected phrases comprise 40 arches, four falling phrases, four breath phrases, three rising phrases, three inverted phrases and two syncopated phrases. No successful choice was rerun because it was repetitive or missed a request.

A separate [option-order probe](option-order.jsonl) repeats one fixed warm-home phrase-two context with original or reversed candidate order and original or neutral candidate IDs. All eight probes chose arch, two repeats per condition. That small matched probe does not support a simple fixed-position or identifier explanation for this context. It cannot establish general order invariance or explain the broader collapse.

## How the score works

[engine.ts](engine.ts) has no audio, network or credential state. It builds six tracks: melody, answer, keys, pad, bass and drums. A score contains absolute beat offsets, note and rest durations, MIDI pitches, velocities, instrument IDs, actual chord voicings, phrase sources and locks. Candidate rhythms occupy exactly eight beats. The full score has 32 beats in 4/4.

Tonic and mode are separate. Major, natural minor and Dorian determine the pitches and chord qualities. Code selects a register-bounded triad inversion with the smallest total movement from the preceding voicing. Chord labels include the actual bass note. Melody contours stay in key; a whole-phrase octave adjustment accounts for the preceding phrase's ending. Harmony is deliberately diatonic, with no unreported borrowed chords.

[The React component](../experience-prototypes/src/music-arranger.tsx) schedules those exact events with an owned Tone clock, renders note position and width from the same score, and passes the same audible event list to MIDI export. The adapter uses the scheduler's audio time for attacks and Tone Draw for the playhead. Tempo, notes, mutes and accepted phrases apply at a bar boundary. Pending edits are labeled; the roll continues to show the score currently playing.

The instrument bank includes flute, bell and reed melody voices; pluck and mallet answers; electric keys and organ; pads and strings; two bass voices; and separately synthesized kick, snare and hi-hat. Envelopes and synthesis types differ. MIDI exports all six named tracks with General MIDI programs and channel 10 percussion. It preserves pitches, timing, duration, velocity and mutes. The receiving MIDI player determines timbre, so MIDI does not preserve the browser's synthesized waveform.

Visitors can select and audition each candidate, request a contour, lock a phrase, change instruments, mute tracks, lower or raise notes by scale step, replace notes with rests, shorten durations and undo edits. A contour request is labeled as a request. Directly choosing the procedural candidate guarantees its shape without pretending that Jev made that choice. The comparison selector loads the recorded Jev choices, a declared rule baseline or a seeded candidate-index baseline. Both baselines share the recorded global key, tempo and instruments, so they compare phrase selection rather than an entirely independent arranger.

The rule baseline follows an explicit requested contour, otherwise arch, falling, syncopated and breath. The seeded baseline selects indices from the same six-candidate generator using a declared integer formula. Neither baseline has listener ratings.

## Async and live behavior

Playback has idle, starting and playing states. A generation token guards both module loading and audio startup. Stop, reset, source changes and unmount invalidate pending startup and dispose the owned clock and synths. No global transport stop is required. Model requests have a separate generation, AbortController and score version. Editing or locking a phrase invalidates an older recommendation.

The browser imports only the pure engine and the existing `src/api.run` route. It never imports recording credentials. Live whole-score arranging performs a global semantic call followed by four dependent phrase calls. Live recommendations preserve the current score until accepted. A missing key gives an actionable message, and provider failure preserves the current score.

Historical model decisions are retained in the exported score, but inference history contains a concise semantic phrase summary rather than recursively embedding earlier request objects. Every candidate's exact melody is included in the request, and the shared five-track accompaniment is stored once. Combining those two lists reconstructs every candidate.

## Validation

The final run passed 15 tests with 14,908 assertions. The Bun suite checks 45 tonic/mode/progression combinations against every candidate family, phrase timing, register bounds, in-key edits, chord inversion cost, locks, deterministic generation and gateway request validation. It performs actual MIDI encode/decode round trips for all six tracks, three tempos and three instrument palettes, within one MIDI tick and one velocity step.

The audio-adapter tests call the real playback adapter with a clock/instrument double. They verify every scheduled pitch, onset, duration, velocity and instrument, then check disposal, stale generations and bar-aligned mute adoption. Evidence tests verify all 14 frozen briefs, one successful result per stage, the exact correspondence between selected candidate events and each published score, and the matched probe's unchanged musical content.

Browser checks covered real Tone startup, four rapid start/stop cycles, bar-queued mute adoption, keyboard pitch edits, rests, locks, candidate audition, both baseline selectors and missing-key behavior. A locally intercepted delayed response was canceled by a phrase lock and produced zero stale recommendations. That test used a dummy value and sent no provider request. Desktop had no horizontal page overflow; at 390 CSS pixels the page width was also 390. Dark theme and reduced motion were inspected, with train transitions disabled under reduced motion. Screenshots live in [output/playwright](output/playwright).

No independent listening evaluation, audio discontinuity measurement or blind scene-fit comparison has been run. These checks establish event consistency and interaction behavior, not musical taste or an improvement in subjective quality.

## Reproduce

Run from the repository root after installing the app's dependencies with Bun:

```sh
bun test jev-experiments/music-arranger-v2
bun jev-experiments/music-arranger-v2/record.ts
bun jev-experiments/music-arranger-v2/option-order.ts
```

The recording commands use the existing authorized local credential loader. They checkpoint each request and keep completed predictions. The first run encountered five upstream HTTP 400 responses on larger repeated-candidate requests; eliminating duplicate accompaniment allowed corrected requests to complete. The provider's error body was not exposed by the gateway, so the exact upstream limit is unknown. Original requests and failures remain in the record.

Provider availability is separate from musical choice. The completed run records 70 HTTP 200 attempts, five HTTP 400 attempts, 26 HTTP 429 attempts, six HTTP 503 attempts and three network attempts. One interrupted in-flight call remains in the checkpoint history. The 120-second logical-call deadline permits the gateway to honor roughly 60-second Retry-After values; only transient failures are retried unchanged. Failed permanent requests are submitted again only when the request content has been corrected.

To repeat the browser checks, open the integrated `#experiment/music` route in an isolated Playwright CLI session, then use `run-code --filename` with [browser-check.js](browser-check.js) and [browser-live-check.js](browser-live-check.js). The latter is a local interception test for the Vite development route and clears its dummy key afterward.

Root integration imports `Music` from `src/music-arranger.tsx`, points the Music catalog entry at `music-v2`, and publishes `../music-arranger-v2/music-v2.jsonl`. No new dependency is needed. The existing [Tone.js](https://tonejs.github.io/) and [Tone MIDI](https://github.com/Tonejs/Midi) packages supply synthesis/scheduling and MIDI serialization.
