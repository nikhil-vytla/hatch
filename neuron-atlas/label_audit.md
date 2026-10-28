# Label audits

## SmolLM2-135M-Instruct (30 random labels, graded by hand)

Labels: DeepSeek-flash (`deepseek-chat` endpoint). Grader: Claude Opus 5.5, reading each neuron's top 4 documents
(peak token in «») and logit lens. Sample: `random.Random(7).shuffle` over all 1,318 labels.
G = label matches the evidence, P = partly (too narrow / too broad / reads the wrong side), W = wrong.

| # | neuron | label | conf | detect | grade | note |
|---|---|---|---|---|---|---|
| 0 | L26 N1409 | 'at all' phrase detector | 5 | 1.00 | P | fires on " at" generally ("at the global level", "at the end") |
| 1 | L11 N1483 | hyphenated compound joiner | 4 | 1.00 | P | "-", "isch", " perspective", Cyrillic "х": no single pattern |
| 2 | L26 N1262 | marriage and family relations | 4 | 1.00 | G | lens: women, daughter |
| 3 | L14 N621 | 'similar ... except/but' comparisons | 5 | 1.00 | G | |
| 4 | L24 N987 | cooking pans and heat | 4 | 1.00 | G | lens: Heat, pan, heat |
| 5 | L8 N67 | recursive and binary search | 4 | 1.00 | P | also " spread"; 3 of 4 fit |
| 6 | L15 N1322 | 'denote the cost as x' math setup | 5 | 0.75 | G | all 4 docs are near-duplicates of one bat-and-ball problem |
| 7 | L18 N1073 | 'of' and 'inside' relations | 4 | 0.75 | P | lens others/other/else: it predicts "other/another" next |
| 8 | L25 N245 | 'where ... come from' origin questions | 4 | 0.75 | G | |
| 9 | L2 N906 | 'pin' inside words | 4 | 0.75 | G | |
| 10 | L27 N190 | past perfect 'had' | 4 | 0.75 | G | fires on the subject, lens "had": predicts "had" |
| 11 | L1 N64 | mid-word 'arc/orm/at' fragments | 2 | 0.50 | P | honest low confidence; no pattern |
| 12 | L10 N914 | install/border/federal nouns | 3 | 1.00 | W | polysemantic |
| 13 | L17 N1048 | definite article 'the' before nouns | 3 | 0.50 | P | fires after "and the" |
| 14 | L16 N1123 | simile object nouns | 3 | 0.75 | G | road, puzzle, door, rose after "like a" |
| 15 | L10 N955 | 'from' in transfer phrases | 4 | 1.00 | G | |
| 16 | L10 N347 | DOI and citation punctuation | 4 | 0.50 | G | |
| 17 | L28 N68 | impact and effect words | 4 | 1.00 | P | fires on the token *before* impact/effect |
| 18 | L16 N437 | French/Spanish place names | 3 | 1.00 | P | |
| 19 | L21 N1101 | 'for the first time' | 5 | 1.00 | G | lens: first, First |
| 20 | L12 N879 | comparative qualifiers 'in terms of' | 4 | 1.00 | G | |
| 21 | L18 N612 | temporal continuity 'still/today' | 5 | 1.00 | G | lens: today, now, present |
| 22 | L8 N1503 | passed/transmitted between people | 4 | 1.00 | G | |
| 23 | L11 N179 | idiomatic 'no/can/way' phrases | 3 | 0.50 | P | |
| 24 | L27 N1273 | 'until' / negation-of-yet | 4 | 0.75 | G | lens: until, till |
| 25 | L29 N593 | code minus-one and years | 4 | 0.50 | G | all 4 are `len(x) - 1`; "years" is spurious |
| 26 | L12 N35 | German/Russian suffix fragments | 3 | 0.50 | P | |
| 27 | L11 N524 | 'fortunate/privilege' humble-brag | 4 | 0.75 | G | "I've been fortunate enough" |
| 28 | L20 N291 | possessive apostrophe tokens | 5 | 1.00 | G | includes mojibake `?s`, `â€™` |
| 29 | L27 N1224 | code braces and proper nouns | 2 | 0.75 | W | polysemantic |

**Totals: 18 G, 10 P, 2 W.**

- Labeler confidence tracks quality: confidence 5 → 5/6 G; confidence 4 → 12/16 G; confidence ≤ 3 → 1/8 G.
- The detection check (held-out top docs vs random windows) is too easy to pass: both W labels scored 0.75–1.0.
  Random windows rarely contain any of a polysemantic neuron's triggers, so a grab-bag label still separates them.
  A harder check would use *near-miss* distractors (windows with the same token but low activation).
- Systematic miss: neurons that *predict* a token (lens = that token, firing on the position before it) get labeled
  as reading the current token (#7, #10, #17). Prompt now tells the labeler to read the logit lens for this.
- Corpus duplication shows up (#6): smol-smoltalk has many near-identical math chats.

## Qwen3-0.6B (20 random labels, same procedure, v2 prompt)

| # | neuron | label | conf | detect | grade | note |
|---|---|---|---|---|---|---|
| 0 | L2 N2870 | mid-word fragments in rare words | 2 | 0.75 | P | honest: no pattern |
| 1 | L11 N2938 | separated by delimiters | 5 | 1.00 | G | "separated« by» underscores" |
| 2 | L17 N2707 | comparative 'more/most importantly' | 5 | 0.75 | G | lens mostly Chinese: 最重要 "most important" |
| 3 | L3 N2876 | over- prefix words | 4 | 1.00 | G | Over«load», «overwrite» |
| 4 | L26 N2741 | Germanic/Romance word fragments | 2 | 0.50 | P | |
| 5 | L16 N2206 | dict subscripting in Python | 4 | 1.00 | G | fires on the name before `['`; lens `"`, `('` |
| 6 | L19 N2354 | algebraic expression components | 4 | 1.00 | P | lens `))^`, `)^`: it predicts `)^`, label misses that |
| 7 | L6 N2018 | mojibake punctuation artifacts | 2 | 0.50 | P | |
| 8 | L0 N1463 | Hebrew/Devanagari diacritic clusters | 4 | 0.50 | G | byte fragments of non-Latin scripts |
| 9 | L14 N2751 | table column separators | 4 | 0.25 | G | correct label, low detection score |
| 10 | L3 N2801 | crystal / crystalline | 5 | 0.75 | G | |
| 11 | L15 N811 | HTML attribute quotes | 3 | 0.50 | W | 1 of 4 is HTML |
| 12 | L16 N978 | function calls and code syntax | 4 | 1.00 | W | f(x), burs«a», Solastalg«ia», «period»: word endings, not code |
| 13 | L26 N2178 | letter 'l' after consonants | 3 | 0.50 | G | |
| 14 | L2 N2880 | 'material(s)' word detector | 4 | 1.00 | G | incl. French Maté«ria»ux |
| 15 | L4 N2091 | Indian names mid-word | 3 | 1.00 | P | name fragments generally (also Korean/Chinese) |
| 16 | L24 N1156 | pi and circle-area math | 3 | 0.50 | P | |
| 17 | L13 N1568 | f-string print statements | 5 | 0.50 | G | print«(f»" |
| 18 | L25 N1452 | digit after arithmetic result | 4 | 1.00 | G | first digit after "="; lens "1", "₁", "¹" |
| 19 | L11 N2535 | code constants and imports | 4 | 0.50 | P | |

**Totals: 11 G, 7 P, 2 W** (SmolLM2: 18/10/2 of 30).

- Confidence again tracks quality: conf 5 → 4/4 G; conf ≤ 3 → 1/7 G.
- Per-neuron detection is noisy with 4 snippets (a correct label scored 0.25, a wrong one 1.00). Use it in aggregate
  (model-level 0.75 vs 0.51 null), not to rank single neurons.
- Qwen's logit lens is often in Chinese even for English-firing neurons (#2, #1 lens 纽带/相遇 "bond/meet"): its
  output directions are multilingual.
