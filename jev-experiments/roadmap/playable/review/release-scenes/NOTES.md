# Independent release scene review notes

- Root requested a final bounded read-only review of current integrated playable source and design credits against the first-release plan.
- Focus: stale decisions after editing/reset/branch/unmount, keyboard/touch and reduced-motion paths, public claims/catalog readiness and attribution gaps.
- No product edits, GPU work or performance measurements. Existing passing behavior will be retested only if a new code concern warrants a targeted reproduction.
- Temporarily prioritized the new default-promotion boundary at root's request. Its separate report is in ../default-promotion; then resumed this scene review.
- Inspected current materials, music, crowd and Tetris handlers/engines, reduced-motion CSS/render conditions, root routing/catalog and builder credits. No new consequential stale-decision or keyboard/touch defect was found in this bounded pass.
- Found one public-evidence gap: the materials panel claimed instruction labels were frozen but exposed neither PROTOCOL.md nor labels.v1.json. The prepare script did not publish either artifact. Root confirmed and added two explicit downloads using Vite ?url imports, with protocol/label bytes unchanged.
- The source inventory ran after root's fast fix, so its retained artifact is named source-audit-after.json. It records current hashes, protocol/label imports, evidence links and all 41 catalog entries; every data-backed entry has its prepared JSON. Existence is not treated as proof of usability.
- Root owns browser verification of the actual downloaded bytes/build. This review did not duplicate the already-passing scene/browser flows, invoke a provider, run performance measurements or alter product files.
- Root subsequently verified both actual download clicks, filenames and byte-identical SHA-256 values in verification/materials-downloads.json. The evidence-access finding is closed.
