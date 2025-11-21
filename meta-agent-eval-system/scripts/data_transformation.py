"""Data transformation utilities for splitting eval data."""

import pandas as pd
from pathlib import Path
from eval.pipeline import is_conversation_format


def split_evals_round_3(input_csv: str, output_dir: str = "data/evals/processed"):
    """
    Split evals_round_3.csv into single-turn and multi-turn datasets.
    
    Args:
        input_csv: Path to evals_round_3.csv
        output_dir: Directory to save the split files
    
    Returns:
        Tuple of (single_turn_path, multi_turn_path)
    """
    # Create output directory
    Path(output_dir).mkdir(parents=True, exist_ok=True)
    
    # Load the data
    df = pd.read_csv(input_csv)
    
    # Identify single-turn and multi-turn rows
    single_turn_rows = []
    multi_turn_rows = []
    
    for idx, row in df.iterrows():
        user_input = row.get("Eval input (MAES)", "")
        eval_output = row.get("Eval output (AcmeCo)", "")
        
        # Check if input is blank (simple check - if blank, it's multi-turn)
        input_is_blank = pd.isna(user_input) or (isinstance(user_input, str) and not str(user_input).strip())
        
        if input_is_blank:
            # Multi-turn: blank input means it's a multi-turn conversation
            # Just keep the original row as-is
            multi_turn_rows.append(row)
        else:
            # Single-turn: has input
            single_turn_rows.append(row)
    
    # Create DataFrames
    single_turn_df = pd.DataFrame(single_turn_rows)
    multi_turn_df = pd.DataFrame(multi_turn_rows)
    
    # Save to CSV files with _proc suffix
    single_turn_path = f"{output_dir}/evals_round_3_single_turn_proc.csv"
    multi_turn_path = f"{output_dir}/evals_round_3_multi_turn_proc.csv"
    
    single_turn_df.to_csv(single_turn_path, index=False)
    multi_turn_df.to_csv(multi_turn_path, index=False)
    
    print(f"✅ Split complete!")
    print(f"   Single-turn: {len(single_turn_df)} rows → {single_turn_path}")
    print(f"   Multi-turn: {len(multi_turn_df)} rows → {multi_turn_path}")
    
    return single_turn_path, multi_turn_path


if __name__ == "__main__":
    split_evals_round_3("data/evals/raw/evals_round_3.csv")

