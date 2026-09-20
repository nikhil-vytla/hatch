# Key exposure and attack-path review

The new app and API code keeps owner credentials out of browser imports, recorded evidence and API fallback paths. Visitors supply their own keys. Existing gateway tests verify concurrent key isolation, missing-key rejection, input bounds, provider-error sanitation and retry behavior. The new fal endpoint accepts only the fixed wardrobe model, uses only the supplied key, returns a short-lived model token with `Cache-Control: no-store`, and sanitizes upstream failures.

The local release scan examined 463 changed/new source files and 734 built files against 16 literal credential values privately read from the user's shell configuration and local Vercel CLI authentication file. It found zero matching files and no new binary at least 2MB. Run `python3 jev-experiments/quality-and-simulation-review/release-check.py` to repeat the bounded check. Values are never printed or stored by the scanner. The final run's counts may increase as documentation and code are completed.

Browser game and brush receipts contain input, choices and normalized responses, never HTTP authorization headers. The local recording loaders read credentials only in recording CLIs. No credential loader is imported by a browser component or deployed request handler. A scan of new JSON and JSONL artifacts found no token or authorization fields. Generated JSON imports are reconstructed from reviewed JSONL, not private local state.

Benchmark text, model output, labels and notices render as text in React or canvas. The new SVG exporters escape user text. Model decisions select from declared options and do not execute JavaScript, shell commands or arbitrary HTML. The artwork mirror downloader is a local acquisition script; the deployed app does not expose a URL-fetching proxy. External links retain provenance and the public content gates remain in place.

Camera and microphone use remain explicit user actions. Stopping video closes the socket and source tracks; unmount and page-hide cleanup are tested. Provider video transformation receives the opted-in video, and the speech-recognition disclosure explains the browser/platform dependency. The copy companion continues to reject untrusted senders and preserves caller-key isolation.

This review targets the user's concern about exposed keys and new attack paths. It is not a penetration test, dependency audit, or assurance that every possible vulnerability is absent. No shared usage quota or owner-funded visitor access was added.
