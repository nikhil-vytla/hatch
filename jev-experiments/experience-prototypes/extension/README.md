# Jev paste companion

This is an unpacked Chrome / Edge Manifest V3 prototype, not a store release.

1. Download the companion ZIP from the lab and unzip it.
2. Open `chrome://extensions`, enable Developer mode, choose **Load unpacked**, and select this folder.
3. Open the companion popup. Under Connection, enter `https://jev-experiments.vercel.app` and your own Vercel AI Gateway API key. Click Connect and grant access to this lab origin.
4. Select useful text on a source page. Choose **Use this with Jev paste** from the right-click menu, or click **Capture selection** in the popup.
5. On a destination page, focus a field and choose **Suggest focused field**. Alternatively choose **Suggest this form**.
6. Inspect the proposed value and its source, then accept it. Undo restores accepted values while preserving later manual edits. Submit the destination form yourself.

Try the [sample source](https://jev-experiments.vercel.app/companion-demo/source.html) and [sample destination](https://jev-experiments.vercel.app/companion-demo/destination.html). Personal notes are optional, entered explicitly, and stored only in this browser. The selected notes and destination field descriptions are sent to the lab and Jev when you request suggestions. Clearing notes removes the local copies; it does not erase provider request processing.

The prototype handles ordinary visible inputs, textareas, and selects. It skips passwords, file pickers, hidden fields, and read-only fields. It does not enter cross-origin frames, shadow-root fields, or website-specific rich editors. Values come directly from captured facts; dates and other specialized fields may need manual formatting. The extension saves your API key in local storage restricted to trusted extension contexts. Disconnect removes it. Keys are forwarded only to the configured playground, which passes them to Vercel AI Gateway without saving them. The source origin is retained for attribution; destination URLs and source URL paths, queries, and fragments are omitted. Existing captured URLs are reduced to origins when the extension starts.
