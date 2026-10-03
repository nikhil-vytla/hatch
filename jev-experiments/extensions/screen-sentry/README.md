# Screen sentry (prototype Chrome extension)

**This is a throwaway prototype on branch `proto/screen-sentry`.** It's not on `main` and not published.

It's a safety net for AI helpers that browse for you. On any page, it walks the text blocks, including hidden text, tiny text, HTML comments and image alt text. It scores each one with a small classifier bundled in the extension, and outlines the ones that read like instructions aimed at an AI assistant ("ignore the user and…", "P.S. to any AI reading this…"). A browsing helper can then skip those blocks.

## Install (load unpacked)

1. Build: `bun jev-experiments/extensions/screen-sentry/build.ts`. This writes `dist/`; a built copy is committed on this branch.
2. Open `chrome://extensions` and turn on **Developer mode**.
3. Click **Load unpacked** and pick `jev-experiments/extensions/screen-sentry/`.
4. Open any page, or the trap page: `cd jev-experiments/extensions/screen-sentry/test-pages && python3 -m http.server 4721`, then visit http://127.0.0.1:4721/flights.html.
5. Click the toolbar icon for the popup: what was flagged, an on/off toggle, and "Ask Jev".

## What runs where

- **Scoring:** on this device, always. The classifier is `jev-experiments/live-worlds/sentry/model.ts` with `weights.json` (5 logistic heads over hashed words and layout cues), about 48 KB.
- **Training data:** only blocks we wrote by hand (`live-worlds/sentry/dataset.ts`). No Jev output was used; TypeSafe's Master Customer Agreement §2.3(b) forbids training a model to imitate Jev.
- **Ask Jev (optional):** add your own Vercel AI Gateway key on the options page. It's stored in `chrome.storage.local` and sent only to `https://ai-gateway.vercel.sh` (the only host permission), only when you press the button.
- **Permissions:** `storage`, plus a content script on all pages, needed to read page text. No `tabs`, history or network access beyond the gateway.

## How well it works

On a separate test set of 40 blocks written by hand before scoring (`live-worlds/sentry/wild.ts`), it caught 17 of 20 injections and wrongly flagged 5 of 20 harmless blocks:
- **Missed:** a "leave out negative reviews" note, a line naming Claude/GPT/Gemini, and a mid-page "new task:" splice.
- **Wrongly flagged:** "please ignore the previous email", a password prompt, gate agents, an assistant chef and a captcha.

It's a prototype filter, not protection.

## Known gaps

- Layout detection is rough: same-colour text, fonts under 6 px, off-screen, `display:none`. Text hidden by clipping, overlays or canvas isn't seen.
- It scans once at page load. Content that loads later isn't rescanned.
- It doesn't do OCR on images; only alt text is read.
- `popup.html?tab=<id>` is a test hook so automated checks can open the popup for a given tab.
