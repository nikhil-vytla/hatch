# Design conversation

Settled by the user: the live world keeps running; model speed and parallelism are central; checkpointing and trajectory inspection coexist with live play. Bounded evaluation is a separate concern from the playable game.

## Round 1

1. **Settled:** offer both late-response conditions as a comparison. One continues the last valid action without local assistance; the other uses a clearly marked local controller when needed. Preserve the same starting checkpoint and expose how much time each run uses returned model decisions versus local fallback. The user's answer was "Offer both as a comparison."
2. **Settled:** one complete game plus a crowd simulation first. The user also explicitly authorized agents to explore additional games, creative worlds and emergent behavior in parallel.
3. **Settled:** synchronized side-by-side branches from the same checkpoint, with scrubbing, preserved earlier runs and human takeover in either branch. The user explicitly confirmed both rewind-and-branch and synchronized side-by-side.

## Questions to explore through the next prototypes

- Which game or world makes a semantic decision matter, beyond a code-solvable controller?
- What is a valid continuing action in that world's physics, and what ends its validity?
- Which disturbances and arrival schedules stay matched between branches?
- How should model response latency and actual wall time enter a fair comparison?

The existing HTML is an interaction sketch. It exposes flight and crowd timing, three fallback choices, and sequential preserved branches; it does not yet implement synchronized side-by-side branches. Its local default is not a measured Jev run. No ADR yet: these prototype choices remain cheap to reverse.

The first round is settled. A full Tetris game, a living courtyard crowd and an independent Ghost Brush prototype are implemented in `../live-worlds/` and published in the canonical app. Their paired clocks, restored branches and attribution passed independent production browser checks. Those prototypes make the next questions concrete before further design decisions.

## Round 2, exposed by play

4. Default assisted Tetris timing is open: an immediate code fallback can lock the observed piece before an asynchronous answer arrives. Both immediate fallback and a configurable grace period will be exposed. The optional user question recommends a short grace period as default, with gravity continuing throughout. This changes control scheduling, not the frozen framing benchmark.

The optional timing question had no reply during the implementation window. Root stated a provisional 700ms default, with 0ms immediate fallback available in the same control. This remains a reversible prototype assumption, not an answered user preference.
