# Multi-Turn Eval Pipeline and Incident-to-Eval Taxonomy

This project delivers a working multi-turn evaluation pipeline for customer support AI agents and a taxonomy system that maps real-world incidents like the AirCanada chatbot misinformation case to comprehensive evaluation tests. The system enables business stakeholders to understand how specific incidents are covered by evaluation tests, drawing a clear line from business problems to comprehensive eval coverage.

The implementation includes a LangChain-based customer support agent with two tools (refund policy lookup and booking status check), an evaluation pipeline that executes multi-turn conversations and uses OpenAI's structured outputs for LLM-based judging, and a Streamlit UI that provides interactive exploration of agent interactions, eval results, and incident traceability. The taxonomy system maps the AirCanada incident—characterized by hallucination leading to financial loss and brand damage—to relevant evaluation categories, attack methodologies, and specific test cases, demonstrating how comprehensive evals address real-world risks.

Key components include: (1) a multi-turn eval pipeline that processes CSV data and evaluates agent responses using LLM judges with structured outputs, (2) an incident-to-eval taxonomy that connects the AirCanada incident to relevant categories (e.g., Misinformation, Policy Violation), methodologies (e.g., Semantic Drift, Context Flooding), and specific eval IDs, and (3) a Streamlit interface with five main views: agent chat, eval execution, results dashboard, incident traceability visualization, and taxonomy explorer. The system is built with extensibility in mind, using simple data structures that can be enhanced with database storage, additional incidents, and more sophisticated mapping logic.

- Built with LangChain for agent orchestration and OpenAI structured outputs for consistent grading
- Streamlit UI provides interactive exploration without requiring custom frontend development
- Taxonomy mapping demonstrates how the AirCanada incident connects to comprehensive eval coverage
- Framework is extensible for additional incidents and more sophisticated evaluation scenarios

