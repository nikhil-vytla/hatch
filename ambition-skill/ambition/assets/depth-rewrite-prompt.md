# Depth rewrite prompt

Paste this ahead of a request (or send it to a subagent along with the request) to get a deeper version back before any work starts. Replace `{{REQUEST}}`.

```text
I want a deeper version of the task below, not a bigger one.

Before rewriting it, answer four questions:
1. What would the best professional in this field do here that I haven't asked for?
2. What is the rawest material they would start from? (Raw logs, source records, primary documents, not summaries.)
3. Which specific methods, instruments and tools would they use? Name them; install what's missing.
4. What, other than you or me, would verify the result? (Tests, a holdout set, a benchmark, a profiler, a domain expert, the market.) If it can be a tool you call in a loop, say how.

Then rewrite my request so it asks for exactly that. Set a target that sounds unreasonable but say it is reachable if you keep going. Name one assumption in my request you will test against the raw data before building on it.

Task:
{{REQUEST}}
```
