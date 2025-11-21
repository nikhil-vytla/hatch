# Multi-Turn Eval System (standardization for agents)

Demo of multi-turn eval pipeline and incident-to-eval taxonomy for (customer support) AI agents.

## Setup

1. Install dependencies using `uv`:
```bash
uv sync
```

2. Set up environment variables:
```bash
cp .env.example .env
# Edit .env and add your OPENAI_API_KEY
```

3. Run the Streamlit app:
```bash
# Option 1: Use uv run (recommended)
uv run streamlit run app.py

# Option 2: Activate the virtual environment first
source .venv/bin/activate
streamlit run app.py

# Option 3: Use the venv's streamlit directly
.venv/bin/streamlit run app.py
```

## Components

- **Agent**: Customer support chatbot with 2 tools (refund policy lookup, booking status check)
- **Eval Pipeline**: Multi-turn evaluation system with LLM judges
- **Taxonomy**: Incident-to-eval mapping system (AirCanada example)
- **UI**: Streamlit interface for chat, evals, and taxonomy exploration

## Usage

1. **Agent Chat**: Interact with the customer support agent
2. **Run Evals**: Execute eval pipeline on CSV data
3. **Eval Results**: View and filter eval results
5. **Taxonomy Generator & Explorer**: Generate and browse category hierarchy and methodologies

## References:
- [Snowglobe](https://snowglobe.so/) - fast sims for chatbots (mini rl envs)
    - Currently closed source, although I feel like it should be possible to make an open-source version (at least at toy scale).
- [Verifiers](https://github.com/PrimeIntellect-ai/verifiers) - rl envs + agent evals
  - [Read the Docs](https://verifiers.readthedocs.io/en/latest/overview.html)

## A spec + diagrams:
- [Gist MetaAgentEvalSystem.md](https://gist.github.com/nikhil-vytla/3094327b13a5212c1dd6c55e4ea4b127)

## Future Work:
- Need to build a common agent eval framework that customers/users of the agent standard who want to get certified can plug into.
  - Doing custom integrations for first few customers may be okay, but is not scalable (also not ideal given that some companies will rapidly iterate on agents, publishing an open-source standard for agents is key here)
- Also build agent XYZ to improve discovery and interpretability across N agent evaluation results
  - Agent XYZ should be able to handle queries like "which agent has the highest accuracy?", "which agent is the most reliable?", "which agent is susceptible to hallucinations?", "which agent is best at tool use?", "which agents successfully complete tasks?"
- Think about reporting -- how to best package results to different audiences (e.g. CISOs, DS, ENG)
  - Ex. CISOs rely heavily on SOC-2 style docs (PDFs) -- our agent XYZ could be useful to generate preferred reports for specific audiences (either templates/etc.), but we also want to build reports in a way that they easily link to verifiable artifacts.
    - Think of this as "linked observability/verifiability" -- artifacts could be dashboards, case study scenarios linked to production incidents that we've red-teamed, etc.
    - In SOC-2 world, you as the company effectively define the metrics and present evidence however you want - it feels like verification is no more than a binary signal with respect to revenue (do you have it? --> good, you can work with us. do you not? --> in the trash can)
    - In agentic world, it will be incredibly important to users that the benchmark itself cannot be gamed -- there are two sides here:
      - we need to make the testing harness robust and not exploitable (for agent vendors)
      - we need to make the generated taxonomy/evals useful (provide guidance to customers looking at agent standard (e.g.,MAES) results on best ways to create custom evals, ground them in real-world incidents to demonstrate trust)
      - we need to make evals dynamic while being open-source - static benchmarks risks possibility of being consumed by the ever-growing training/scraper engine <-- benchmark must not be in-distribution of agent training.
- It's vital to stay on top of the game with respect to understanding how agents interact with tools, how underlying models understand interaction, jailbreak/red-teaming attacks etc. (look at Anthropic Alignment Science for some info here)
- Also will be important to...