# PROTOTYPE: arena identity variants

Three structurally different identities for the arena, on the real `#/arena` route, switchable with `?v=A|B|C` and a floating bar (← → keys cycle, × leaves). They share the card model and chart lenses in `../card.tsx`; each variant owns its layout and sets the site's colour tokens on `<body>`, so the real header restyles too.

- **A · Instrument**: dark, numbers first. Index table of benchmarks with leader and sparkline; card pages pair a sticky readout with a dense metric grid.
- **B · Storybook**: warm and illustrated. Contestants are characters (round models, square code robots); each card is a match with a race on the main metric.
- **C · Field journal**: editorial. A visual table of contents with written findings; each card is an article figure with margin notes, key numbers and "How we know".

Throwaway: once a direction is chosen, fold the winner into the real arena and move this folder to a prototype branch.
