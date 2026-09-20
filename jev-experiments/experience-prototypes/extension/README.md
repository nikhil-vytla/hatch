# Jev paste companion

This is an unpacked Chrome / Edge Manifest V3 prototype, not a store release.

1. Download the companion ZIP from the lab and unzip it.
2. Open `chrome://extensions`, enable Developer mode, choose **Load unpacked**, and select this folder.
3. Open the companion popup. Under Connection, enter `https://jev-experiences.vercel.app` and your private lab access token. Click Connect and grant access to this lab origin.
4. Select useful text on a source page. Choose **Use this with Jev paste** from the right-click menu, or click **Capture selection** in the popup.
5. On a destination page, focus a field and choose **Suggest focused field**. Alternatively choose **Suggest this form**.
6. Inspect the proposed value and its source, then accept it. Undo restores accepted values while preserving later manual edits. Submit the destination form yourself.

Try the [sample source](https://jev-experiences.vercel.app/companion-demo/source.html) and [sample destination](https://jev-experiences.vercel.app/companion-demo/destination.html). Personal notes are optional, entered explicitly, and stored only in this browser. The selected notes and destination field descriptions are sent to the lab and Jev when you request suggestions. Clearing notes removes the local copies; it does not erase provider request processing.

The prototype handles ordinary visible inputs, textareas, and selects. It skips passwords, file pickers, hidden fields, and read-only fields. It does not enter cross-origin frames, shadow-root fields, or website-specific rich editors. Values come directly from captured facts; dates and other specialized fields may need manual formatting. The extension contains the lab access token, never the gateway API key.
