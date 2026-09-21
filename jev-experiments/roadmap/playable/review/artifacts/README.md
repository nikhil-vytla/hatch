# Final scoped artifact audit

The four reviewed folders contain no file at or above 2,000,000 bytes. Their 20 selected WebP images range from 27,522 to 334,018 bytes and total 2,627,744 bytes. All 20 are ignored by the repository's `output/` rule and should be retained explicitly using the exact repository-relative paths in [selected-binaries.txt](selected-binaries.txt). The [inventory](artifact-inventory.json) records sizes, SHA-256 hashes and ignore status for all 90 files reviewed; this audit's own outputs are excluded to avoid a recursive inventory.

| Check | Result |
| --- | --- |
| Oversized files | None, using the conservative decimal 2 MB limit. |
| Downloaded full-code copies | No repository/dependency trees, symlinks, archives, model files or fetched source bundles found. The scoped implementations and review scripts are Jev-authored work. The retained third-party material consists of selected attributed screenshots. |
| Credits and source URLs | All 11 reference-board figures have a primary HTTPS source, caption, image description and existing image file. The original style study cites its six interaction/design references. The design report separates Laya's model author, Dobry's playground and Eric Zhang's scoring method; materials and music credits link Patchwork and Tone.js, while the app credits also identify Max Bittker's Sandspiel. No new credit gap was found in this scope. |
| Private data | Offline visual review of all 20 images found public reference pages or Jev demo UI, with no visible credentials, private messages or account chrome. None of the images contains EXIF or XMP metadata. Text scans found no credential, private-key, email or signed-URL matches. The sole home-path pattern match is the harmless phrase “root/home/current-directory targets” in the Mac review. |
| Stale claims | The older Mac and training reviews now describe their historical checkpoints and link later evidence. The scene review records root's subsequent Tetris correction instead of implying that its older source inventory covered the change. No frozen protocol, raw result, product code or root/delivery document changed. |

## Selected artifacts

Keep the 14 design-research images: 11 attributed public reference captures and three captures of the original style study. Keep the six materials-craft images: the before state, home composition, cell inspector, mobile view, dark mobile view and touch preview. Their names, hashes and byte sizes are in the inventory; their exact force-add paths are in [selected-binaries.txt](selected-binaries.txt).

Do not force-add `jev-experiments/roadmap/tetris/record.local.log`. It is redundant console progress output; the frozen protocol, `games.jsonl` and `summary.json` are the retained evidence. Temporary contact sheets used for offline inspection were created outside the repository and are not selected artifacts. No files were staged or committed by this audit.

## Reproduce and limits

```sh
python3 jev-experiments/roadmap/playable/review/artifacts/audit.py
```

The script uses the Python standard library and Git metadata. It scans `roadmap/design-research`, `roadmap/materials`, `roadmap/playable` and `roadmap/tetris`; it does not make network requests or invoke models, browsers, simulations or performance measurements. Manual review covered the screenshots, source credits, current scoped prose and Tetris recorder's retained fields. External URLs were checked for attribution presence, not fetched again. Pattern matching and visual inspection are bounded checks, not forensic proof that every possible secret encoding or source-origin issue is absent. Screenshots document a dated review state; they do not establish current release acceptance or grant permission to reuse third-party artwork in the application.
