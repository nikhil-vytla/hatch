"""Multi-turn eval pipeline."""

import pandas as pd
import json
from typing import List, Dict, Any, Optional
from agent.chatbot import CustomerSupportAgent
from eval.judge import evaluate_response
from typing import Optional as TypingOptional


def parse_conversation(conversation_text: str) -> List[Dict[str, str]]:
    """
    Parse conversation text into structured turns.
    
    Format: "User: ... Bot: ... User: ... Bot: ..."
    Also handles format with newlines between messages.
    """
    turns = []
    lines = conversation_text.split("\n")
    current_role = None
    current_content = []
    
    for line in lines:
        line = line.strip()
        if not line:
            continue
        
        if line.startswith("User:"):
            if current_role:
                turns.append({"role": current_role, "content": "\n".join(current_content).strip()})
            current_role = "user"
            current_content = [line.replace("User:", "").strip()]
        elif line.startswith("Bot:"):
            if current_role:
                turns.append({"role": current_role, "content": "\n".join(current_content).strip()})
            current_role = "assistant"
            current_content = [line.replace("Bot:", "").strip()]
        else:
            if current_content:
                current_content.append(line)
    
    if current_role:
        turns.append({"role": current_role, "content": "\n".join(current_content).strip()})
    
    return turns


def is_conversation_format(text: str) -> bool:
    """
    Check if text looks like a conversation format (User:/Bot: pattern).
    
    Args:
        text: Text to check
    
    Returns:
        True if text appears to be a conversation format
    """
    if pd.isna(text) or not text:
        return False
    
    text_str = str(text)
    # Check if it contains User: or Bot: patterns
    has_user = "User:" in text_str
    has_bot = "Bot:" in text_str
    
    return has_user or has_bot


def run_single_turn_eval(
    agent: CustomerSupportAgent,
    user_input: str,
    methodology: str,
    category: str,
    tier_a: str,
    tier_b: str,
    tier_c: str,
    eval_id: str,
    use_mock_judge: TypingOptional[bool] = None,
    use_replayed_agent_responses: bool = False,
    expected_output: Optional[str] = None
) -> Dict[str, Any]:
    """
    Run a single-turn evaluation.
    
    Args:
        use_replayed_agent_responses: If True, use expected_output from dataset when available.
            If False, generate new response with the current agent.
        expected_output: The expected agent response from the dataset (used when replay mode is enabled).
    """
    agent.reset()
    
    # Check if we should use replayed response
    has_expected_output = expected_output is not None and str(expected_output).strip()
    use_replay = use_replayed_agent_responses and has_expected_output
    
    if use_replay:
        # Use expected output from dataset
        agent_response = str(expected_output).strip()
        
        # Create a minimal trajectory for replayed responses
        trajectory = {
            "user_input": user_input,
            "agent_reasoning": None,
            "tool_calls": [],
            "response": agent_response
        }
    else:
        # Generate new response with current agent
        result = agent.chat(user_input, return_trajectory=True)
        if isinstance(result, tuple):
            agent_response, trajectory = result
        else:
            agent_response = result
            trajectory = {
                "user_input": user_input,
                "agent_reasoning": None,
                "tool_calls": [],
                "response": agent_response
            }
    
    # Extract tool calls for easy filtering
    tool_calls = trajectory.get("tool_calls", [])
    
    # Evaluate with judge
    grade = evaluate_response(
        user_input=user_input,
        agent_response=agent_response,
        methodology=methodology,
        category=tier_a,
        conversation_history=None,
        trajectory=trajectory,
        use_mock=use_mock_judge
    )
    
    return {
        "eval_id": eval_id,
        "tier_a": tier_a,
        "tier_b": tier_b,
        "tier_c": tier_c,
        "methodology": methodology,
        "user_input": user_input,
        "agent_response": agent_response,
        "grade": grade.grade,
        "severity": grade.severity,
        "reasoning": grade.reasoning,
        "notes": grade.notes,
        "turns": 1,
        "trajectory": trajectory,
        "tool_calls": tool_calls,
        "used_replayed_responses": use_replay,  # Flag indicating if replayed response was used
    }


def run_multi_turn_eval(
    agent: CustomerSupportAgent,
    conversation_text: str,
    methodology: str,
    category: str,
    tier_a: str,
    tier_b: str,
    tier_c: str,
    eval_id: str,
    use_mock_judge: TypingOptional[bool] = None,
    use_replayed_agent_responses: bool = False
) -> Dict[str, Any]:
    """
    Run a multi-turn evaluation.
    
    Args:
        use_replayed_agent_responses: If True, use original Bot responses from dataset when available.
            If False, generate new responses with the current agent.
    """
    agent.reset()
    
    # Parse conversation
    turns = parse_conversation(conversation_text)
    
    if not turns:
        # Check if it's just plain text without User:/Bot: markers
        # In this case, treat it as a single user message (fallback for malformed data)
        if conversation_text and conversation_text.strip():
            # Treat the entire text as a single user turn
            turns = [{"role": "user", "content": conversation_text.strip()}]
        else:
            raise ValueError(f"No conversation turns found in conversation text. Text: {conversation_text[:100]}...")
    
    # Check if we have Bot responses in the dataset
    has_original_responses = any(turn["role"] == "assistant" for turn in turns)
    use_replay = use_replayed_agent_responses and has_original_responses
    
    # Execute conversation and capture trajectories
    conversation_history = []
    trajectories = []  # Store trajectory for each turn
    all_tool_calls = []  # Aggregate all tool calls
    
    # Track which responses were replayed vs generated
    replayed_responses = []
    
    i = 0
    while i < len(turns):
        turn = turns[i]
        
        if turn["role"] == "user":
            user_input = turn["content"]
            conversation_history.append({"role": "user", "content": user_input})
            
            # Check if next turn is an assistant response we should use
            if use_replay and i + 1 < len(turns) and turns[i + 1]["role"] == "assistant":
                # Use original Bot response from dataset
                response = turns[i + 1]["content"]
                replayed_responses.append(True)
                
                # Create a minimal trajectory for replayed responses
                trajectory = {
                    "user_input": user_input,
                    "agent_reasoning": None,
                    "tool_calls": [],
                    "response": response
                }
                trajectories.append(trajectory)
                
                # Update agent's conversation history for context (but don't execute)
                agent.conversation_history.append({"role": "user", "content": user_input})
                agent.conversation_history.append({"role": "assistant", "content": response})
                
                conversation_history.append({"role": "assistant", "content": response})
                
                # Skip the assistant turn since we've processed it
                i += 2
            else:
                # Generate new response with current agent
                result = agent.chat(user_input, return_trajectory=True)
                if isinstance(result, tuple):
                    response, trajectory = result
                else:
                    response = result
                    trajectory = {
                        "user_input": user_input,
                        "agent_reasoning": None,
                        "tool_calls": [],
                        "response": response
                    }
                
                trajectories.append(trajectory)
                all_tool_calls.extend(trajectory.get("tool_calls", []))
                replayed_responses.append(False)
                
                conversation_history.append({"role": "assistant", "content": response})
                i += 1
        else:
            # Skip assistant turns that weren't paired with a user turn
            i += 1
    
    # Get final response (last assistant message)
    final_response = conversation_history[-1]["content"] if conversation_history else ""
    final_trajectory = trajectories[-1] if trajectories else None
    
    if len(conversation_history) >= 2:
        final_user_input = conversation_history[-2]["content"]
    elif turns and len(turns) > 0:
        # Get first user turn if available
        user_turns = [t for t in turns if t["role"] == "user"]
        final_user_input = user_turns[0]["content"] if user_turns else ""
    else:
        final_user_input = ""
    
    # Evaluate with judge (pass final trajectory)
    grade = evaluate_response(
        user_input=final_user_input,
        agent_response=final_response,
        methodology=methodology,
        category=tier_a,
        conversation_history=conversation_history[:-2] if len(conversation_history) >= 2 else None,  # All but the last exchange
        trajectory=final_trajectory,
        use_mock=use_mock_judge
    )
    
    return {
        "eval_id": eval_id,
        "tier_a": tier_a,
        "tier_b": tier_b,
        "tier_c": tier_c,
        "methodology": methodology,
        "conversation": conversation_text,
        "agent_responses": [msg["content"] for msg in conversation_history if msg["role"] == "assistant"],
        "final_response": final_response,
        "grade": grade.grade,
        "severity": grade.severity,
        "reasoning": grade.reasoning,
        "notes": grade.notes,
        "turns": len([t for t in turns if t["role"] == "user"]),
        "trajectory": final_trajectory,  # Final turn trajectory
        "trajectories": trajectories,  # All turn trajectories
        "tool_calls": all_tool_calls,  # All tool calls across all turns
        "used_replayed_responses": use_replay,  # Flag indicating if replayed responses were used
        "replayed_responses": replayed_responses,  # List of booleans indicating which responses were replayed
    }


def load_evals_from_csv(csv_path: str, multi_turn: bool = False) -> pd.DataFrame:
    """Load eval data from CSV."""
    df = pd.read_csv(csv_path)
    return df


def run_eval_pipeline(
    csv_path: str,
    multi_turn: bool = False,
    limit: Optional[int] = None,
    use_mock_agent: TypingOptional[bool] = None,
    use_mock_judge: TypingOptional[bool] = None,
    input_column: Optional[str] = None,
    output_column: Optional[str] = None,
    conversation_column: Optional[str] = None,
    column_mapping: Optional[Any] = None,  # DatasetColumnMapping from taxonomy_generator
    use_replayed_agent_responses: bool = False
) -> List[Dict[str, Any]]:
    """
    Run eval pipeline on CSV data.
    
    Args:
        csv_path: Path to CSV file with eval data
        multi_turn: Whether this is multi-turn eval data
        limit: Optional limit on number of evals to run
        input_column: Column name for user input (single-turn only)
        output_column: Column name for agent output (single-turn only)
        conversation_column: Column name for conversation text (multi-turn only)
    
    Returns:
        List of eval results
    """
    agent = CustomerSupportAgent(use_mock=use_mock_agent)
    df = load_evals_from_csv(csv_path, multi_turn)
    
    if limit:
        df = df.head(limit)
    
    results = []
    errors = []
    
    for idx, row in df.iterrows():
        try:
            # Check for required fields
            if multi_turn:
                # Get conversation text from specified column
                if not conversation_column:
                    errors.append(f"Eval {idx}: conversation_column must be specified for multi-turn evals")
                    continue
                
                conversation_text = row.get(conversation_column, "")
                
                if pd.isna(conversation_text) or (isinstance(conversation_text, str) and not str(conversation_text).strip()):
                    errors.append(f"Eval {idx}: Missing conversation text in column '{conversation_column}'")
                    continue
                
                # Get taxonomy columns using mapping or defaults
                if column_mapping:
                    methodology_col = column_mapping.methodology_column or "Methodology"
                    tier_a_col = column_mapping.tier_a_column
                    tier_b_col = column_mapping.tier_b_column or "Tier B category"
                    tier_c_col = column_mapping.tier_c_column or "Tier C category"
                else:
                    methodology_col = "Methodology"
                    tier_a_col = "Tier A category"
                    tier_b_col = "Tier B category"
                    tier_c_col = "Tier C category"
                
                # Multi-turn eval
                result = run_multi_turn_eval(
                    agent=agent,
                    conversation_text=str(conversation_text),
                    methodology=row.get(methodology_col, ""),
                    category=row.get(tier_a_col, ""),
                    tier_a=row.get(tier_a_col, ""),
                    tier_b=row.get(tier_b_col, ""),
                    tier_c=row.get(tier_c_col, ""),
                    eval_id=row.get("Eval ID", f"E{idx}"),
                    use_mock_judge=use_mock_judge,
                    use_replayed_agent_responses=use_replayed_agent_responses
                )
            else:
                # Single-turn: get input and output from specified columns
                if not input_column or not output_column:
                    errors.append(f"Eval {idx}: input_column and output_column must be specified for single-turn evals")
                    continue
                
                user_input = row.get(input_column, "")
                eval_output = row.get(output_column, "")
                
                # Get taxonomy columns using mapping or defaults
                if column_mapping:
                    methodology_col = column_mapping.methodology_column or "Methodology"
                    tier_a_col = column_mapping.tier_a_column
                    tier_b_col = column_mapping.tier_b_column or "Tier B category"
                    tier_c_col = column_mapping.tier_c_column or "Tier C category"
                else:
                    methodology_col = "Methodology"
                    tier_a_col = "Tier A category"
                    tier_b_col = "Tier B category"
                    tier_c_col = "Tier C category"
                
                # Check if input is blank but output contains conversation format
                # This handles cases where multi-turn conversations are in the output field
                input_is_blank = pd.isna(user_input) or (isinstance(user_input, str) and not str(user_input).strip())
                output_is_conversation = is_conversation_format(eval_output)
                
                if input_is_blank and output_is_conversation:
                    # Treat as multi-turn conversation from output field
                    result = run_multi_turn_eval(
                        agent=agent,
                        conversation_text=str(eval_output),
                        methodology=row.get(methodology_col, ""),
                        category=row.get(tier_a_col, ""),
                        tier_a=row.get(tier_a_col, ""),
                        tier_b=row.get(tier_b_col, ""),
                        tier_c=row.get(tier_c_col, ""),
                        eval_id=row.get("Eval ID", f"E{idx}"),
                        use_mock_judge=use_mock_judge,
                        use_replayed_agent_responses=use_replayed_agent_responses
                    )
                elif input_is_blank:
                    errors.append(f"Eval {idx}: Missing user input in column '{input_column}' and no conversation format in output")
                    continue
                else:
                    # Single-turn eval
                    result = run_single_turn_eval(
                        agent=agent,
                        user_input=str(user_input),
                        methodology=row.get(methodology_col, ""),
                        category=row.get(tier_a_col, ""),
                        tier_a=row.get(tier_a_col, ""),
                        tier_b=row.get(tier_b_col, ""),
                        tier_c=row.get(tier_c_col, ""),
                        eval_id=row.get("Eval ID", f"E{idx}"),
                        use_mock_judge=use_mock_judge,
                        use_replayed_agent_responses=use_replayed_agent_responses,
                        expected_output=str(eval_output) if not pd.isna(eval_output) else None
                    )
            
            results.append(result)
        except Exception as e:
            error_msg = f"Eval {idx} (ID: {row.get('Eval ID', 'Unknown')}): {str(e)}"
            errors.append(error_msg)
            print(f"Error processing {error_msg}")
            continue
    
    # Store errors in results metadata if needed
    if errors:
        print(f"\nTotal errors: {len(errors)} out of {len(df)} evals")
        for error in errors[:10]:  # Show first 10 errors
            print(f"  - {error}")
        if len(errors) > 10:
            print(f"  ... and {len(errors) - 10} more errors")
    
    return results


def save_results(results: List[Dict[str, Any]], output_path: str):
    """Save eval results to JSON file."""
    with open(output_path, "w") as f:
        json.dump(results, f, indent=2)

