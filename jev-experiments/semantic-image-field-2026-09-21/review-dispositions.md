# Review dispositions

[Fable 5.1 feedback](fable-feedback.md) came through OpenCode/AWS Bedrock. [Provenance](fable-provenance.json) records model identity, inputs and hashes. It reviewed an earlier source snapshot and two screenshots; the final implementation differs. Root verified runtime findings separately.

| Finding | Disposition |
| --- | --- |
| The field reads as a scrambled grid and loses useful comparison detail | Accepted. Grid is the default, with larger images, scores and caption-vs-metadata rank changes. Field remains an optional spatial interaction. Removed per-card borders. |
| A 72-card cap leaves holes in overview | Accepted. Removed the hard cap. Keep only viewport-plus-overscan filtering and the active work. All visible works can render; the full archive has 204. |
| Focus is green or scales incorrectly | Fixed. The field's amber focus outline uses zoom-compensated width and offset at a higher, explicit specificity. |
| Mobile field traps page scrolling | Fixed. Vertical touch scrolling is the default. Move field enables touch pan/pinch; the toggle sits outside the canvas. Mouse drag remains immediate. |
| Busy placement can contradict current rank labels | Fixed the visible explanation. While ranking, the field says positions stay fixed until completion. Query/filter changes still update membership immediately. |
| Fallback text becomes tiny at overview zoom | Fixed. Hide that text in overview; retain the image-status glyph and full accessible artwork label. |
| Ring placement is not strictly monotonic in Euclidean distance | Clarified the claim. The field uses ordered square rings, not a distance metric. |
| Attribution omits the reference pipeline's example | The source study credits the Transformers.js example. The UI credits the interaction precedent; its search pipeline was not adopted. |
| Missing metadata could assert hardcoded counts | Fixed. Show counts only when the supplied artifact contains them. |
| A live run makes the recorded baseline hard to recover | Fixed. Use recorded / Use live result switches between preserved results for a saved query. |
| Add rank-order keyboard movement | Accepted. Page Up / Page Down follow display rank; arrows remain spatial. |
| Add wheel zoom and animated rearrangement | Deferred. Preserve ordinary wheel page scrolling and immediate updates. No idle animation or motion is required to use the archive. |
| Focus after detail navigation returns to the opener | Retained. Closing returns to the actual trigger, with search as fallback if the trigger disappeared. This keeps the browsing location stable. |
| Collection is beyond the reference's scope | Retained as an authored extension. It gives this existing experiment a useful, source-linked artifact, as required by the release plan. |
| Screenshots lack state captions | Added a capture manifest with state, attribution and hashes. Earlier review captures are identified as earlier states. |

Independent implementation review also found stale focus after an edge arrow, filter membership frozen during live ranking, and unrun exports labeled recorded. All three were corrected. Collection imports use canonical artwork metadata; they cannot replace titles or source URLs supplied by the archive.
