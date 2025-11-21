"""Auxiliary tool pages: Mock Configuration, Format Editor, Incident Traceability."""

import streamlit as st
import pandas as pd
from pathlib import Path
from eval.mock_judge import get_mock_judge
from taxonomy.taxonomy import get_aircanada_mapping, load_eval_data


def render_auxiliary_tools_page():
    """Render the Auxiliary Tools page with tabs for Mock Configuration, Format Editor, and Incident Traceability."""
    st.title("🛠️ Auxiliary Tools")
    
    # Create tabs
    tab1, tab2, tab3 = st.tabs(["⚙️ Mock Configuration", "✏️ Format Editor", "🔗 Incident Traceability"])
    
    with tab1:
        render_mock_configuration()
    
    with tab2:
        render_format_editor()
    
    with tab3:
        render_incident_traceability()


def render_mock_configuration():
    """Render the Mock Configuration tab."""
    st.markdown("Configure mock responses for agent and judge when testing without OpenAI API.")
    
    # Agent Mock Configuration
    st.header("🤖 Agent Mock Responses")
    st.markdown("Set specific responses for user inputs, or use default response.")
    
    mock_agent = st.session_state.agent.get_mock_agent()
    if mock_agent is None:
        st.warning("Agent is not in mock mode. Enable 'Use Mock API Mode' in the sidebar.")
    else:
        # Default response
        default_response = st.text_area(
            "Default Agent Response",
            value=mock_agent.default_response,
            help="This response will be used when no specific mock is found"
        )
        if st.button("Update Default Response"):
            mock_agent.set_default_response(default_response)
            st.success("Default response updated!")
        
        st.divider()
        
        # Add new mock response
        st.subheader("Add Mock Response")
        col1, col2 = st.columns(2)
        with col1:
            new_user_input = st.text_input("User Input", key="new_user_input")
        with col2:
            new_agent_response = st.text_area("Agent Response", key="new_agent_response")
        
        if st.button("Add Mock Response"):
            if new_user_input and new_agent_response:
                mock_agent.set_mock_response(new_user_input, new_agent_response)
                st.success(f"Added mock response for: {new_user_input[:50]}...")
                st.rerun()
        
        st.divider()
        
        # List existing mock responses
        st.subheader("Existing Mock Responses")
        if mock_agent.mock_responses:
            for user_input, response in list(mock_agent.mock_responses.items())[:10]:  # Show first 10
                with st.expander(f"User: {user_input[:50]}..."):
                    st.write(f"**Response:** {response}")
                    if st.button("Delete", key=f"delete_{user_input}"):
                        del mock_agent.mock_responses[user_input]
                        st.rerun()
        else:
            st.info("No mock responses configured yet.")
        
        if st.button("Clear All Mock Responses"):
            mock_agent.clear_mock_responses()
            st.success("All mock responses cleared!")
            st.rerun()
    
    st.divider()
    
    # Judge Mock Configuration
    st.header("⚖️ Judge Mock Evaluations")
    st.markdown("Set specific evaluations for test cases, or use default evaluation.")
    
    mock_judge = get_mock_judge()
    
    # Randomization toggle
    st.subheader("Randomization Settings")
    use_randomization = st.checkbox(
        "Enable Randomization",
        value=mock_judge.use_randomization,
        help="When enabled, mock judge will cycle through different grades, severities, and reasonings automatically"
    )
    if use_randomization != mock_judge.use_randomization:
        mock_judge.set_randomization(use_randomization)
        st.success("Randomization " + ("enabled" if use_randomization else "disabled") + "!")
    
    if mock_judge.use_randomization:
        st.info("🔄 Randomization is ON - Mock judge will cycle through different evaluation options.")
        if st.button("Reset Randomization Index"):
            mock_judge.reset_randomization_index()
            st.success("Randomization index reset!")
    
    st.divider()
    
    # Default evaluation
    st.subheader("Default Evaluation")
    col1, col2, col3 = st.columns(3)
    with col1:
        default_grade = st.selectbox("Default Grade", ["Pass", "Fail"], key="default_grade", index=0 if mock_judge.default_grade.grade == "Pass" else 1)
    with col2:
        severity_options = ["P0", "P1", "P2", "P3", "P4", "Trivial"]
        default_severity_idx = severity_options.index(mock_judge.default_grade.severity) if mock_judge.default_grade.severity in severity_options else 5
        default_severity = st.selectbox("Default Severity", severity_options, key="default_severity", index=default_severity_idx)
    with col3:
        default_reasoning = st.text_area("Default Reasoning", key="default_reasoning", value=mock_judge.default_grade.reasoning)
    
    if st.button("Update Default Evaluation"):
        mock_judge.set_default_grade(default_grade, default_severity, default_reasoning)
        st.success("Default evaluation updated!")
    
    st.divider()
    
    # Add new mock evaluation
    st.subheader("Add Mock Evaluation")
    st.markdown("Create a mock evaluation for a specific test case.")
    
    col1, col2 = st.columns(2)
    with col1:
        eval_user_input = st.text_area("User Input (first 50 chars used as key)", key="eval_user_input")
        eval_grade = st.selectbox("Grade", ["Pass", "Fail"], key="eval_grade")
    with col2:
        eval_severity = st.selectbox("Severity", ["P0", "P1", "P2", "P3", "P4", "Trivial"], key="eval_severity")
        eval_reasoning = st.text_area("Reasoning", key="eval_reasoning")
        eval_notes = st.text_input("Notes (optional)", key="eval_notes")
    
    if st.button("Add Mock Evaluation"):
        if eval_user_input and eval_reasoning:
            mock_judge.set_mock_evaluation(
                eval_user_input[:50],
                eval_grade,
                eval_severity,
                eval_reasoning,
                eval_notes
            )
            st.success("Mock evaluation added!")
            st.rerun()
    
    st.divider()
    
    # List existing mock evaluations
    st.subheader("Existing Mock Evaluations")
    if mock_judge.mock_evaluations:
        for key, grade in list(mock_judge.mock_evaluations.items())[:10]:  # Show first 10
            with st.expander(f"Key: {key[:50]}..."):
                st.write(f"**Grade:** {grade.grade}")
                st.write(f"**Severity:** {grade.severity}")
                st.write(f"**Reasoning:** {grade.reasoning}")
                if grade.notes:
                    st.write(f"**Notes:** {grade.notes}")
                if st.button("Delete", key=f"delete_eval_{key}"):
                    del mock_judge.mock_evaluations[key]
                    st.rerun()
    else:
        st.info("No mock evaluations configured yet.")
    
    if st.button("Clear All Mock Evaluations"):
        mock_judge.clear_mock_evaluations()
        st.success("All mock evaluations cleared!")
        st.rerun()


def render_format_editor():
    """Render the Format Editor tab."""
    st.markdown("Edit rows that need 'User:' and 'Bot:' markers added to conversation format.")
    
    # File selection
    st.subheader("Select CSV File")
    
    # Find available CSV files
    processed_dir = Path("data/evals/processed")
    raw_dir = Path("data/evals/raw")
    
    csv_files = []
    if processed_dir.exists():
        csv_files.extend(list(processed_dir.glob("*.csv")))
    if raw_dir.exists():
        csv_files.extend(list(raw_dir.glob("*.csv")))
    
    if not csv_files:
        st.error("No CSV files found in data/evals/processed/ or data/evals/raw/")
        return
    
    # File selector
    csv_file_options = {str(f): f.name for f in sorted(csv_files)}
    selected_file = st.selectbox(
        "Choose CSV file to edit",
        options=list(csv_file_options.keys()),
        format_func=lambda x: csv_file_options[x],
        key="format_editor_file_selector"
    )
    
    selected_file_path = Path(selected_file)
    
    # Column selection (after file is selected)
    if selected_file_path.exists():
        try:
            preview_df = pd.read_csv(selected_file_path, nrows=5)
            available_columns = list(preview_df.columns)
            
            st.subheader("Column Configuration")
            col1, col2 = st.columns(2)
            
            with col1:
                # Conversation column selector
                conversation_col = st.selectbox(
                    "Conversation Column",
                    options=available_columns,
                    index=available_columns.index("Eval output (AcmeCo)") if "Eval output (AcmeCo)" in available_columns else 0,
                    help="Column containing conversation text that needs formatting"
                )
            
            with col2:
                # ID column selector (for merging back)
                id_col = st.selectbox(
                    "ID Column (for merging)",
                    options=["None"] + available_columns,
                    index=available_columns.index("Eval ID") + 1 if "Eval ID" in available_columns else 0,
                    help="Column used to identify rows when merging back (optional)"
                )
                id_col = None if id_col == "None" else id_col
            
            # Load options
            st.subheader("Load Options")
            col1, col2 = st.columns(2)
            
            with col1:
                if st.button("Load All Rows", type="primary"):
                    df = pd.read_csv(selected_file_path)
                    st.session_state.format_editor_df = df
                    st.session_state.format_editor_file = str(selected_file_path)
                    st.session_state.format_editor_conversation_col = conversation_col
                    st.session_state.format_editor_id_col = id_col
                    st.success(f"Loaded all {len(df)} rows from {selected_file_path.name}")
                    st.rerun()
            
            with col2:
                if st.button("Load Rows Needing Format"):
                    from eval.pipeline import is_conversation_format
                    df = pd.read_csv(selected_file_path)
                    rows_needing_fix = []
                    for idx, row in df.iterrows():
                        output = row.get(conversation_col, '')
                        if pd.notna(output) and not is_conversation_format(str(output)):
                            rows_needing_fix.append(idx)
                    
                    if rows_needing_fix:
                        df_filtered = df.iloc[rows_needing_fix].copy()
                        st.session_state.format_editor_df = df_filtered
                        st.session_state.format_editor_file = str(selected_file_path)
                        st.session_state.format_editor_conversation_col = conversation_col
                        st.session_state.format_editor_id_col = id_col
                        st.success(f"Found {len(df_filtered)} rows that need formatting")
                        st.rerun()
                    else:
                        st.info("No rows need formatting! All rows have proper conversation format.")
        
        except Exception as e:
            st.error(f"Error reading CSV file: {e}")
            return
    else:
        st.error(f"File not found: {selected_file_path}")
        return
    
    # Actions section
    if "format_editor_df" in st.session_state:
        st.divider()
        st.subheader("Actions")
        col1, col2 = st.columns(2)
        
        with col1:
            if st.button("Export to CSV"):
                output_filename = st.text_input(
                    "Export filename",
                    value="edited_rows_export.csv",
                    key="export_filename"
                )
                if output_filename:
                    output_path = Path("data/evals/processed") / output_filename
                    output_path.parent.mkdir(parents=True, exist_ok=True)
                    st.session_state.format_editor_df.to_csv(output_path, index=False)
                    st.success(f"✅ Exported to {output_path}")
                    with open(output_path, "rb") as f:
                        st.download_button(
                            label="Download CSV",
                            data=f.read(),
                            file_name=output_filename,
                            mime="text/csv"
                        )
        
        with col2:
            if st.button("Merge Back into Original File"):
                if "format_editor_file" in st.session_state:
                    original_file_path = Path(st.session_state.format_editor_file)
                    if original_file_path.exists():
                        edited_df = st.session_state.format_editor_df
                        main_df = pd.read_csv(original_file_path)
                        
                        # Get IDs that were edited (if ID column is specified)
                        id_col = st.session_state.get("format_editor_id_col")
                        if id_col and id_col in edited_df.columns and id_col in main_df.columns:
                            edited_ids = set(edited_df[id_col].values)
                            # Remove old versions
                            main_df = main_df[~main_df[id_col].isin(edited_ids)]
                            # Add edited rows
                            main_df = pd.concat([main_df, edited_df], ignore_index=True)
                            # Sort by ID if available
                            if id_col:
                                main_df = main_df.sort_values(id_col).reset_index(drop=True)
                        else:
                            # If no ID column, just replace the entire file
                            main_df = edited_df
                        
                        # Save
                        main_df.to_csv(original_file_path, index=False)
                        st.success(f"✅ Merged {len(edited_df)} rows back into {original_file_path.name}")
                        st.info(f"Total rows in file: {len(main_df)}")
                        
                        # Verify format
                        from eval.pipeline import is_conversation_format
                        conversation_col = st.session_state.get("format_editor_conversation_col", "Eval output (AcmeCo)")
                        format_check = []
                        for idx, row in main_df.iterrows():
                            output = row.get(conversation_col, '')
                            if pd.notna(output):
                                has_format = is_conversation_format(str(output))
                                format_check.append(has_format)
                        
                        if format_check:
                            with_format = sum(format_check)
                            without_format = len(format_check) - with_format
                            st.metric("Rows with format", with_format)
                            st.metric("Rows without format", without_format)
                    else:
                        st.error(f"Original file not found: {original_file_path}")
                else:
                    st.warning("No original file path stored. Load data first.")
    
    # Display editable table
    if "format_editor_df" in st.session_state:
        st.divider()
        st.subheader("Editable Table")
        conversation_col = st.session_state.get("format_editor_conversation_col", "Eval output (AcmeCo)")
        st.info(f"💡 **Instructions:** Edit the '{conversation_col}' column to add 'User:' and 'Bot:' markers. Changes are saved to session state.")
        
        df = st.session_state.format_editor_df.copy()
        
        # Show summary
        col1, col2, col3 = st.columns(3)
        with col1:
            st.metric("Total Rows", len(df))
        with col2:
            from eval.pipeline import is_conversation_format
            formatted_count = sum(1 for idx, row in df.iterrows() 
                                 if pd.notna(row.get(conversation_col, '')) 
                                 and is_conversation_format(str(row.get(conversation_col, ''))))
            st.metric("With Format", formatted_count)
        with col3:
            st.metric("Needs Format", len(df) - formatted_count)
        
        # Build column config dynamically
        column_config = {}
        for col in df.columns:
            if col == conversation_col:
                column_config[col] = st.column_config.TextColumn(
                    f"{col} - EDIT THIS",
                    width="large",
                    help="Add 'User:' and 'Bot:' markers to format as conversation"
                )
            elif col == st.session_state.get("format_editor_id_col"):
                column_config[col] = st.column_config.TextColumn(col, width="small")
            else:
                # Auto-size other columns
                if df[col].dtype == 'object':
                    column_config[col] = st.column_config.TextColumn(col, width="medium")
        
        # Editable data editor
        edited_df = st.data_editor(
            df,
            key="format_editor",
            num_rows="fixed",
            width='stretch',
            column_config=column_config,
            hide_index=True
        )
        
        # Update session state with edited data
        if not edited_df.equals(df):
            st.session_state.format_editor_df = edited_df
            st.rerun()
        
        # Show preview of first row's output
        if len(edited_df) > 0:
            st.divider()
            st.subheader("Preview")
            first_row = edited_df.iloc[0]
            id_col = st.session_state.get("format_editor_id_col")
            row_id = first_row.get(id_col, 'N/A') if id_col else 'Row 0'
            output = first_row.get(conversation_col, '')
            
            st.write(f"**Row ID:** {row_id}")
            st.text_area("Output Preview", str(output) if pd.notna(output) else "", height=200, key="preview_output")
            
            # Check if it has format
            from eval.pipeline import is_conversation_format
            if pd.notna(output):
                has_format = is_conversation_format(str(output))
                if has_format:
                    st.success("✓ This row has proper conversation format!")
                else:
                    st.warning("⚠️ This row still needs 'User:' and 'Bot:' markers")
    else:
        st.info("👆 Select a CSV file and click 'Load All Rows' or 'Load Rows Needing Format' to start editing.")


def render_incident_traceability():
    """Render the Incident Traceability tab."""
    st.markdown("Trace the AirCanada incident to comprehensive evals.")
    
    # Load mapping
    try:
        mapping = get_aircanada_mapping()
        
        # Incident details
        st.header("AirCanada Incident")
        incident = mapping.incident
        st.markdown(f"""
        **Name:** {incident.name}
        
        **Description:** {incident.description}
        
        **Harm Types:** {', '.join(incident.harm_types)}
        
        **Use Case:** {incident.use_case}
        
        **Failure Mode:** {incident.failure_mode}
        
        **Context:** {', '.join(incident.context)}
        """)
        
        # Mapping visualization
        st.header("Incident → Eval Mapping")
        
        col1, col2, col3 = st.columns(3)
        with col1:
            st.subheader("Categories")
            for cat in mapping.relevant_categories:
                st.write(f"• {cat}")
        
        with col2:
            st.subheader("Methodologies")
            for meth in mapping.relevant_methodologies[:5]:  # Show first 5
                st.write(f"• {meth}")
            if len(mapping.relevant_methodologies) > 5:
                st.write(f"... and {len(mapping.relevant_methodologies) - 5} more")
        
        with col3:
            st.subheader("Eval Coverage")
            st.metric("Related Evals", len(mapping.eval_ids))
        
        # Flow diagram (text-based)
        st.subheader("Traceability Flow")
        st.markdown(f"""
        ```
        AirCanada Incident
          ↓
        Harm: {', '.join(incident.harm_types)}
          ↓
        Failure Mode: {incident.failure_mode}
          ↓
        Categories: {', '.join(mapping.relevant_categories[:3])}
          ↓
        Methodologies: {len(mapping.relevant_methodologies)} attack patterns
          ↓
        Evals: {len(mapping.eval_ids)} test cases
        ```
        """)
        
        # Show sample evals
        if mapping.eval_ids:
            st.subheader("Sample Related Evals")
            single_turn, multi_turn = load_eval_data()
            all_evals = pd.concat([single_turn, multi_turn], ignore_index=True)
            
            sample_evals = all_evals[all_evals.get("Eval ID", "").isin(mapping.eval_ids[:5])]
            if not sample_evals.empty:
                st.dataframe(sample_evals[["Eval ID", "Tier A category", "Methodology"]].head(), width='stretch')
                
        
    except Exception as e:
        st.error(f"Error loading mapping: {e}")
        st.info("Make sure eval data files are available in data/evals/raw/")

