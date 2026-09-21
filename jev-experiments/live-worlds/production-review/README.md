# Production browser check

The deployed [home page](https://jev-experiments.vercel.app), [Tetris](https://jev-experiments.vercel.app/#experiment/tetris) and [crowd](https://jev-experiments.vercel.app/#experiment/crowd) passed this browser check on September 20, 2026. No blocker was found. The review began on frontend deployment `f97ae27`; root's subsequent `7438545` changes only the wardrobe server import and leaves this frontend unchanged.

| Area | Observed result |
| --- | --- |
| Home | Both preview canvases animated. The main Tetris link opened the playable route. |
| Tetris progression | Gravity advanced while a local decision waited on its 1200 ms artificial delay. Both game clocks reached exactly 14,180 ms. The lanes placed 12 and 9 pieces; pause froze both. |
| Tetris rewind and control | Rewound to 7,400 ms. A branch preserved both games, queues and settings. Restoring the previous run recovered its exact game states at 14,180 ms. Human takeover and touch drop worked. |
| Crowd progression | The genuine saved plan replay advanced both worlds to 5.1 seconds, exactly 153 ticks. Each lane showed 12 recorded decisions and zero live decisions. Residents moved, and pause froze the scenes. |
| Crowd rewind | Rewound to zero and disabled live posting. The new branch retained resident memory, RNG, disturbances, controller settings and UI selections. The previous 5.1-second tail remained preserved. All exported checkpoints had matching clocks and ticks. |
| Layout | Home, Tetris and crowd fit a 390 px viewport without horizontal overflow. Crowd's dark mobile view had two 344 px canvases. Desktop checks used 1440 px. |

Checks used a separate keyless Playwright session with `/api/**` blocked after the first home load. No owner credentials, model requests, camera, microphone or wardrobe route were used. No console errors or warnings were observed. Tetris results come from its labeled local timing demo; crowd decisions are recorded playback. These observations do not measure live Jev quality, long-session memory use or every game mechanic.

[Home desktop](home-desktop.png), [home mobile](home-mobile.png), [Tetris desktop](tetris-desktop.png), [Tetris mobile](tetris-mobile.png), [crowd desktop](crowd-desktop.png) and [crowd mobile dark](crowd-mobile-dark.png) show the reviewed layouts. Each screenshot is below 2 MB. [Export checks](crowd-export-checks.json) and [browser checks](checks.json) retain the observed results; [NOTES.md](NOTES.md) records the corrected test setup mistakes. No application source changed.
