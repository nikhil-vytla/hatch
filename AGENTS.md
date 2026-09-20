Start by creating a new folder for your work with an appropriate name.

Create a NOTES.md file in that folder and append notes to it as you work, tracking what you tried and anything you learned along the way.

Build a README.md report at the end of the investigation.

Your final commit should include just that folder and selected items from its contents:

- The NOTES.md and README.md files
- Any code you wrote along the way
- If you checked out and modified an existing repo, the output of "git diff" against that modified repo saved as a file - but not a copy of the full repo
- If appropriate, any binary files you created along the way provided they are less than 2MB in size

Do NOT include full copies of code that you fetched as part of your investigation. Your final commit should include only new files you created or diffs showing changes you made to existing code.

At the end, use the following prompt when creating a  _summary.md file:

SUMMARY PROMPT: "Summarize this research project concisely. Write just 1 paragraph (3-5 sentences) followed by an optional short bullet list if there are key findings. Vary your opening - don't start with 'This report' or 'This research'. Include 1-2 links to key tools/projects. Be specific but brief. No emoji."

## Jev experiments deployment

- The Vercel project `jev-experiments` deploys GitHub `main` to `https://jev-experiments.vercel.app`. Its Root Directory is `jev-experiments/experience-prototypes`, where the app's `package.json`, `vercel.json`, and API functions live.
- If reorganizing the app, update Vercel's Root Directory in the project settings as well as repository paths. This setting lives in Vercel and does not follow a directory rename automatically. Current commands are `bun install --frozen-lockfile` and `bun run build`, with output in `dist`.
- Keep outside-root source access enabled while the build reads parent results and research assets. Do not broadly exclude `results` in `.vercelignore`: clean Git builds need the committed JSONL inputs to generate public JSON.
- After moving files, verify a GitHub deployment from a clean checkout. Locally prepared public assets can hide missing inputs. See [the configuration report](jev-experiments/vercel-git-root/README.md).
