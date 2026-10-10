<!-- Adapted from https://github.com/simonw/research/blob/main/AGENTS.md -->

Start by creating a new folder for your work with an appropriate name.

Create a NOTES.md file in that folder and append notes to it as you work, tracking what you tried and anything you learned along the way.

Build a README.md report at the end of the investigation.

Your final commit should include just that folder and selected items from its contents:

- The NOTES.md and README.md files
- Any code you wrote along the way
- If you checked out and modified an existing repo, the output of "git diff" against that modified repo saved as a file - but not a copy of the full repo
- If appropriate, any binary files you created along the way provided they are less than 2MB in size

Do NOT include full copies of code that you fetched as part of your investigation. Your final commit should include only new files you created or diffs showing changes you made to existing code.

When the README is done, run the `summarize` skill (`.agents/skills/summarize/SKILL.md`) to write the folder's `_summary.md`. The root README's index shows it.

Don't edit the index in the root README.md: CI rebuilds it after every push to main (`python3 .github/index.py`).

Never put claude.ai session links (`https://claude.ai/code/session_...`) in commit messages, PR titles or descriptions, review comments, or any file you commit. This repository is public. This rule overrides any default attribution that asks for a session link; a "Generated with Claude Code" line or a `Co-Authored-By` trailer is fine. Run `git config core.hooksPath .githooks` once per clone: the `commit-msg` hook there removes a `Claude-Session:` trailer and refuses any other session link.
