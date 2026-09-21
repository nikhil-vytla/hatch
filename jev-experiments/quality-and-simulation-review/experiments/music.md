# Music arranger

The user's suspicion is supported by every completed recording. All five motifs rise or repeat until the last note drops back to the tonic. The larger problem is that the player discards most of the recorded musical decisions. This experiment needs a redesign around a shared score and phrase selection before its sound can tell us much about Jev's arranging ability.

## What exists

The catalog calls this **Music arranger** and asks whether typed musical decisions can form a coherent arrangement. See `experience-prototypes/src/catalog.ts:70`.

The recording runner sends the brief as shared state, then asks for a scale, tempo, waveform, eight scale degrees and eight durations. It makes one call with 19 independent questions. Code maps the answers to eight MIDI notes rooted on C. The runner does not pass a previous note, chosen chord, selected scale or phrase history into the note questions. See `src/jev_lab/compositions.py:364`.

The visitor chooses a recorded motif, listens to four synthesized parts, changes tempo, mutes parts, clicks a note to raise it, and exports JSON or MIDI. Live Jev controls only three choices: warm/suspended/dark harmony, gentle/driving percussion density and ABAB/AABA form. It cannot create a new motif or choose an instrument through this page. See `experience-prototypes/src/creative.tsx:433` and `:668`.

The actual publication source is `results/music.jsonl`, selected in `experience-prototypes/publication.json:20`. It contains eight authored briefs, five completed recordings and three HTTP 429 failures. These are authored demonstrations, not an external benchmark. The successful rows retain all 19 answers and their distributions. `human_preference` is null.

## What already works

- Playback waits for a click and `Tone.start()`. The Tone loop uses its scheduled audio time rather than a JavaScript timer. That is the right basis for stable musical playback. See `creative.tsx:471` and `:498`.
- Melody, harmony, bass and rhythm are separate synths with independently controlled mutes. Visitors can hear the role of each part. See `creative.tsx:478` and `:595`.
- The page explicitly says the recorded melody is from Jev and the arrangement is procedural. Raw answers and the local score remain inspectable. See `creative.tsx:623` and `:803`.
- A successful recording remains available when the provider fails elsewhere. The UI removes unavailable rows from the motif selector, and preparation counts completed versus unavailable records. See `creative.tsx:434` and `scripts/prepare.ts:45`. This avoids playing transport failures as if they were musical outputs, though the coverage still needs a visible note.
- The existing Tone.js and MIDI dependencies are sufficient for the next version. A new audio framework is unnecessary.

## Findings

### P1: The question structure encourages a scale exercise

`compositions.py:374` asks for the role of "note 2" while offering "second", asks about "note 3" while offering "third", and so on. TypeSafe documents that questions run independently against the shared state, so none of these note decisions sees the decisions for neighboring notes. This is a poor representation of a coherent melody. [TypeSafe introduction](https://docs.typesafe.ai/introduction)

Measured over every successful record, 4/5 motifs are exactly `tonic, second, third, fourth, fifth, sixth, seventh, tonic`. The remaining motif replaces degree six with degree seven. Of 35 adjacent intervals, 29 rise, one repeats and five fall. All five falls are the final tonic reset, by 10 or 11 semitones. No motif descends before its final note. See `results/music.jsonl:2`, `:3`, `:4`, `:5`, `:9`, and the reproducible calculation in `../probes/music.ts`.

The label/ordinal correspondence is a plausible explanation, not a proven causal finding. It must be tested with changed wording and candidate order. The observed collapse itself is unambiguous.

**Correction:** choose complete, coherent two-bar phrase candidates that code generates with varied contours, rests and rhythmic cells. Give Jev the previous phrase, current chord progression, desired narrative and candidate note sequences. Ask which phrase fits the requested change. Retain an ablation with neutral note identifiers and relative-motion options to isolate ordinal naming from lack of musical context. A seeded probability sample alone will diversify notes without solving phrasing.

### P1: Playback erases durations and instrument decisions

The runner records note durations of 0.5, 1 or 2 beats and chooses sine, triangle or soft square. Playback always triggers the melody for an eighth note on an eighth-note grid and always uses a triangle oscillator. See `creative.tsx:478`, `:511` and `:545`.

31/40 recorded note durations differ from the rendered half-beat duration. The five original motifs total 16, 7.5, 9, 4 and 8 beats respectively, yet each becomes a four-beat loop. Three recordings select sine, but all use triangle. The tempo survives; most rhythm and timbre choices do not. This prevents a listener from judging the choices Jev actually made.

**Correction:** compile one explicit score with absolute beat offsets, durations, pitches, velocities, instrument IDs, rests and automation. Both playback and export must consume it. If a phrase has to fit two bars, constrain candidate rhythms to exactly eight beats before asking Jev. Never silently time-compress independently predicted durations.

### P1: Form and harmony are disconnected from the motif

ABAB means adding two chromatic semitones to the melody in the second and fourth bars. AABA does the same in the third bar. Harmony always follows C–F–G–C roots. Warm makes every chord major, suspended makes every chord sus4, and dark makes every chord minor. There is no key-aware progression selection or voice leading. See `creative.tsx:499` and `:515`.

Under the shipped default ABAB/warm settings, 20/160 rendered melody events fall outside the scale selected in their recordings. Both minor recordings receive C/F/G major chords. These are not automatically bad artistic choices, but the code introduces them without selecting or explaining chromaticism. Form amounts to fixed transposition rather than repetition, contrast and return. The pentatonic pitch map also names its sixth and seventh positions like heptatonic scale degrees while actually returning the next octave's tonic and second. See `compositions.py:391`.

**Correction:** represent tonic and mode separately; build chord candidates as scale-aware functions, with explicitly allowed borrowed chords. Let Jev choose harmonic direction and phrase transformation from coherent alternatives. Code computes chord inversions and register-aware voice leading, then fits or regenerates a melody against the chosen harmony. Show the actual chord names, inversions and any intentional non-scale notes. A B section can invert a contour, change rhythm, exchange instruments or answer the A phrase without transposing blindly.

### P2: The piano roll and export describe a different performance

The piano roll draws `notes[i % notes.length].midi`, ignoring the B-section transposition. Under default ABAB, 80/160 displayed note pitches differ from their scheduled pitches. Every note has the same displayed width. Click editing only raises pitch by one semitone; it cannot lower a note, insert a rest, change duration or preserve the key. See `creative.tsx:569`.

MIDI generation separately reimplements the arrangement. Audio uses 0.5-beat melody durations and 2-beat bass/chord durations; MIDI uses 0.45 and 1.8 beats. Percussion durations also differ. The JSON score preserves original durations that neither renderer follows. See `creative.tsx:707`, `:734`, `:747`, `:756` and `:784`.

**Correction:** use the same compiled event list for the piano roll, playback, MIDI and JSON. Draw note width from duration and track rows from instrument. Support keyboard-accessible pitch up/down, duration, rest, undo and phrase lock controls. Label deliberate articulation separately from rhythmic duration, and export that articulation consistently. A MIDI round trip should match the event list to one tick.

### P2: There is no musical quality evidence yet

Five one-off authored motifs and `human_preference: null` cannot answer the catalog's question about coherence. There is no random or rule-based comparator, blind listening, motif diversity measure, prompt-following test or renderer parity test. The package's test command includes server and arcade tests, with no music tests. Three authored cases failed only because the provider was busy. The recovery runner's name list excludes music. See `results/music.jsonl:1`, `:6`, `:7`, `:8`; `scripts/recover.ts:13`; `experience-prototypes/package.json:10`.

**Correction:** recover the three original briefs without replacing any completed prediction. Publish an eight-case coverage manifest and a separate provider-availability history. Then run the protocol below. Do not call deterministic harmony checks musical preference, or use Jev's own confidence as proof that a phrase sounds good.

### P2: Async audio startup can outlive the visitor's action

`play()` awaits module loading and audio startup before installing `engine.current` or setting `playing`. During that period repeated clicks, changing the motif or navigating away can leave a late startup with stale notes. Cleanup only stops the engine that exists when cleanup runs. The Play button is not disabled while starting. See `creative.tsx:464`, `:470`, `:476`, `:547` and `:616`. This is a code-path risk, not a reproduced browser failure in this audit.

**Correction:** give playback explicit idle/starting/playing/stopping states and a generation token. After each await, discard stale starts. Stop must invalidate pending startup, release voices, cancel visual callbacks and dispose the owned scheduler. A live arrangement response should also carry the score version it was requested against, so an old response cannot overwrite an edited phrase. Verify with rapid play/stop, record-switch and navigation tests.

## A richer interaction: score a tiny film

A visitor sees an eight-bar miniature film with four two-bar scenes: an empty station, a distant light, a train approaching and someone coming home. Below it is a six-track arrangement with melody, countermelody, keys, pad, bass and drums. The starter score plays immediately after a click without a key. Each scene has a direction field, a tension slider and a lock button.

1. The visitor listens to the original and clicks the second scene. They write, "Less triumphant; make the answer fall and leave a breath before the train arrives."
2. The next-bar preview shows three playable alternatives. Each displays its contour, rhythm, chord symbols and instrument changes. The user can audition them while the current arrangement continues. The same loudness and instrument bank apply to all candidates.
3. Jev recommends one candidate from the full candidate pool, with its distribution visible. The visitor can accept it, choose another or lock the existing phrase. The timeline distinguishes the user's choice, Jev's choice and a deterministic fallback.
4. The new two-bar phrase enters at a bar boundary. A moving playhead, lit instrument rows and the film scene stay synchronized. The transition preserves the final note or rest from the preceding phrase and uses a valid next chord voicing.
5. The visitor mutes the bass, lowers a note with the keyboard, changes a held note into a rest, and exports exactly what they heard as MIDI plus a score JSON with provenance.

### State and actions

State contains `scoreVersion`, key/mode, tempo/meter, scene briefs, per-phrase tension, the previous phrase's events, chord progression, instrument registers, user locks, candidate IDs and candidate events. Every event has track, beat, duration, MIDI pitch, velocity and articulation. Rest spans are explicit. Decisions identify the model and source request; deterministic repairs are logged separately.

The first Jev call selects global semantic choices such as tempo range, tonal palette and instrumentation family. Code produces compatible progressions and phrase candidates. Four subsequent calls choose one candidate for each two-bar phrase, conditioned on the already selected history. Candidate options carry actual events and concise musical descriptions. Compatible independent preferences can share a call; dependent phrases cannot assume they see one another's unanswered questions.

Code controls exact timing, candidate validity, harmonic spelling, voice-leading cost, register bounds, note length, velocity smoothing, event scheduling and export. Jev chooses which musically valid alternative expresses the direction. It does not hear the audio, synthesize waveforms or prove musical quality. The candidate generator is a substantial contributor and must appear as its own baseline.

On provider overload, the current score keeps playing. The UI says the requested variation is pending, retries the same request in the background, and never marks a procedural fallback as a Jev result. If a response arrives after the phrase or brief changed, retain it in history but do not apply it. Invalid or unavailable candidates leave the score unchanged. Missing samples fall back to a named local synth with a visible badge. All sound stops after Stop, including queued work.

### Acceptance criteria

- All six tracks derive from one score; scheduled audio, piano roll and exported MIDI have the same note pitches, start times and durations within one MIDI tick.
- The library contains at least ascending, descending, arch, valley, repeated-tone and alternating contours, plus rests and syncopated rhythms. Every contour is selectable and audible. Diversity alone is not scored as quality.
- An eight-bar score is exactly 32 beats at 4/4. Each two-bar phrase spans eight beats, including rests. No note exceeds its instrument's configured range, and locked user material remains byte-identical.
- Chord labels describe the sounded notes and inversions. Non-scale notes are either allowed by the selected harmonic plan or rejected before playback. Voice leading is computed between actual previous and next voicings.
- Natural-language changes can affect contour, rhythmic density, chord tension, instrument entry and phrasing independently. A controlled counterfactual changes only its intended dimension unless the UI describes the dependency.
- Changes enter at the next bar boundary without restarting the transport. Rapid play/stop and navigation cannot create an orphaned sound. The audio engine makes no network calls inside its scheduling callback.
- Keyboard users can audition, accept, reject, mute, edit pitch in both directions and insert a rest. Reduced-motion mode retains clear beat and track state.
- At least one complete recorded Jev session is replayable without a key, with every candidate, choice and deterministic transformation visible.

## Evaluation protocol

### Current coverage and feasible completion

There is no external musical benchmark in this experiment. The complete existing authored set has eight briefs; five completed and three have provider 429 errors. Completing it requires three logical requests of 19 questions each, with transient retries counted separately. This is feasible with the current runner once music is added to recovery. Retain all five existing choices, including the collapsed motifs.

For a stronger study, freeze 48 authored briefs covering six requested contours, four emotional trajectories and two phrase contexts. Use four generator seeds per brief, giving 192 scenario/seed pairs for each new candidate-based method. Include explicit descending, questioning, repeated-note, sparse and cadence directions. Hold out the exact wording and film scenes used in the shipped showcase from development.

### Comparators and request volume

Compare the original independent-note formulation, a rule-based arranger using the same candidate pool, uniform random candidate selection and Jev candidate selection. All use the same event compiler, instrument bank, loudness, tempo policy and rendering. The rule-based baseline uses a declared brief-to-contour/tension mapping and nearest voice-leading cost. Publish that mapping before looking at results.

The new system uses five logical calls per complete arrangement, one global call and four dependent phrase calls. That is 960 calls for 192 Jev arrangements. The original formulation needs 48 calls because it has no meaningful generator seed; do not treat duplicate renders as independent samples. Add 96 calls to repeat a frozen set of 48 final-phrase choices under two option reorderings. Total planned study volume is 1,104 calls, plus the three original recoveries and transport retries. Actual request and question counts belong in the published manifest.

### Independent outcomes

- **Correctness of the implementation:** full event parity, fixed bar lengths, instrument range, lock preservation, all finite event times and zero unresolved startup/stop leaks. Test all generated scores, not a sample.
- **Prompt following:** exact contour/rhythm/instrument constraints where the brief makes them explicit. Report per-condition results over all 192 cases. Use independently specified rules for objective requests and blind human ratings for subjective fit.
- **Musical preference:** compare Jev with the stronger of the rule and random baselines, selected using a separate development set. Use 48 held-out briefs and two preregistered seeds, 96 blind A/B comparisons, five independent ratings per comparison, 480 judgments. Randomize order and hide the method. Ask which better fits the scene, which has the better phrase shape, and whether either contains a distracting transition. Allow ties. Report the denominator, individual questions and disagreement.
- **Primary proposed success measure:** scene-fit preference above 50%, counting ties as half, with a 95% confidence interval clustered by brief whose lower bound exceeds 50%. A pilot may be inconclusive; do not call a broad interval a win. Report listener and brief resampling sensitivity. Do not inflate the sample by counting repeated notes as separate opinions.
- **Diversity and bias diagnostics:** unique relative-interval/rhythm patterns, upward/downward/repeated step proportions, largest terminal leap, contour request compliance and option-order agreement. These explain behavior but cannot establish that a piece is enjoyable.
- **Interaction behavior:** record the edit-to-accepted-score latency, fraction accepted at the next available bar, provider wait time, retry count, staleness rejections and any audio discontinuity. Keep network availability separate from music preference.

Confounds include candidate quality, hand-authored descriptions that advertise the desired answer, instrument timbre, loudness, code-enforced harmonic rules and development prompts that overlap the evaluation. To test the ordinal-wording suspicion, add a small predeclared ablation of the existing eight briefs with neutral note identifiers, relative-motion candidates and rotated option orders. Compare contours, not self-reported confidence. No listener results or ablation outcomes exist yet.

## Libraries worth using

| Library | What it contributes | Where Jev adds something |
|---|---|---|
| [Tone.js](https://tonejs.github.io/) | Keep the existing transport and synthesis. Use scheduled parts from the compiled score, a small named instrument bank, buses and shared effects. Optional licensed samples can use `Sampler`. | Select phrase character and instrument entries from a narrative. The audio engine remains deterministic. |
| [Tonal](https://github.com/tonaljs/tonal) | Use note, chord, key, progression, voicing and voice-leading modules for key-aware candidates and register-aware transitions. Import only the modules needed. | Choose among valid harmonic/phrase alternatives using context and user direction. Tonal should not be asked to infer intent. |
| [@tonejs/midi](https://github.com/Tonejs/Midi) | Keep the existing MIDI reader/writer and build both export and a MIDI-import starter-motif path from the event list. Round-trip test durations, programs and velocities. | Arrange a visitor's own motif and explain which bounded structural decisions changed. |

These capabilities were verified in the primary documentation. No library or sample bank was installed during this audit.

## Prioritized work

1. **P1, M:** extract the canonical score/event compiler, honor duration/instrument choices, and derive audio, piano roll and MIDI from it. This fixes several current errors before changing model behavior.
2. **P1, L:** replace ordinal note questions with contextual phrase candidates, key-aware harmony, voice leading and editable six-track arrangements. Keep the original generator as a named baseline.
3. **P1, M:** add score-version guards, quantized edit application, startup cancellation and repeatable audio lifecycle checks.
4. **P2, S:** recover the three provider failures, publish complete coverage and show the distinction between recorded motif selection and live arrangement choices.
5. **P2, M:** freeze and run the 48-brief protocol; collect blind listening data before making a quality claim.
6. **P2, M:** connect the same conductor to Snake or Orbital rescue. Game state can request "tension rising", "safe landing" or "victory" while code schedules the transition at musical boundaries. Compare the context choices against a fixed game-event soundtrack table. This reuses the score, renderer, candidate pool and evaluation rather than adding another unrelated demo.

## Investigation log

- Read the current catalog, `Music` React component, original runner, published JSONL, publication manifest, preparation/recovery scripts and package test command.
- Read all eight raw records and all five complete note sequences. No large dataset download or model call was needed.
- Wrote and ran `bun jev-experiments/quality-and-simulation-review/probes/music.ts`. The result is `../probes/music.probe.json`; it reproduces contour counts, duration overrides, the default key mismatch and piano-roll mismatch.
- Verified TypeSafe question independence, Tone scheduling/synthesis, Tonal musical primitives and MIDI event support through primary sources linked above.
- Direct web opens of Tonal's package subdirectories failed; the official root README documents the relevant modules. A guessed local `src/data.ts` path did not exist; the actual loader is `src/main.tsx:47`. The papercut CLI declined to log because the repository has not opted in; no global log was created.
- This was a code/data audit. I did not run a browser, listen to the arrangements, conduct a preference study or change production code.
