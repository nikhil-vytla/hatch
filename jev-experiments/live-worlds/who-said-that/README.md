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
   - With one phone per table (a two-channel file), each channel first silences every 10 ms frame where another channel is louder. Detection runs on what is left. A stretch's *balance* is the median frame-by-frame dB lead of its own channel over the other.
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
   - **Bookkeeping, done by code:** the voice prints, levels, phones, topics and counts. A speaker counts at 2 lines, a conversation at 3 and a topic at 2.
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

The weights were set by hand on three **development** windows. These are other stretches of the same meetings (IS1009a 9:20–10:50, ES2002a 5:00–6:30, and a two-table mix of IS1009a 9:20–10:50 with ES2008a 10:00–11:30; `DEV` in `data/build.py`). They are never shown or scored on the page.

The weights were frozen before the three scenarios above were scored. Nothing was trained. **No Jev output was used to set or train anything** (TypeSafe MCA §2.3(b)): Jev's answers are only shown and scored.

## Results

`bun evaluate.ts --json results.json` writes `results.json`, which the page's evidence drawer reads. Each cell is word accuracy, as decided / with hindsight.

| Scenario | Text answers | Counted (truth) | Speaker | Conversation | Topic |
| --- | --- | --- | --- | --- | --- |
| A design meeting | Free | 3 · 2 · 2 (4 · 1 · 3) | 84% / 88% | 88% / 93% | 58% |
| A design meeting | Jev, recorded | 4 · 1 · 2 (4 · 1 · 3) | 84% / 85% | 96% / 100% | 50% |
| The topic changes | Free | 3 · 1 · 1 (3 · 1 · 3) | 95% / 99% | 98% / 100% | 66% |
| The topic changes | Jev, recorded | 3 · 1 · 1 (3 · 1 · 3) | 97% / 99% | 98% / 100% | 66% |
| Two tables | Free | 2 · 2 · 2 (5 · 2 · 4) | 46% / 46% | 83% / 83% | 50% |
| Two tables | Jev, recorded | 2 · 2 · 2 (5 · 2 · 4) | 46% / 46% | 83% / 83% | 50% |

- **Where Jev helps:** in the design meeting the free rules invent a second conversation. Jev's reply and continuation answers keep it as one, and it counts all four speakers.
- **Where Jev doesn't:** on two tables, the voice and the phone level decide nearly everything, so its answers change nothing.
- **Whole-transcript counts:** asked once about a whole transcript, Jev's counts are poor:
  - design meeting: one conversation, 49% against two at 48%
  - topic change: two conversations, though it is one meeting
  - two tables: three or more conversations, and five or more topics

  The page's counts come from code.

## Jev recordings

`record-jev.ts` asks every line's three questions (two for the first line, which has nothing to reply to) and one count request per scenario.
- **Where it writes:** raw rows go to `recordings/jev.jsonl`, and the page's answers go to `public/who-said-that/<id>.jev.json`.
- **Safeguards:** it ran a 10-call pilot first, sends one request at a time, stops after five failures in a row, and has a hard cap of $0.25 at list price.
- **Spend:** all 107 requests succeeded, at **$0.00288** at list price ($0.042 per million input tokens).

## Limits

- whisper-tiny mishears overlapping and far-off speech, and every text answer inherits its mistakes.
- Topics are undercounted: 90 s rarely holds enough lines to tell two related topics apart.
- With two tables:
  - the phone a line was heard on dominates the speaker decision, so each table's speakers merge into one (5 people come out as 2). Voice off changes nothing there. Level off finds 5 speakers (speaker 67%) but mixes up the tables (conversation 69%).
  - A fix that let the phone only rule speakers *out* was tried on the dev windows. Speaker accuracy rose 48→52%, but conversation accuracy fell 80→70%, so it was not kept.
  - when both tables talk at once, the quieter table's words are often lost (64 of 382 words were never heard)
- Speech detection is level-based, so a loud room with no quiet floor will break it.

## Files

| File | What it does |
| --- | --- |
| `signals.ts`, `voice.ts`, `speaker.ts` | step one; `node-models.ts` loads the models in Node |
| `questions.ts` | the text questions, free answers, Jev requests |
| `decide.ts` | decisions, bookkeeping, count odds, hindsight |
| `score.ts`, `evaluate.ts` | scoring against the corpus |
| `transcript.ts`, `cli.ts` | a Markdown transcript from one WAV (mono, or stereo with one channel per table) |
| `record-signals.ts`, `record-jev.ts` | recorders |
| `data/ami.py`, `data/build.py` | AMI parsing and scenario building |
