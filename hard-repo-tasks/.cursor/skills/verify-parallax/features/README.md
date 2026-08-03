# Parallax feature map

The map covers the five current user paths exposed by the console script and
package exports:

- [Compile a pinned repository recipe](compile-recipe.md)
- [Grade a candidate tree](grade-candidate.md)
- [Build and replay a GSM8K family](build-replay-family.md)
- [Export repository tasks](export-tasks.md)
- [Run a conversational arm](run-conversation-arm.md)

The first executable baseline is the family build and locked replay. The other
entries name their required pinned repositories, captured baselines, compiled
artifacts, optional packages, or caller callbacks. Future Evolving Intent
generation, external benchmark asset checks, SWE-bench Verified execution, and
checkpoint evolution are absent because no current reproducible Parallax user
path implements them.
