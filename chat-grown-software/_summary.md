Geoffrey Huntley's [Jiti](https://github.com/ghuntley/jiti) grows an application by chatting with a live Common Lisp image. Here the idea is rebuilt in TypeScript on a `node:vm` realm, with a focus on verification. The model proposes code and example calls but never the expected answers: the kernel shows the user what each call actually returns and does to the state, asks its own boundary, repetition and coverage questions, and only the user's answers become the contract. With contracts built that way, seven verification layers caught 100% of 238 behaviour-changing slips in an expense tracker and 96% of 224 in a held-out shop scenario. They also caught 30 of 37 hand-written misunderstandings, against 10 when the model graded itself. A follow-up in `languages/` rebuilt the kernel in Clojure, Elixir, Pharo Smalltalk, Racket and Lean 4 and had [DeepSeek](https://api-docs.deepseek.com/) grow two apps in each, 3 runs per language, scored by hidden checks.

- Every language but Lean scored 95-100% on both apps. The language changes what the kernel can know before running code more than whether the model gets the code right.
- What each language added:
  - Clojure, Racket, Smalltalk, Elixir and Lean refuse calls to missing functions statically.
  - Elixir migrated a live gateway's data under traffic with 0 failures.
  - Racket's sandbox contained attacks that escape `node:vm`.
  - Lean proved a quota law that three test-passing bugs broke.
- Lean scored 83-84% at 3-12x the tokens, losing turns to re-proving.
- All scores come from a simulated user who never errs, so they are upper bounds. Two prompt-injected changes (rounding pricing in the attacker's favour, leaking keys in error text) passed every gate.
