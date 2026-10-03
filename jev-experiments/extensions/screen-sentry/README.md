# Screen sentry (Chrome extension)

A safety net for AI helpers that browse for you. On any page it walks the text blocks, including hidden text, tiny text, HTML comments and image alt text. It scores each one with the small classifier from the [Screen sentry scene](../../live-worlds/sentry/), bundled in the extension, and outlines the ones that read like instructions aimed at an AI assistant ("ignore the user and…", "P.S. to any AI reading this…"). A browsing helper can then skip those blocks.

It isn't published to the Chrome Web Store. Load it unpacked.

## Install (load unpacked)

1. Build: `bun jev-experiments/extensions/screen-sentry/build.ts`. This writes `dist/`; a built copy is committed, so you can skip this step unless you change the code.
2. Open `chrome://extensions` and turn on **Developer mode** (top right).
3. Click **Load unpacked** and choose the `jev-experiments/extensions/screen-sentry/` folder.
4. Open any page, or the trap page: `cd jev-experiments/extensions/screen-sentry/test-pages && python3 -m http.server 4721`, then visit http://127.0.0.1:4721/flights.html. Its reviews load two seconds late, with a trap inside, to show the rescan.
5. Click the toolbar icon (pin it from the puzzle-piece menu) for the popup: what was flagged, an on/off toggle, and "Ask Jev".
6. Optional: open the extension's **Options** and paste your own Vercel AI Gateway key to use "Ask Jev".

To update after a rebuild, press the reload arrow on the extension's card in `chrome://extensions`. To remove it, press **Remove**.

## What runs where

- **Scoring:** on this device, always. The classifier is `live-worlds/sentry/model.ts` with `weights.json`: five logistic heads over hashed words and layout cues, about 55 KB.
- **Later content:** a MutationObserver rescans when the page adds or changes content, at most once a second, and ignores its own outlines. In the headless test, 50 rows inserted over one second caused about three rescans.
- **Training data:** blocks we wrote by hand, plus four openly licensed prompt-injection datasets (see [`data/SOURCES.md`](../../live-worlds/sentry/data/SOURCES.md)). No Jev output was used: TypeSafe's Master Customer Agreement §2.3(b) forbids training a model to imitate Jev.
- **Ask Jev (optional):** it asks Jev the scene's five questions about up to 16 flagged blocks, in batches of 8. Your key is stored in `chrome.storage.local` and sent only to `https://ai-gateway.vercel.sh`, which is the extension's only host permission, and only when you press the button.
- **Permissions:** `storage`, plus a content script on all pages, which it needs to read page text. No `tabs`, history or other network access.

## How well it works

These are the classifier's numbers from the scene (`live-worlds/sentry/eval.json` and `compare.json`), at a 50% threshold:

| Test | Injections caught | Harmless wrongly flagged |
|---|---|---|
| Fresh hand-written set, written before scoring (`wild2.ts`) | 20 of 20 | 3 of 20 |
| InjecAgent test split (instructions planted in tool output) | 16 of 21 | 0 of 5 |
| deepset test split | 34 of 58 | 2 of 56 |
| Eight harder traps on the scene's three pages | 15 of 24 | — |

Jev, asked the same questions, caught 22 of the 24 harder traps. The extension is a filter, not protection.

## Known gaps

- Layout detection is rough: it catches same-colour text, fonts under 6 px, off-screen elements and `display:none`. Text hidden by clipping, overlays or canvas isn't seen.
- It reads no text in images (no OCR); only alt text is read.
- It still flags some harmless text that talks about assistants or AI. On the fresh hand-written set, it flagged a benign "ignore our earlier message", a bank-feature blurb and a gift note.
- `popup.html?tab=<id>` is a test hook, so automated checks can open the popup for a given tab.
