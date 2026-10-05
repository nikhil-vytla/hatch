# Active scene observations

Four active local scenes were measured serially after model work completed, in desktop 1440 × 1000 and mobile 390 × 844 Chromium viewports. Each run used a 2-second warmup and 10-second sample, light theme and motion enabled. All eight used the same production assets, had no horizontal overflow and made no API requests.

| Scene | Viewport | Frame interval p95 | Animation callback work p95 | Intervals over 33 ms | Long tasks |
| --- | --- | ---: | ---: | ---: | ---: |
| materials | desktop | 16.8 ms | 0.8 ms | 0 | 0 |
| materials | mobile | 16.8 ms | 0.9 ms | 0 | 0 |
| crowd | desktop | 16.7 ms | 1.2 ms | 0 | 0 |
| crowd | mobile | 16.7 ms | 1.2 ms | 0 | 0 |
| tetris | desktop | 16.7 ms | 7.1 ms | 0 | 0 |
| tetris | mobile | 16.7 ms | 5.9 ms | 0 | 0 |
| music | desktop | 16.8 ms | 0.1 ms | 0 | 0 |
| music | mobile | 16.8 ms | 0.1 ms | 0 | 0 |

These short samples showed a steady browser frame cadence. Tetris spent more time in callbacks than the other scenes, but the measurements do not justify adding GPU infrastructure. They do not establish performance on phones or with every scene/history size. Callback timing excludes asynchronous React, layout and paint work; music was running, but this is not an audio-quality test.

[Machine conditions, report hashes and summary](performance-summary.json) accompany the raw intervals in the eight `frames-*.json` files. `profile-browser.py` is the reproducer and refuses to overwrite an existing measurement.

The retained samples precede the final routing quality-escalation and diff-header corrections. Those changes do not touch these scene engines, controls or styles. The raw reports identify the exact measured asset hashes; they are not relabeled as runs of a later build.
