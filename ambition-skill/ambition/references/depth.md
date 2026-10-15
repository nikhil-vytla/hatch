# Depth

Depth means pushing the model to work the way the best people in a field work: with their instruments, their raw material and their standards of proof. The bar is a result an expert could learn something from. A bigger version of the same shallow work doesn't count.

## The tell: vocabulary without method

Asked to "analyse like a data scientist", models often switch to data-science words while still making a markdown table by hand. Look at the **methods** in the plan, not the words. A deep plan names real instruments, for example:

| Shallow | Deep |
|---|---|
| "Look at the churn numbers" | Load raw events into a database (DuckDB, Postgres). Fit a survival or hazard model and report confidence intervals. |
| "Speed up the page" | Profile with a real tracer, set a budget per stage, and check results against a load-test harness. |
| "Review the contract" | Compare clause by clause against a precedent library, then score the deviations against a risk rubric. |

## The five depth moves

1. **Use the profession's instruments.** Install them if needed. Ask which tool a top practitioner would open first.
2. **Set an unreasonable target and present it as reachable.** "Get load time to 200 ms. It can be done if you keep going" draws more effort than "improve it from 5 s". Specific, hard goals beat "do your best", as decades of goal-setting research show (see [self-efficacy.md](self-efficacy.md)).
3. **Test the premise.** Before building on what everyone "knows" ("churn is an onboarding problem"), check it against the raw data. Often the premise is the finding.
4. **Produce new knowledge.** Ask for something nobody has yet: a leading indicator, a simulated population, a counterfactual. Then check it against data held out from its discovery.
5. **Use an outside judge.** The model doesn't grade its own work. Find a judge outside both the model and the user, such as tests, a holdout set, a benchmark, a profiler, a compiler, a market or a human expert. Ideally make the judge a tool the model can call in a loop, so feedback arrives in seconds.

## The four questions (rewrite pattern)

Before you rewrite a request, answer:

1. What would a top professional do here that wasn't asked for?
2. What is the rawest material they'd start from?
3. Which specific methods and tools would they use?
4. What, other than the model or the user, would verify the result?

Then rewrite the prompt so it asks for exactly that. The ready-to-paste version is in [../assets/depth-rewrite-prompt.md](../assets/depth-rewrite-prompt.md).

## Completion check

- Every method in the plan is a real, named technique or tool.
- The input is raw data, not a summary of it.
- Each conclusion has an outside judge attached.
- At least one premise has been tested, not assumed.
