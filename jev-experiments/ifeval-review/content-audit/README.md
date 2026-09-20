# Public content audit

The public Jev Lab snapshot contains no hate speech, slurs, profanity, explicit sexual material, or graphic violence. One generated IFEval reference is plainly offensive because it sustains a personal attack, and one IFEval row is unsafe because all four candidates endorse misleading maintenance advice for a bicycle chain. Candidate 3 compounds the problem by recommending bleach and a hot iron. Several external benchmark rows contain sensitive academic material, including slavery, colonial dehumanization, murder, abortion, sexual behavior, human sacrifice, drugs, and a real bombing.

## Scope

I decoded all 33 datasets in `experience-prototypes/publication.json`: 37,630 string fields and 1,925,540 characters. The focused review covered all 60 language prompts, 240 candidates, and 60 references; all 200 JudgeBench questions and their 400 A/B answers; and all 785 classification rows. Every other published record was included in the full string inventory and broad topic screening, followed by contextual review of matches and row-level prose.

JudgeBench contains candidate-order variants. Its 200 displayed rows represent 98 unique question texts, so the audit groups paired variants and preserves both row IDs. The machine-readable [audit.json](audit.json) lists exact stable paths, fields, severity, categories, and short explanations without reproducing long benchmark excerpts.

## Findings

The audit records 10 grouped cases: eight sensitive, one offensive, and one unsafe.

- `language` row `ifeval/1858`: the reference answer uses repeated second-person insults and demeaning claims about the recipient's intelligence. This crosses from requested anger into harassment.
- `language` row `ifeval/1834`: all four candidates confidently present inaccurate chain-cleaning claims. Candidate 3 recommends diluted bleach and direct heat from a hot iron. Bad advice on a bicycle drivetrain can damage a safety-critical part or injure the person following it.
- `judge` rows 110/111 and 176/177: primary-source excerpts contain dehumanizing colonial claims, enslavement, and sexual objectification of Indigenous women. These are sensitive historical quotations. The questions and generated answers analyze the material rather than endorse it.
- Other sensitive cases discuss a murder confession and hallucinations, sexual behavior and HIV/AIDS, abortion ethics, human sacrifice, a drug-sale fraud, slavery abolition, and casualties from the Boston Marathon bombing. Their language is neutral, non-graphic, and educational.

Political, religious, medical, disability, and historical references were not marked offensive merely for naming a contested subject. For example, the same-sex marriage and mothers prompts in the language set are awkward in places but do not attack sexual orientation or gender. Scientific references to cell death and clinical disease were also left unflagged.

## Limits

This is a content judgment over the current publication snapshot, not a formal classifier or a guarantee that no reader will object to another passage. Broad lexical screening helped locate candidate material, but each reported item was read in context. The language and JudgeBench sets received the deepest review because they contain the most free-form generated prose; other records received a complete decoded inventory, broad screening, and contextual review of matches rather than independent sentence-by-sentence annotation by multiple reviewers.

The reproducible [inventory.py](inventory.py) script decodes the publication manifest and prints dataset totals, all strings, or lexical candidates. It is an audit aid, not the decision-maker. [NOTES.md](NOTES.md) records the working scope and review decisions.
