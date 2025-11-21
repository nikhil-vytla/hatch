# Development Notes

## Project Setup
- Created project structure with `agent/`, `eval/`, `taxonomy/`, `ui/`, and `scripts/` directories
- Set up `pyproject.toml` with dependencies: langchain, openai, streamlit, pandas, pydantic, python-dotenv
- Using `uv` for package management
- Data organized into `data/evals/raw/`, `data/evals/processed/`, `data/taxonomies/`, and `data/threads/`

## Agent Implementation
- Built customer support agent using LangChain v1.0+ with OpenAI
- Created 2 tools:
  1. `lookup_refund_policy` - Returns refund policy information based on booking tier
  2. `check_booking_status` - Returns booking details by reference number
- Mock data includes standard, premium, and basic booking tiers with different refund policies
- Agent maintains conversation history for multi-turn interactions
- **Trajectory Capture**: Agent now captures execution trajectory including:
  - User input
  - Agent reasoning (when available from LangChain)
  - Tool calls with inputs and outputs
  - Final response
- Supports both real OpenAI API and mock mode for testing without API keys
- **Mock Agent** (`MockCustomerSupportAgent`):
  - Manual response configuration via `set_mock_response()`
  - Default response fallback
  - Mock tool calls support
  - Trajectory generation for mock responses
  - Conversation history management

## Eval Pipeline
- Implemented multi-turn eval pipeline that:
  - Loads eval data from CSV files
  - Executes conversations with the agent
  - Uses LLM judge (OpenAI with structured outputs) to evaluate responses
  - Supports both single-turn and multi-turn evals
  - Captures and stores trajectory information for each turn
- **Core Functions**:
  - `parse_conversation()`: Parses User:/Bot: formatted text into structured turns
  - `is_conversation_format()`: Detects if text contains conversation markers
  - `run_single_turn_eval()`: Executes single-turn evaluation with trajectory capture
  - `run_multi_turn_eval()`: Executes multi-turn evaluation, processes all turns sequentially
  - `run_eval_pipeline()`: Main pipeline orchestrator with configurable column mappings
  - `save_results()`: Saves eval results to JSON file
- LLM judge uses structured output format with:
  - Grade: Pass/Fail
  - Severity: P0-P4 or Trivial
  - Reasoning and notes
- **Judge Prompt Logic**:
  - For multi-turn: Explicitly instructs to evaluate ENTIRE conversation trajectory
  - Includes conversation history in context when available
  - Incorporates trajectory information (tool calls) when available
  - Different evaluation instructions for single-turn vs multi-turn
- Conversation parsing handles multi-turn format from CSV data (User:/Bot: markers)
- **Replay Mode**: Added `use_replayed_agent_responses` parameter for both single-turn and multi-turn evals:
  - **Multi-turn evals**: When enabled, uses original Bot responses from dataset instead of generating new ones
  - **Single-turn evals**: When enabled and output column is provided, uses the response from the output column instead of generating a new one
  - Useful for evaluating historical conversations/responses or responses from different agents/systems
  - When disabled, generates new responses with current agent (default behavior)
  - Tracks which responses were replayed vs generated in result metadata (`used_replayed_responses` flag)
  - Single-turn replay mode requires an output column to be selected in the UI
- **Configurable Column Mapping**: Supports custom column mappings for taxonomy fields (Tier A/B/C, Methodology)
- Auto-detects multi-turn conversations when input column is blank and output contains conversation format
- **Mock Judge** (`MockJudge`):
  - Manual evaluation configuration via `set_mock_evaluation()`
  - Default evaluation fallback
  - **Randomization Mode**: Cycles through predefined grades, severities, and reasonings
  - Supports trajectory parameter for API compatibility
  - Global singleton instance via `get_mock_judge()`

## Taxonomy System
- **Incident-to-Eval Mapping**: Created incident-to-eval mapping system
  - Defined AirCanada incident with:
    - Harm types: Financial loss, Brand damage
    - Use case: Customer support
    - Failure mode: Hallucination
  - Mapping logic:
    - Incident → Categories (based on harm types and failure modes)
    - Categories → Methodologies (attack patterns)
    - Methodologies → Eval IDs (specific test cases)
  - System is extensible for additional incidents

- **LLM-based Taxonomy Generation**: 
  - `generate_taxonomy()`: Generates taxonomy structure (Tier A categories, subcategories, methodologies) from natural language agent description
  - Uses OpenAI structured outputs to create `GeneratedTaxonomy` objects
  - Supports mock mode for testing without API keys

- **Dataset Taxonomy Extraction**:
  - `extract_taxonomy_from_dataset()`: Extracts taxonomy structure from CSV datasets
  - `extract_methodologies_from_dataset()`: Extracts methodologies from CSV datasets
  - Configurable column mappings via `DatasetColumnMapping` dataclass
  - Optional LLM-generated descriptions (can skip for faster extraction)
  - Descriptions are optional to avoid redundancy when extracting from datasets

- **Conversation Analysis**:
  - Two-step process implemented:
    1. **Classification**: `classify_conversation()` - Classifies user intent, methodology, and risk categories (Tier A/B/C)
    2. **Severity Assessment**: Uses existing `evaluate_response()` judge to assess severity
  - `analyze_conversation_with_severity()`: Orchestrates both steps
  - Includes "No explicit methodology" and "No explicit category" options

- **Taxonomy Persistence**:
  - Taxonomies saved to `data/taxonomies/generated/` and `data/taxonomies/from_dataset/`
  - Auto-generates unique identifiers with timestamps
  - `save_taxonomy()`, `load_taxonomies()`, `delete_taxonomy()` utility functions
  - Taxonomies persist across sessions and can be explored/deleted from UI

## Metrics System
- **`calculate_severity_metrics()`**: Calculates severity distribution (PASS, P0-P4, Trivial) with counts and percentages
- **`calculate_category_incidents()`**: Counts incidents by Tier A category for specified minimum severity (P2 or P3)
- **`calculate_category_pass_rates()`**: Calculates pass rates by category and subcategory (Tier A/B/C)
- **`calculate_methodology_pass_rates()`**: Calculates pass rates by methodology
- **`calculate_round_comparison()`**: Optional round-based comparison if round information available
- All metrics return pandas DataFrames for easy visualization
- Handles edge cases (empty results, missing data) gracefully

## Streamlit UI Architecture
- **Modular Design**: Split large `app.py` into focused modules:
  - `ui/app_live_evals.py` - Live evaluations (Agent Chat, Run Live Eval, Live Eval Results)
  - `ui/app_batch_evals.py` - Batch evaluations (Run Evals, Eval Results, Metrics Dashboard)
  - `ui/app_taxonomy.py` - Taxonomy generation and exploration
  - `ui/app_auxiliary.py` - Auxiliary tools (Mock Configuration, Format Editor, Incident Traceability)
  - `ui/app_utils.py` - Shared utilities (thread management, taxonomy persistence, eval results loading)
  - `app.py` - Main entry point with sidebar navigation and routing
- **Sidebar Navigation**: Button-based navigation organized into sections:
  - Live Evaluations
  - Batch Evaluations
  - Taxonomy (Generator and Explorer)
  - Auxiliary Tools
- **Session State Management**: Tracks mock mode, eval results, threads, current page, and last section

- **Live Evaluations** (3 tabs):
  1. **Agent Chat** - Interactive chat interface with persistent thread management
  2. **Run Live Eval** - Evaluate conversations in real-time with manual configuration
  3. **Live Eval Results** - View and filter live evaluation results separately from batch results

- **Batch Evaluations** (3 tabs):
  1. **Run Evals** - Execute eval pipeline on CSV data with configurable columns and replay mode
  2. **Eval Results** - View and filter batch evaluation results
  3. **Metrics Dashboard** - Comprehensive metrics including:
     - Severity distribution charts
     - Category incident counts
     - Pass rates by category
     - Pass rates by methodology

- **Taxonomy** (2 pages):
  1. **Taxonomy Generator** - Generate taxonomies from descriptions or extract from datasets, analyze conversations
  2. **Taxonomy Explorer** - Explore persisted taxonomies, view hierarchy, delete taxonomies

- **Auxiliary Tools** (3 tabs):
  1. **Mock Configuration** - Configure mock agent responses and judge evaluations
  2. **Format Editor** - Edit CSV files to add User:/Bot: markers, supports any CSV with configurable columns
  3. **Incident Traceability** - Show AirCanada incident → evals mapping

## Thread Management
- Persistent thread management for live conversations
- UUID-based thread IDs to avoid naming collisions
- Threads saved to `data/threads/threads.json`
- Each thread maintains its own conversation history
- Can create, switch, delete, and clear threads
- Thread history persists across app reruns

## Data Organization
- **Raw Data**: `data/evals/raw/` - Original CSV files
  - `evals_round_1_and_2.csv`
  - `evals_round_3.csv`
  - `multi_turn_evals_round_3.csv`
- **Processed Data**: `data/evals/processed/` - Split single-turn and multi-turn datasets
  - `evals_round_3_single_turn_proc.csv` - Single-turn evals (1455 rows)
  - `evals_round_3_multi_turn_proc.csv` - Multi-turn evals (25 rows)
  - Helper files for format editing
- **Results**: `data/evals/results.json` - Batch evaluation results (JSON format)
- **Taxonomies**: 
  - `data/taxonomies/generated/` - LLM-generated taxonomies
  - `data/taxonomies/from_dataset/` - Extracted taxonomies from datasets
  - Both use timestamp + UUID identifier format
- **Threads**: `data/threads/threads.json` - Conversation threads with UUID-based IDs

## Scripts
- **`scripts/data_transformation.py`**:
  - `split_evals_round_3()`: Splits `evals_round_3.csv` into single-turn and multi-turn based on blank input column
  - Simple logic: if "Eval input" is blank, it's multi-turn
- **`scripts/merge_fixed_rows.py`**: Utility to merge manually fixed rows back into main multi-turn CSV

## Key Design Decisions
- Used LangChain v1.0+ for agent orchestration (migrated from earlier API)
- OpenAI structured outputs for LLM judge (ensures consistent grading format)
- Streamlit for UI (fast to build, good for demos)
- Simple data structures (dataclasses, JSON) - extensible to database later
- Mock data focused on customer support scenarios (refunds, bookings)
- **Trajectory Information**: Captured for richer evaluation context, especially tool usage
- **Two-Step Analysis**: Separated classification from severity assessment to reduce duplication
- **Optional Descriptions**: Taxonomy descriptions are optional to avoid redundancy when extracting from datasets
- **Replay Mode**: Allows evaluating original conversations vs. testing current agent behavior
- **Mock System**: Comprehensive mock support for agent, judge, and taxonomy generation to enable testing without API keys
- **UUID-based Threads**: Prevents naming collisions and enables unique thread identification
- **Tabbed Interface**: Consolidated related functionality into tabs for better UX and navigation
- **Separate Live/Batch Results**: Live eval results stored separately from batch results to avoid mixing

## Testing Approach
- Agent handles multi-turn conversations with trajectory capture
- Eval pipeline processes both single-turn and multi-turn CSV formats
- Supports replay mode for historical conversation evaluation
- Taxonomy mapping connects AirCanada incident to relevant evals
- LLM-based taxonomy generation and dataset extraction
- UI provides interactive exploration of results, taxonomy, and live conversations
- **Mock mode available for all components**:
  - Agent: `MockCustomerSupportAgent` with configurable responses
  - Judge: `MockJudge` with manual evaluations and randomization
  - Taxonomy Generation: Mock taxonomy generation without LLM calls
- **Randomization**: Mock judge can cycle through different grades/severities/reasonings for varied testing
- **Environment Variable Loading**: Uses `python-dotenv` to load `.env` file for API keys

## Recent Improvements
- **Modular UI**: Split monolithic `app.py` into focused, maintainable modules
- **Tabbed Interface**: Consolidated related pages into tabs for better UX
- **Taxonomy Persistence**: Taxonomies now persist across sessions
- **Format Editor Enhancement**: Can now select and edit any CSV file with configurable columns
- **Replay Mode**: Added ability to use original Bot responses from datasets
- **Trajectory Integration**: Full trajectory information captured and used in evaluations
- **Metrics Dashboard**: Comprehensive visualization of eval results
- **Thread Management**: Persistent, UUID-based thread system for live conversations

## Next Steps / Extensibility
- Could add more incidents beyond AirCanada
- Could enhance taxonomy with more sophisticated mapping logic
- Could add database storage for eval results and taxonomies
- Could add more sophisticated visualizations (Sankey diagrams, etc.)
- Could add batch processing for large eval sets
- Could add export functionality for results (partially implemented)
- Could add trajectory visualization in UI
- Could add comparison mode for different agent versions

## Taxonomy Visualization Sketch
- **Created `docs/TAXONOMY_VISUALIZATION.md`**: Comprehensive sketch of how to situate incidents into a broader taxonomy
- **Flow Structure**: Business Problem → Incident Analysis → Taxonomy Mapping → Eval Coverage → Product Presentation
- **Key Components**:
  - Mermaid diagram showing conceptual flow from customer concern to confidence
  - Three-tier taxonomy structure (Tier A/B/C categories)
  - Incident-to-eval mapping logic
  - Product presentation design for Customer Support leader
  - Interactive taxonomy explorer concept
  - Narrative flow: Incident → Safeguards → Tests → Results
- **Design Principles**: Start with business problem, show clear line from incident to evals, be specific with examples, show comprehensive coverage, be transparent about gaps
- **Target Audience**: Head of Customer Experience at Fortune 1000 company (not airline)
- **Visual Hierarchy**: Narrative flow cards → Interactive taxonomy explorer → Metrics dashboard → Trust signals
- **Future**: Could be converted to Excalidraw for more detailed visual design
