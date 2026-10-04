# Who said that?

This scene sorts real meeting audio into speakers, conversations and topics using typed decisions you can inspect. It is live at `#experiment/who-said-that` (page: `experience-prototypes/src/who-said-that.tsx`). The same logic also runs as a command-line tool and as a prototype Mac menu-bar app (`apps/who-said-that-mac/`).

## How it works

1. **Signals** (`signals.ts`, run by `record-signals.ts` in Node or `who-said-that.worker.ts` in the browser):
   - Speech is where the level is 6 dB above the recording's 20th-percentile floor. It is cut into stretches of up to 5 s, at their quietest point.
   - For each stretch we take:
     - the words, from whisper-tiny.en
     - a voice print, from Wespeaker CAM++
     - a meaning vector, from all-MiniLM-L6-v2
     - its loudness
   - With one phone per table (a two-channel file), each channel first silences every 10 ms frame that the other table's leak and the room's noise explain. A frame stays when its phone is more than 3 dB louder than it would be from the other phone's level plus the leak, added to its own noise floor (its 5th-percentile frame). The leak, how much quieter the other table arrives, is measured from the recording itself (about −12 dB here) and taken to be the same both ways. Every frame left is this table's speech, including speech under louder talk at the other table, and detection only joins and cuts those frames. A stretch's *balance* is the median frame-by-frame dB lead of its own channel over the other, and it is negative for those stretches.
2. **Three text questions per line** (`questions.ts`). None of them depends on how anything has been grouped, so a recorded answer stays valid whatever the visitor toggles:
   - `continues` (yes/no)
   - `replyTo` (a choice over the last six lines, or none)
   - `newTopic` (yes/no)

   The free lane answers them with word cues, timing and MiniLM similarity. The Jev lane asks Jev, which sees only the words.
3. **Three typed decisions per line** (`decide.ts`):
   - which speaker: an existing one, or someone new
   - which conversation: an existing one, or a new one
   - a new topic or not

   Each option's score is a sum of named signal pushes (voice, level/phone, continues, timing, topic, reply, membership, shift), then a softmax. The page shows each push and lets the visitor switch signals off.
   - **Bookkeeping, done by code:** the voice prints, levels, phones, topics and counts. A speaker counts at 2 lines, a conversation at 3 and a topic at 2. A line counts towards where its speaker or conversation sits in proportion to how clearly it is on its phone.
   - **The phone, with two tables:** it can rule a speaker out (they sit at the other table) but never in, because everyone at a table is on its phone. It decides the conversation, and "where this speaker talks" (membership) is only used with one microphone, once the speaker has spoken.
   - **Count odds:** re-run the decisions 60 times, sampling each choice.
   - **Hindsight:** re-labels earlier lines against the final voice prints and conversation topics.
4. **Scoring** (`score.ts`) is per word, against AMI's human transcript:
   - Each word goes to the segment that covers most of it. With two tables, only segments on the word's own table's phone count.
   - Predicted labels are matched one-to-one to true labels by shared words, largest first.
   - Words never heard as speech count as wrong.

## Data

The audio comes from the **[AMI Meeting Corpus](https://groups.inf.ed.ac.uk/ami/corpus/)**: Carletta et al., University of Edinburgh and the AMI consortium, under **[CC BY 4.0](https://groups.inf.ed.ac.uk/ami/corpus/license.shtml)**. Words, speakers and topic segments come from `ami_public_manual_1.6.2`. The audio is the Mix-Headset stream.

`data/build.py` cuts 90 s windows, loudness-normalises them (EBU R128, −23 LUFS), mixes them and encodes them as MP3. We changed nothing else.

| Scenario | Source | Truth |
| --- | --- | --- |
| A design meeting | IS1009a 6:20–7:50 | 4 speakers, 1 conversation, 3 topics, 202 words |
| The topic changes | ES2008a 8:00–9:30 | 3 speakers, 1 conversation, 3 topics, 237 words |
| Two tables | ES2002a 8:00–9:30 (Table 1) + IS1009a 3:50–5:20 (Table 2) | 5 speakers, 2 conversations, 4 topics, 382 words |

"Two tables" is a stereo file with one phone per table. Each channel is its own table at 0 dB plus the other table at −12 dB, the bleed a phone picks up from the next table. It is our mix of two real meetings, so the overlap between the tables is real speech but staged.

The AMI downloads (about 190 MB) are not committed. To rebuild:

```sh
AMI_DIR=<dir with manual/ and audio/> python3 data/build.py ../../experience-prototypes/public/who-said-that <scratch>
bun record-signals.ts <scratch> ../../experience-prototypes/public/who-said-that
```

## Models

| Model | Licence |
| --- | --- |
| whisper-tiny.en (Xenova ONNX) | MIT |
| all-MiniLM-L6-v2 (Xenova ONNX) | Apache-2.0 |
| Wespeaker CAM++ VoxCeleb | Apache-2.0 |

All of them run on the device, in the browser or in Node. **pyannote** is not used:
- `speaker-diarization-3.1` is MIT and `speaker-diarization-community-1` is CC BY 4.0.
- Both models' weights are **gated** on Hugging Face (`gated: auto`): you need an account and must accept the conditions. That doesn't suit an anonymous in-browser demo.

## Development and test windows

The weights were set by hand on **development** windows. These are other stretches of the same meetings, never shown or scored on the page (`DEV` in `data/build.py`):
- the first three: IS1009a 9:20–10:50, ES2002a 5:00–6:30, and a two-table mix of IS1009a 9:20–10:50 with ES2008a 10:00–11:30
- four added for the accuracy work, three of them with topic changes: ES2008a 10:40–12:10, ES2002a 11:50–13:20, IS1009a 8:10–9:40, and a second two-table mix of ES2002a 11:50–13:20 with IS1009a 1:40–3:10

`AMI_DIR=… python3 data/build.py --dev <scratch>` writes them. `bun record-signals.ts <scratch> <dir>` records their signals; copy the truth files from `<scratch>` into `<dir>`, then `bun evaluate.ts <dir>` scores them.

The weights were frozen before the three scenarios above were scored. Nothing was trained. **No Jev output was used to set or train anything** (TypeSafe MCA §2.3(b)): Jev's answers are only shown and scored.

## Results

`bun evaluate.ts --json results.json` writes `results.json`, which the page's evidence drawer reads. Each cell is word accuracy, as decided / with hindsight.

| Scenario | Text answers | Counted (truth) | Speaker | Conversation | Topic |
| --- | --- | --- | --- | --- | --- |
| A design meeting | Free | 3 · 1 · 1 (4 · 1 · 3) | 84% / 88% | 100% / 100% | 54% |
| A design meeting | Jev, recorded | 4 · 1 · 1 (4 · 1 · 3) | 84% / 85% | 100% / 100% | 54% |
| The topic changes | Free | 3 · 1 · 1 (3 · 1 · 3) | 95% / 99% | 99% / 100% | 67% |
| The topic changes | Jev, recorded | 3 · 1 · 1 (3 · 1 · 3) | 97% / 99% | 98% / 100% | 66% |
| Two tables | Free | 4 · 2 · 2 (5 · 2 · 4) | 77% / 79% | 97% / 97% | 63% |
| Two tables | Jev, recorded | 5 · 2 · 2 (5 · 2 · 4) | 77% / 77% | 95% / 97% | 60% |

Before the accuracy work, the same cells were:

| Scenario | Text answers | Counted | Speaker | Conversation | Topic | Words never heard |
| --- | --- | --- | --- | --- | --- | --- |
| A design meeting | Free | 3 · 2 · 2 | 84% / 88% | 88% / 93% | 58% | 0 of 202 |
| A design meeting | Jev | 4 · 1 · 2 | 84% / 85% | 96% / 100% | 50% | 0 of 202 |
| The topic changes | Free | 3 · 1 · 1 | 95% / 99% | 98% / 100% | 66% | 1 of 237 |
| The topic changes | Jev | 3 · 1 · 1 | 97% / 99% | 98% / 100% | 66% | 1 of 237 |
| Two tables | Free and Jev | 2 · 2 · 2 | 46% / 46% | 83% / 83% | 50% | 64 of 382 (now 10) |

- **Free-lane topic in the design meeting, 58→54%:** this is the one cell that fell. The old 58% came from a wrong second conversation whose split happened to fall at a topic change. With one conversation and one topic found, 54% is the share of the largest topic.
- **Where Jev helps:** in the design meeting it counts all four speakers (the free rules find three). The free rules no longer invent a second conversation, so on conversations the lanes now agree.
- **Where Jev doesn't:** on two tables, the voice and the phone decide nearly everything, so its answers change little. Switching voice off drops speaker accuracy from 77% to 45%; switching the phone off drops conversation accuracy from 97% to 60%.
- **Whole-transcript counts:** asked once about a whole transcript, Jev's counts are poor:
  - design meeting: one conversation, 49% against two at 48%
  - topic change: two conversations, though it is one meeting
  - two tables: three or more conversations (44% against two at 31%, re-asked for the re-recorded lines), and five or more topics

  The page's counts come from code.

## Jev recordings

`record-jev.ts` asks every line's three questions (two for the first line, which has nothing to reply to) and one count request per scenario.
- **Where it writes:** raw rows go to `recordings/jev.jsonl`, and the page's answers go to `public/who-said-that/<id>.jev.json`.
- **Safeguards:** it ran a 10-call pilot first, sends one request at a time, stops after five failures in a row, and has a hard cap of $0.25 at list price. `--cap <usd>` caps a single run as well. A line is only asked again when its request has changed.
- **Spend:** the first recording was 107 requests at **$0.00288** at list price ($0.042 per million input tokens). Re-recording the two-tables signals changed its lines, so they were asked again; the questions are unchanged. This happened twice, once per mask version (below), each run with `--cap 0.1`: 52 requests at $0.00145, then 41 at $0.00116. That makes 200 requests and **$0.00549** in all, and every request succeeded.

## Limits

- whisper-tiny mishears overlapping and far-off speech, and every text answer inherits its mistakes.
- **Topics are undercounted, and the limit is the meaning signal, not the decision.** On the dev windows only about 70% of lines are closer to their own topic's centre than to another topic's, even with the true topics given (median cosine margin 0.05). A TextTiling pass did no better than the current rule (see below).
- **Several speakers inside one segment:** a stretch of up to 5 s often holds two or three speakers in fast talk. Even labelling every segment with its true majority speaker would get only 71–94% of a mono dev window's words right.
- **With two tables:**
  - The leak is measured as one level for the room, and here it really is one level: the scenario mixes the other table in at a fixed −12 dB. A real room's leak varies with where people sit and with reverberation, so expect more lost or stray words there.
  - Stretches heard under louder talk at the other table are transcribed with its words mixed in, which hurts their text answers and voice prints.
- Speech detection is level-based, so a loud room with no quiet floor will break it.
- **Overlapped speech within one table is not detected.** The one suitable model found is pyannote's segmentation-3.0 (MIT). It is gated, though [`onnx-community/pyannote-segmentation-3.0`](https://huggingface.co/onnx-community/pyannote-segmentation-3.0) re-publishes it ungated as ONNX. We left it out, because using it would sidestep the gate on [the original](https://huggingface.co/pyannote/segmentation-3.0).

## Accuracy work: what was tried

The work was tuned on the seven development windows only and frozen before the scored windows were scored. Development numbers are online word accuracy. "Two-table dev" gives the first stereo window, then the second.

**Kept:**

| Change | Two-table dev | Mono dev windows |
| --- | --- | --- |
| Keep a phone's frames when it is more than 3 dB over the other table's measured leak, not only when it is the louder phone | words never heard 129 → 12 and 40 → 0. Speaker 47 → 63% and 71 → 82%, conversation 78 → 92% and 89 → 99% | unchanged (stereo only) |
| The phone rules speakers out, never in | speaker 63 → 65% and 82 → 92%, all 8 speakers counted on the first | unchanged |
| Membership only once a speaker has spoken (a newcomer counted against every conversation) | needs the next two | conversation 82 → 100% and 70 → 100% on two topic-change windows, 93 → 98% on another |
| A line counts towards where its group sits by how clearly it is on its phone | conversation 92 → 96% | unchanged |
| With two tables, the phone decides the conversation (no membership) | keeps rule-out from breaking conversation (62 → 97%) | unchanged |

All together, the two-table dev windows reached speaker 65% and 92%, and conversation 97% and 99%. That set was frozen, and the scored windows were scored once with it: two tables reached speaker 67% / 68%, conversation 98% / 98%, with 8 words never heard.

**A fix after the freeze.** A unit test with silence in it then failed: the first mask kept room silence, because both phones' noise is equally loud, so it isn't leak. On the recordings, whisper's blank answers had been hiding this. The fix:
- the mask also allows for each phone's own noise floor
- the leak is one estimate, used both ways
- every kept frame counts as speech, since a busy table's masked copy otherwise sets its quiet floor at its own talk level

It was checked on the dev windows before re-scoring. Words never heard went 12 → 1 and 0 → 2, online speaker accuracy 65 → 71% and 92 → 89%, and conversation stayed at 97% and 99%. The scored numbers above are with the fix. Its two-tables lines changed again, so Jev was asked again.

**Rejected:**
- **Normalising voice prints per phone** (subtracting each channel's mean): same-speaker similarity fell to a median of 0.02.
- **Speaker rule-out with membership still on** (the change rejected before): with the new mask, conversation accuracy was 62–71% on the first two-table dev window.
- **Membership needing history, with two tables, without the clarity weighting:** conversation accuracy on the first two-table dev window fell from 92% to 68%.
- **A 1.5 or 5 dB leak margin instead of 3 dB:** averaged over the two two-table dev windows, speaker accuracy was 73% and 77% against 78%, and conversation accuracy 96% and 98% against 98%.
- **TextTiling over MiniLM meanings, in hindsight:** the mean meaning of the lines before and after each gap was compared, with block sizes of 3–6 lines and both relative (mean − c·sd) and absolute cut-offs. It reached 92–93% on two topic-change windows but split single-topic ones (100 → 70%). No setting beat no tiling on the mean over the seven windows (73%).
- **Agglomerative re-clustering of voice prints in hindsight** (average linkage, never across phones, a tuned stopping similarity): the best stop, 0.3, raised the dev mean from 80% to 82%. But a stop of 0.25 dropped one window from 94% to 54%, and two other windows lost 3 points each.
- **Silero VAD:** not tried, because the losses were not in detection. Of the 129 words never heard on the first two-table dev window:
  - the level detector missed only 5
  - 75 were under louder talk at the other table
  - 36 were dropped by the old balance filter
  - 13 were in stretches whisper returned as blank
- **Taking the quiet floor from the frames the mask keeps** (a first try at the fix above): a table that talks more than 80% of the time then gets its own talk level as its floor, and its speech is lost.

## Files

| File | What it does |
| --- | --- |
| `signals.ts`, `voice.ts`, `speaker.ts` | step one; `node-models.ts` loads the models in Node |
| `questions.ts` | the text questions, free answers, Jev requests |
| `decide.ts` | decisions, bookkeeping, count odds, hindsight |
| `score.ts`, `evaluate.ts` | scoring against the corpus (`evaluate.ts <dir>` scores any folder, the dev windows included) |
| `transcript.ts`, `cli.ts` | a Markdown transcript from one WAV (mono, or stereo with one channel per table) |
| `record-signals.ts`, `record-jev.ts` | recorders |
| `data/ami.py`, `data/build.py` | AMI parsing and scenario building |
