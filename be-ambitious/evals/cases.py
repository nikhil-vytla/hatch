"""Eval inputs: behavioural tasks, rubric, and trigger queries."""

# Ten plain, task-by-task requests across domains. Each is something a user
# "was going to ask a model", phrased the unambitious way.
TASKS = {
    "crash-fix": "Fix this crash in our Electron app: 'TypeError: Cannot read properties of undefined (reading \"webContents\")' in main.js line 212 when the user closes a window during an update download.",
    "qbr-deck": "Make me a slide deck for our quarterly business review. Revenue was flat, churn ticked up from 3.1% to 3.8% monthly, and we launched two features.",
    "survey-summary": "Summarize the 1,400 free-text responses from our annual customer survey into the top 5 themes.",
    "unit-tests": "Write unit tests for our Python `billing/invoice.py` module, which computes prorated invoices for plan changes.",
    "launch-email": "Write the launch email announcing our new team-sharing feature to our 40k free-tier users.",
    "slow-page": "Our product dashboard page takes about 6 seconds to load. Suggest some ways to make it faster.",
    "interview-prep": "Give me a list of likely questions for my staff data scientist interview at a fintech company next week.",
    "legacy-refactor": "Refactor this 3,000-line `utils.php` file in our legacy codebase into smaller files.",
    "lit-review": "Write a short literature review on interventions that reduce hospital readmissions for heart failure patients.",
    "hiring-jd": "Write a job description for a senior backend engineer on our payments team.",
}

USER_TEMPLATE = (
    "Here is what I was about to ask an AI model to do:\n\n"
    "\"{task}\"\n\n"
    "Help me be more ambitious with this. What should I ask for instead? "
    "Answer directly in your reply; do not use any tools or read any files."
)

# Rubric items are grounded in the source ARTICLE's techniques, not in the
# skill's output format, so the skill cannot score points merely by matching
# its own template. Each item is binary.
RUBRIC = {
    "R1_outcome": "Proposes a concrete, checkable outcome beyond the literal task (the goal behind the goal), not just a bigger version of the same deliverable.",
    "R2_durable": "Proposes a durable/standing workflow or process that would keep producing the outcome without a human prompting each step.",
    "R3_instruments": "Names at least two specific, real tools, instruments or methods a top practitioner would use (e.g. a named library, statistical model, profiler, database), not generic phrases like 'analyze thoroughly'.",
    "R4_raw": "Asks to start from raw or primary material (raw logs, event data, source records, full responses) rather than summaries.",
    "R5_premise": "Explicitly identifies an assumption in the user's request and proposes testing it against data before building on it.",
    "R6_judge": "Attaches a verifier outside the model itself (tests, holdout data, benchmark, profiler, A/B test, expert review, real metric) to its main proposal(s).",
    "R7_target": "Sets at least one specific, ambitious, quantified target (e.g. a number, threshold or deadline that stretches well beyond the status quo).",
    "R8_fields": "Brings in at least two other disciplines/fields and says concretely what each would do.",
    "R9_adversary": "Includes an adversarial or red-team check whose job is to find why the conclusion or plan is wrong.",
    "R10_access": "States concrete access, data or environment prerequisites the user must provide for the ambitious version to work.",
    "R11_prompt": "Includes at least one complete, ready-to-paste rewritten prompt.",
    "R12_grounded": "Stays grounded: the ambitious proposals are plausible for the user's actual context and avoid vague, unbounded goals (e.g. 'transform the company', 'make money').",
}

# Added after reading the v1 pairwise losses (see NOTES.md): the judge preferred
# the baseline when skill answers overreached or reused the skill's own example
# tools. Graded separately on every condition so v1 and v2 are scored alike.
RUBRIC_EXTRA = {
    "R13_executable": "Every proposed step could actually be carried out by an AI model with the access the response asks for, or is explicitly assigned to a person or external tool; it never asks the model to report numbers (effect sizes, benchmarks, model fits) it has no way to compute.",
    "R14_native": "The specific tools and methods named are ones practitioners of THIS task's own field actually use; none are imported from an unrelated field without a stated reason (e.g. an analytics database for writing an email).",
}

# Trigger eval: should an agent load `be-ambitious` given these skills?
DISTRACTOR_SKILLS = {
    "code-review": "Review the changes since a fixed point along standards and spec axes. Use when the user wants to review a branch, PR or work-in-progress changes.",
    "pdf": "Read, extract, merge, split, fill or create PDF files. Use whenever the user mentions a .pdf or asks to produce one.",
    "tdd": "Test-driven development. Use when the user wants to build features or fix bugs test-first, or mentions red-green-refactor.",
    "research": "Investigate a question against high-trust primary sources and capture findings as Markdown. Use when the user wants a topic researched.",
    "unslop": "Cut AI tells from any writing. Use when editing or reviewing prose.",
    "prompt-polish": "Fix grammar, clarity and formatting of a prompt without changing what it asks for. Use when the user asks to clean up or tidy a prompt.",
}

TRIGGER_QUERIES = [
    # should trigger
    ("I'm going to ask Claude to summarize our churn data. How could I be way more ambitious with that?", True),
    ("Think bigger: what else could an AI do for our quarterly planning beyond drafting the doc?", True),
    ("Here's my prompt for refactoring our auth module. Can you upgrade it so I get much more out of the model?", True),
    ("I feel like I'm only using AI for tiny tasks. What should I be asking it to do for my marketing work?", True),
    ("Push this plan further. I want the model doing work an expert would actually learn from.", True),
    ("We're asking an agent to fix crashes one at a time. Is there a higher-level way to frame this?", True),
    ("What's the most ambitious version of 'write unit tests for billing.py' I could hand an agent?", True),
    ("Upgrade this request so an AI attacks it like a top data scientist would: 'make a chart of signups by month'.", True),
    ("I want to stop micro-prompting. How do I give the model the outcome instead of the task?", True),
    ("My team uses Copilot for autocomplete only. What bolder things could we delegate?", True),
    # should not trigger
    ("Fix the null pointer exception in OrderService.java line 88.", False),
    ("Summarize this PDF report into five bullet points.", False),
    ("Review my branch against main for style issues.", False),
    ("Fix the typos and grammar in this prompt but keep the meaning exactly the same.", False),
    ("Write a failing test first for the new discount rule, then implement it.", False),
    ("What does the Python walrus operator do?", False),
    ("Research the history of the four-minute mile and write it up with sources.", False),
    ("Make this paragraph sound less like ChatGPT wrote it.", False),
    ("Convert this CSV of signups into a bar chart by month.", False),
    ("I'm feeling unmotivated about my running goals; any tips?", False),
]
