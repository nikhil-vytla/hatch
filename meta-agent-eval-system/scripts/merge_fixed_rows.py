"""Script to merge fixed rows back into the main multi-turn file."""

import pandas as pd
from pathlib import Path

def merge_fixed_rows():
    """Merge the fixed rows back into evals_round_3_multi_turn_proc.csv"""
    
    # Load the fixed rows
    fixed_path = "data/processed/rows_to_fix_format.csv"
    if not Path(fixed_path).exists():
        print(f"Error: {fixed_path} not found. Please edit the file first.")
        return
    
    fixed_df = pd.read_csv(fixed_path)
    print(f"Loaded {len(fixed_df)} fixed rows from {fixed_path}")
    
    # Load the main multi-turn file
    main_path = "data/processed/evals_round_3_multi_turn_proc.csv"
    main_df = pd.read_csv(main_path)
    print(f"Loaded {len(main_df)} rows from {main_path}")
    
    # Get the eval IDs that were fixed
    fixed_ids = set(fixed_df['Eval ID'].values)
    
    # Remove the old versions of these rows from main file
    main_df = main_df[~main_df['Eval ID'].isin(fixed_ids)]
    print(f"Removed {len(main_df)} rows (after removing old versions)")
    
    # Add the fixed rows
    main_df = pd.concat([main_df, fixed_df], ignore_index=True)
    
    # Sort by Eval ID to keep it organized
    main_df = main_df.sort_values('Eval ID').reset_index(drop=True)
    
    # Save back
    main_df.to_csv(main_path, index=False)
    print(f"✅ Merged {len(fixed_df)} fixed rows back into {main_path}")
    print(f"   Total rows in main file: {len(main_df)}")
    
    # Verify the format
    from eval.pipeline import is_conversation_format
    format_check = []
    for idx, row in main_df.iterrows():
        output = row.get('Eval output (AcmeCo)', '')
        if pd.notna(output):
            has_format = is_conversation_format(output)
            format_check.append(has_format)
    
    with_format = sum(format_check)
    without_format = len(format_check) - with_format
    
    print(f"\nFormat check:")
    print(f"  Rows WITH conversation format: {with_format}")
    print(f"  Rows WITHOUT conversation format: {without_format}")
    
    if without_format > 0:
        print(f"\n⚠️  Warning: {without_format} rows still don't have conversation format!")
        missing_ids = main_df[~pd.Series(format_check)]['Eval ID'].values
        print(f"   Eval IDs: {', '.join(missing_ids)}")


if __name__ == "__main__":
    merge_fixed_rows()

