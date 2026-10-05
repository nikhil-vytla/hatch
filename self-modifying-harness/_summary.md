An agent that writes, verifies and hot-installs its own tools was built by combining three recent systems:
- [pi-durable](https://github.com/earendil-works/pi/tree/main/packages/durable) contributes crash-safe commits and in-place extension reload;
- [OptChat](https://gist.github.com/VictorTaelin/91837951a5ce5b38f341ec1ba1df6449) contributes an endless chat, held as a binary tree of summaries with zoom;
- [celld](https://github.com/denoland/celld) contributes the cell model, in which code is loaded by version id and state is keyed by name, so state outlives code.

Each agent-written tool is a QuickJS-sandboxed cell with its own SQLite state. A protected kernel admits a new version only if it passes every check of its ancestors (a ratchet) and its migration works on a copy of live state. Every version records the chat message that asked for it. A scripted three-process demo on the real harness grows a tool, rejects a regression, migrates state, survives a crash inside the agent-written tool, and answers "who asked for this?" by zooming to the user's verbatim words.

- Recording pi-durable's call id inside the cell's own SQLite transaction made every agent-written tool exactly-once and replay-safe; without it, a crash after commit left the agent guessing.
- Extension install order is a security boundary: with the kernel installed first, a self-written tool silently replaces a kernel tool on reload.
- OptChat's view only composes with pi-durable if positional tool announcements are folded in after the view rather than dropped. Consecutive views shared 40k, 58k and 73k characters at 4k, 20k and 100k messages. At short histories, a plain sliding window gets more prompt-cache reads.
