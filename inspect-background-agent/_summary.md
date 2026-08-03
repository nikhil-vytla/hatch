Built a hatch-scale Inspect-style background agent from Ramp's [builders post](https://builders.ramp.com/post/why-we-built-our-background-agent) and [Modal write-up](https://modal.com/blog/how-ramp-built-a-full-context-background-coding-agent-on-modal), using `/architect` plus the CTO three-plane diagram (Cloudflare SessionAgent/EventBus, Modal managers/Queue, Bun Runner + OpenCode + side cars).

- Workspace-first orchestration; SessionAgent mailbox; separate EventBus and PromptIngress; Runner owns agent + ide/vnc/tty URLs
- Typed `admitWrites()` sync gate; InstallationToken vs UserToken for push vs PR
- Compared peers (Valet, Open-Inspect/Rafiki, Cursor Cloud Agents, Devin, Claude Code) in `design/HARNESSES.md`
- 9 passing tests and `npm run demo` without cloud credentials
