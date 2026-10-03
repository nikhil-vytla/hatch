# Publication lineage notes

This slice labels the existing benchmark display derivative explicitly and makes its lineage part of preparation and validation. It preserves recorded labels, model outputs and metrics. The implementation starts from the scene-lifetime PR source and will be verified in an isolated checkout.

- The first integrated test exposed an old assertion that expected unprojected source text. Updated that condition to verify the explicit derivative, all four pinned omission identities, unchanged source bytes and idempotent projection. Synthetic tests still exercise the original-to-derivative transform.
- The isolated checkout passed the application build, 25 tests and the 45-publication comparison.
- Committed the selected source files, then rebuilt and checked an exact Git archive of that commit. All four command steps passed with no overlay.
- Historical scene test results remain evidence for their original source condition. This report records the changed derivative condition separately.
