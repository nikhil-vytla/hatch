# Materials interaction and visual refinement

The materials scene now puts a usable palette before the canvas, gives each material a distinct visual texture, and supports direct cell inspection with a visible brush footprint. The change is limited to `MaterialsSandbox.tsx` and `materials.css`; the simulation engine, frozen labels, file format and dependencies are unchanged.

## Three changes

1. **Put the first action within reach.** The palette and selected material's behavior now sit above the world. Paint and Inspect form one stable tool switch; Play, Reset and Expand remain visible. Tick, single stepping and branch creation move into Scene tools. Selecting the custom material on the home page exposes immediate Stay/Pile/Flow/Rise controls and its contact rule, with the full reaction editor one click away.
2. **Make the world readable.** The renderer uses round sand grains, continuous water with surface edges, stone ledges, wood grain, purple diamonds, small flames and translucent steam. A restrained paper grid works in light and dark themes. A short on-canvas invitation points at the pool and disappears after painting. The scene retains its 3:2 proportions, including compact and fullscreen layouts.
3. **Show what an action targets.** Pointer and keyboard users see the whole brush footprint. Touch painting shows a magnified area above the contact point. Inspect pauses the scene and exposes the selected cell's coordinates, material and behavior, with a button to paint using that material. Cursor state remains available to assistive technology.

These treatments follow the adjacent design research's working-figure, immediate-control and inspectable-rule recommendations. All rendering and interaction code is original. No third-party assets or new dependency were added.

## Verification

- App TypeScript check passed. All eight material tests passed, including deterministic replay, branch independence, malformed import rejection and stale interpretation invalidation.
- Chromium at 1440×1080: pointer painting, ArrowRight/Space painting, cell inspection and direct custom motion changes worked. Both compact and full editors reflected the same rule.
- Chromium at 390×844: no horizontal overflow; canvas width/height ratio was 1.50003. The custom-material label can wrap over two lines instead of losing its name to a narrow button.
- Reduced motion started the scene paused and removed control transitions. Dark mode recolored the scene and controls.
- A Chromium touch event produced the above-finger magnifier and painted through the normal pointer handlers. This was browser emulation, not physical-device testing.
- Fullscreen entry/exit preserved aspect ratio. Branch creation, browser save, JSON export, reset and branch restoration completed. The downloaded scene had format `materials-1`, 96×64 dimensions and 6,144 cells.
- Browser console showed no errors. Frame-time profiling and live Jev interpretation were not rerun during active training.

Selected screenshots are in [output/playwright](output/playwright). [Home](output/playwright/home-desktop.webp), [cell inspection](output/playwright/inspect-desktop.webp), [mobile](output/playwright/materials-mobile.webp), [touch preview](output/playwright/touch-preview-mobile.webp), and [dark mobile](output/playwright/materials-dark-mobile.webp) are each under 2 MB. The before screenshot records why the palette needed moving: it was below the visible canvas. Root owns homepage composition and final release review.
