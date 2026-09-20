# RewardBench 2 content audit

Reviewer: a GPT-5.6 Sol subagent, using lexical screening and contextual model review. This was not human annotation.

RewardBench 2 needs two layers of content handling. Its 450-case Safety subset is intentionally harmful and should always be gated. Outside that subset, 41 cases merit individual notices for material such as self-harm, mass violence, slavery and racial-slur history, explicit adult sexual practices, sexual content involving minors, incest, terrorism, cancer, and severe mental illness. Most non-Safety cases are ordinary factual, mathematical, or instruction-following tasks and do not need a warning.

## Coverage

The source is [allenai/reward-bench-2](https://huggingface.co/datasets/allenai/reward-bench-2) at revision `7ff08853b0d5686e79b13fda8677024f566a104a`. I screened every prompt and every chosen and rejected completion in all 1,415 non-Safety cases. That is 7,177 completions and 10,933,222 characters. I counted the 450 Safety cases and their 1,800 completions but did not reproduce or individually rate them because the product will gate that subset in full.

Broad lexical screening surfaced 481 non-Safety cases. Context review removed many benign matches, including bomb calorimeters, technical uses of "supremacy," titles containing insulting words, and an early expression that accidentally matched "stable diffusion" as violence. The final [audit.json](audit.json) contains exact case IDs, subsets, levels, categories, and concise notes with no raw benchmark excerpts.

## Findings

Three non-Safety cases stand out beyond ordinary sensitive subject matter. Factuality case `44` defines attraction as independent of age and receives an unsafe notice. Focus case `1652` requests examples of very low ages of first sexual intercourse and also receives an unsafe notice. Precise IF case `503` contains scripted familial insults and profanity, so it receives an offensive notice even though the language occurs in fiction.

Focus case `1750` discusses "minor attracted persons," but its chosen answer draws a clear boundary: adult-minor relationships are harmful, and consent and child safety take priority. It therefore receives a sensitive notice rather than an unsafe or offensive label. Historical discussions of slavery, Nazism, atomic bombing, and a racial slur also receive sensitive notices, while their analytical framing is recorded so the UI does not imply endorsement.

The remaining notices cover explicit sexual-health questions, mass murder and suicide, self-harm and acute grief, fictional massacres, incestuous pregnancy, terrorism, cancer, schizophrenia, and child sexual abuse material introduced by a rejected answer. Routine mentions of politics, religion, gender, war, death, or medicine were not gated when the treatment was ordinary and non-graphic.

## Limits

This is a judgment-based audit of one pinned dataset revision. Every non-Safety field was machine-screened, but contextual model review concentrated on high-signal matches, selected broader-topic matches, and every reported case. It was not independent sentence-by-sentence annotation of all 10.9 million characters. The helper [screen.py](screen.py) is intentionally broad and should be treated as a triage tool, not as the source of the final labels.

[NOTES.md](NOTES.md) records counts, decisions, false positives, and review limits.

## Public omissions

A separate narrow review checked all 450 Safety cases for explicit sexual descriptions involving minors and reassessed Factuality `44` and Focus `1652`. Four cases contain fields that should not enter the public payload: Safety `1052`, `1053`, and `1055`, plus Focus `1652`. The [public omission manifest](public-omissions.json) identifies three prompts and six candidates by original side, index, and SHA-256 hash. The app can preserve case positions, supplied labels, model judgments, and scores while replacing those field values with a fixed omission notice.

Factuality `44` does not cross this narrower threshold. It should keep its unsafe reveal gate, but its prompt and candidates do not explicitly describe sexual conduct involving a minor. Refusals, adult-only material, and educational consent-law discussion were also left intact when they did not describe such conduct.
