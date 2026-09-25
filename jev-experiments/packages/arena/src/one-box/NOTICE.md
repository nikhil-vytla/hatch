# Credit

One box is our version of [Shapeshift](https://github.com/anishfn/shapeshift) by Anish, MIT
licensed. It is our own code, but three parts carry upstream's work:

- `questions.ts`: the 14 questions, word for word, so Jev sees exactly what Shapeshift asks.
- `calm.ts`: Shapeshift's calm-UI rules and thresholds, restated as one reducer.
- `keyword.ts`: Shapeshift's offline keyword classifier, its rules and weights unchanged, laid
  out as a table. It is a contestant, so it is never tuned on our phrases.

`port.test.ts` checks all three against behaviour captured from upstream commit
`5e24166dcbde6e794f0bd5b1b4bd395aaee5fc19` (2026-09-24) before its code was removed from this
repo: the questions exactly, and the keyword output and calm-UI state on every prefix of 429
texts.

Upstream's licence:

> MIT License
>
> Copyright (c) 2026 Shapeshift contributors
>
> Permission is hereby granted, free of charge, to any person obtaining a copy of this software
> and associated documentation files (the "Software"), to deal in the Software without
> restriction, including without limitation the rights to use, copy, modify, merge, publish,
> distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the
> Software is furnished to do so, subject to the following conditions:
>
> The above copyright notice and this permission notice shall be included in all copies or
> substantial portions of the Software.
>
> THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING
> BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
> NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
> DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
> OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
