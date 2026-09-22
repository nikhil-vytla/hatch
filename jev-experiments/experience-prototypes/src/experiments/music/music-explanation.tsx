export function MusicExplanation() {
  return (
    <div className="ma-mechanism-prose">
      <h3>Keep the phrase. Change what comes next.</h3>
      <p>
        There are two scores while an edit waits: the one the player is
        scheduling, and your latest draft. Accepting a phrase changes the draft
        immediately. During playback, the scheduler adopts that draft at its
        next four-beat bar boundary. Several edits before that boundary replace
        the same pending score.
      </p>
      <p>
        A phrase lasts two bars, so a bar boundary can fall halfway through it.
        The change affects future scheduled notes. It does not restart a held
        note or rewind the phrase. Stop and play again to hear the whole revised
        score.
      </p>
      <h4>A lock protects the phrase's notes.</h4>
      <p>
        Locking rejects candidate replacements and melody-note edits. It does
        not freeze tempo, track mutes or the instrument palette: those are
        score-wide controls. A whole-brief request requires every phrase to be
        unlocked.
      </p>
      <h4>The model chooses; the code composes.</h4>
      <p>
        Code generates six two-bar candidates. Their melody contours differ,
        while the other five tracks are shared. A continuity filter excludes
        candidates whose melody jumps too far at either adjacent phrase
        boundary. Jev then answers one Choice question about the remaining
        symbolic notes, direction and preceding phrase. It receives no audio.
        This leap limit is a mechanical constraint, and its probability
        distribution is not a listener rating.
      </p>
      <p>
        Save in browser and Score JSON preserve the draft, locks, edits and
        retained decisions, including your written brief. They do not record
        what has already sounded. MIDI exports playable notes, timing,
        velocities, instruments and mutes; it does not carry the model request
        or its uncertainty. Keep the JSON beside the MIDI when the decision
        history matters.
      </p>
    </div>
  );
}
