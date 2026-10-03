# Screen sentry training and test data

`real.jsonl` holds 2,337 rows fetched by `fetch.ts` on 3 Oct 2026. Each row has its text, whether it's an injection, its source and its split. Every licence below was checked at the source that day. Rows were filtered to 8–600 characters, and nothing else was changed.

| Source | Licence | Rows used | Why it's here |
|---|---|---|---|
| [deepset/prompt-injections](https://huggingface.co/datasets/deepset/prompt-injections) | Apache-2.0 | 536 train, 114 test (252 injections, 398 harmless) | Labelled direct injections, with harmless questions alongside, in English and German. The dataset's own train/test split is kept. |
| [Lakera/gandalf_ignore_instructions](https://huggingface.co/datasets/Lakera/gandalf_ignore_instructions) | MIT | 888 train (sampled down to about 1 in 5 for training), 112 test | Real players' "ignore your instructions" attempts from the Gandalf game. The train and validation splits go to training; the test split is kept. |
| [jackhhao/jailbreak-classification](https://huggingface.co/datasets/jackhhao/jailbreak-classification) | Apache-2.0 | 492 train, 117 test | Jailbreak prompts and harmless prompts. Its "harmless" prompts still instruct an AI ("You are a devoted fan…"), so on a web page they read as instructions. Jev flags many of them, and that's a labelling difference rather than a plain error. |
| [InjecAgent](https://github.com/uiuc-kang-lab/InjecAgent) (`data/attacker_cases_*.jsonl`, `data/user_cases.jsonl`) | MIT | 52 train, 26 test | Indirect injections: attacker instructions planted inside tool output such as product reviews and notes. That's closest to our setting, a request hidden in content a helper reads. The harmless rows are the other string fields of the same tool responses. Split by a fixed hash of the text. |

Considered and not used:

- [BIPIA](https://github.com/microsoft/BIPIA) (MIT). Its attacks are bare tasks ("What is the capital of Brazil?") that count as injections only because of where they're placed. Read alone, they can't be told apart from harmless questions. Its web and summarisation contexts also can't be redistributed.
- [AgentDojo](https://github.com/ethz-spylab/agentdojo) (MIT). Its injections are written as Python task code, not as a text dataset.
- xTRam1/safe-guard-prompt-injection and jayavibhav/prompt-injection, which state no licence.

No row is a Jev answer. TypeSafe's Master Customer Agreement §2.3(b) forbids training on Jev's outputs. Jev's recorded answers in `../recordings/jev.jsonl` are used only to compare with the free sentry and to show on the page.
