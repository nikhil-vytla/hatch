Start by creating a new folder for your work with an appropriate name.

Create a NOTES.md file in that folder and append notes to it as you work, tracking what you tried and anything you learned along the way.

Build a README.md report at the end of the investigation.

Your final commit should include just that folder and selected items from its contents:

- The NOTES.md and README.md files
- Any code you wrote along the way
- If you checked out and modified an existing repo, the output of "git diff" against that modified repo saved as a file - but not a copy of the full repo
- If appropriate, any binary files you created along the way provided they are less than 2MB in size

Do NOT include full copies of code that you fetched as part of your investigation. Your final commit should include only new files you created or diffs showing changes you made to existing code.

Open README.md with a one-paragraph summary of what you did and found: 3-5 sentences, specific, with 1-2 links to key tools or projects, no emoji, and don't start with "This report" or "This research". The root README's index uses that paragraph (or `_summary.md`, if a folder has one).

Don't edit the index in the root README.md: CI rebuilds it after every push to main (`python3 .github/index.py`).
