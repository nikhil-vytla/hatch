"""Batch evaluation pages: Run Evals, Eval Results, Metrics Dashboard."""

import streamlit as st
import pandas as pd
from pathlib import Path
from eval.pipeline import run_eval_pipeline, save_results
from eval.metrics import (
    calculate_severity_metrics,
    calculate_category_incidents,
    calculate_category_pass_rates,
    calculate_methodology_pass_rates
)
from taxonomy.taxonomy_generator import (
    DatasetColumnMapping,
    extract_taxonomy_from_dataset,
    extract_methodologies_from_dataset
)


def render_batch_evals_page(use_mock: bool):
    """Render the Batch Evals page with tabs for Run Evals, Eval Results, and Metrics Dashboard."""
    st.title("📊 Batch Evaluations")
    
    # Create tabs
    tab1, tab2, tab3 = st.tabs(["🧪 Run Evals", "📋 Eval Results", "📈 Metrics Dashboard"])
    
    with tab1:
        render_run_evals(use_mock)
    
    with tab2:
        render_eval_results()
    
    with tab3:
        render_metrics_dashboard()


def render_run_evals(use_mock: bool):
    """Render the Run Evals tab."""
    st.markdown("Execute eval pipeline on test data.")
    
    col1, col2 = st.columns(2)
    
    with col1:
        eval_type = st.selectbox(
            "Eval Type", 
            ["Single-turn", "Multi-turn"],
            help="Single-turn: Processes all evals, auto-detects multi-turn conversations. Multi-turn: Only processes rows with conversation format."
        )
        csv_file = st.selectbox(
            "CSV File",
            [
                "data/evals/processed/evals_round_3_single_turn_proc.csv",
                "data/evals/processed/evals_round_3_multi_turn_proc.csv",
                "data/evals/raw/evals_round_3.csv",
                "data/evals/raw/multi_turn_evals_round_3.csv",
                "data/evals/raw/evals_round_1_and_2.csv"
            ],
            index=0,
            help="Use processed files (recommended) or raw files"
        )
        limit = st.number_input("Limit (0 for all)", min_value=0, value=5, step=1)
        
        # Column selection based on eval type
        st.divider()
        st.subheader("Column Configuration")
        
        # Load CSV to get available columns
        try:
            df_preview = pd.read_csv(csv_file, nrows=1)
            available_columns = list(df_preview.columns)
        except Exception as e:
            st.error(f"Error reading CSV: {e}")
            available_columns = []
        
        # Taxonomy column mapping configuration
        st.divider()
        st.subheader("Taxonomy Column Mapping (Optional)")
        st.markdown("Configure which columns contain taxonomy information. If not specified, defaults will be used.")
        
        use_custom_mapping = st.checkbox("Use custom column mapping", value=False, help="Enable to specify custom column names for taxonomy")
        
        column_mapping = None
        if use_custom_mapping and available_columns:
            tier_a_idx = available_columns.index("Tier A category") if "Tier A category" in available_columns else 0
            tier_b_idx = available_columns.index("Tier B category") if "Tier B category" in available_columns else (0 if available_columns else 0)
            tier_c_idx = available_columns.index("Tier C category") if "Tier C category" in available_columns else (0 if available_columns else 0)
            methodology_idx = available_columns.index("Methodology") if "Methodology" in available_columns else (0 if available_columns else 0)
            
            tier_a_col = st.selectbox(
                "Tier A Category Column",
                available_columns,
                index=tier_a_idx,
                help="Column containing Tier A categories"
            )
            tier_b_col = st.selectbox(
                "Tier B Category Column (Optional)",
                [None] + available_columns,
                index=(tier_b_idx + 1) if tier_b_idx < len(available_columns) else 0,
                help="Column containing Tier B subcategories"
            )
            tier_c_col = st.selectbox(
                "Tier C Category Column (Optional)",
                [None] + available_columns,
                index=(tier_c_idx + 1) if tier_c_idx < len(available_columns) else 0,
                help="Column containing Tier C subcategories"
            )
            methodology_col = st.selectbox(
                "Methodology Column (Optional)",
                [None] + available_columns,
                index=(methodology_idx + 1) if methodology_idx < len(available_columns) else 0,
                help="Column containing methodologies"
            )
            
            column_mapping = DatasetColumnMapping(
                tier_a_column=tier_a_col,
                tier_b_column=tier_b_col if tier_b_col else None,
                tier_c_column=tier_c_col if tier_c_col else None,
                methodology_column=methodology_col if methodology_col else None
            )
            
            # Show taxonomy preview
            if st.button("Preview Taxonomy Structure"):
                try:
                    taxonomy = extract_taxonomy_from_dataset(csv_file, column_mapping, use_mock=True)
                    st.success(f"Found {len(taxonomy.tier_a_categories)} Tier A categories")
                    with st.expander("View Taxonomy Structure"):
                        for cat in taxonomy.tier_a_categories:
                            st.write(f"**{cat.name}**: {len(cat.subcategories)} subcategories")
                            for subcat in cat.subcategories[:3]:  # Show first 3
                                st.write(f"  - {subcat.name}")
                            if len(cat.subcategories) > 3:
                                st.write(f"  ... and {len(cat.subcategories) - 3} more")
                    
                    if column_mapping.methodology_column:
                        methodologies = extract_methodologies_from_dataset(csv_file, column_mapping.methodology_column, use_mock=True)
                        st.success(f"Found {len(methodologies)} methodologies")
                except Exception as e:
                    st.error(f"Error extracting taxonomy: {e}")
        
        if eval_type == "Single-turn":
            if not available_columns:
                st.error("No columns found in CSV file. Please select a valid CSV file.")
                input_column = None
                output_column = None
            else:
                input_idx = available_columns.index("Eval input (MAES)") if "Eval input (MAES)" in available_columns else 0
                output_idx = available_columns.index("Eval output (AcmeCo)") if "Eval output (AcmeCo)" in available_columns else 0
                
                input_column = st.selectbox(
                    "Input Column",
                    available_columns,
                    index=input_idx,
                    help="Column containing user input"
                )
                output_column = st.selectbox(
                    "Output Column",
                    available_columns,
                    index=output_idx,
                    help="Column containing agent output"
                )
            conversation_column = None
        else:
            if not available_columns:
                st.error("No columns found in CSV file. Please select a valid CSV file.")
                conversation_column = None
            else:
                conv_idx = available_columns.index("Eval output (AcmeCo)") if "Eval output (AcmeCo)" in available_columns else 0
                conversation_column = st.selectbox(
                    "Conversation Column",
                    available_columns,
                    index=conv_idx,
                    help="Column containing full conversation text"
                )
            input_column = None
            output_column = None
        
        # Replay mode option
        st.divider()
        if eval_type == "Multi-turn":
            use_replayed_responses = st.checkbox(
                "Use Replayed Agent Responses",
                value=True,
                help="If enabled, use original 'Bot:' or 'Assistant:' responses from the dataset instead of generating new responses. "
                     "\n\n✅ Use replayed responses when:"
                     "\n• Evaluating historical conversations as-is"
                     "\n• Conversations are from different agents/systems"
                     "\n• You want to evaluate the original conversation quality"
                     "\n\n❌ Don't use replayed responses when:"
                     "\n• Testing how your current agent handles these conversations"
                     "\n• Comparing agent versions or improvements"
                     "\n• Dataset only has User messages (no Bot responses)"
                     "\n• You want to see agent behavior changes"
            )
        else:
            # Single-turn: enable replay mode if output column is selected
            if output_column:
                use_replayed_responses = st.checkbox(
                    "Use Replayed Agent Responses",
                    value=True,
                    help="If enabled, use the response from the output column instead of generating a new response. "
                         "\n\n✅ Use replayed responses when:"
                         "\n• Evaluating historical responses as-is"
                         "\n• Responses are from different agents/systems"
                         "\n• You want to evaluate the original response quality"
                         "\n\n❌ Don't use replayed responses when:"
                         "\n• Testing how your current agent handles these inputs"
                         "\n• Comparing agent versions or improvements"
                         "\n• Output column is empty or missing"
                         "\n• You want to see agent behavior changes"
                )
            else:
                use_replayed_responses = False
                st.info("💡 Replay mode requires an output column to be selected. Select an output column above to enable replay mode.")
        
    
    with col2:
        # Show info based on selected file
        if "single_turn_proc" in csv_file:
            st.info("""
            **Single-turn Processed File:**
            - Contains only single-turn evals (1455 rows)
            - Use with "Single-turn" mode
            - All rows have input and will be processed
            """)
        elif "multi_turn_proc" in csv_file:
            st.info("""
            **Multi-turn Processed File:**
            - Contains only multi-turn evals (25 rows)
            - Use with "Multi-turn" mode
            - All rows have conversation format
            """)
        elif eval_type == "Single-turn":
            st.info("""
            **Single-turn Mode:**
            - Processes all evals in the CSV
            - Auto-detects multi-turn conversations (blank input + conversation format in output)
            - Recommended: Use processed files for cleaner separation
            """)
        else:
            st.warning("""
            **Multi-turn Mode:**
            - Only processes rows with conversation format
            - Recommended: Use processed files for cleaner separation
            - Rows without conversation format will be skipped
            """)
        
        st.info("""
        **Instructions:**
        1. Select eval type and CSV file
        2. Set limit (small number for testing)
        3. Click "Run Evals" to execute
        4. Results will be saved and viewable in the "Eval Results" tab
        """)
    
    if st.button("Run Evals", type="primary"):
        with st.spinner("Running evals... This may take a while."):
            try:
                results = run_eval_pipeline(
                    csv_path=csv_file,
                    multi_turn=(eval_type == "Multi-turn"),
                    limit=limit if limit > 0 else None,
                    use_mock_agent=use_mock,
                    use_mock_judge=use_mock,
                    input_column=input_column if eval_type == "Single-turn" else None,
                    output_column=output_column if eval_type == "Single-turn" else None,
                    conversation_column=conversation_column if eval_type == "Multi-turn" else None,
                    column_mapping=column_mapping if use_custom_mapping else None,
                    use_replayed_agent_responses=use_replayed_responses
                )
                
                # Save results
                Path("data/evals").mkdir(parents=True, exist_ok=True)
                save_results(results, "data/evals/results.json")
                
                # Update session state
                st.session_state.eval_results = results
                
                # Show results with info about any skipped evals
                # Calculate expected count
                df_check = pd.read_csv(csv_file)
                expected_count = limit if limit > 0 else len(df_check)
                if limit > 0:
                    expected_count = min(limit, len(df_check))
                
                if len(results) < expected_count:
                    skipped = expected_count - len(results)
                    st.warning(f"⚠️ Completed {len(results)} evals (expected {expected_count}). {skipped} evals were skipped due to errors or missing data. Check the console for details.")
                else:
                    st.success(f"✅ Completed {len(results)} evals!")
                
                if len(results) > 0:
                    st.json(results[:2])  # Show first 2 results as preview
            except Exception as e:
                st.error(f"Error running evals: {e}")
                import traceback
                st.code(traceback.format_exc())


def render_eval_results():
    """Render the Eval Results tab."""
    
    if not st.session_state.eval_results:
        st.info("No eval results yet. Run evals from the 'Run Evals' tab.")
    else:
        df = pd.DataFrame(st.session_state.eval_results)
        
        # Filters
        col1, col2, col3 = st.columns(3)
        with col1:
            categories = st.multiselect("Filter by Category", df.get("tier_a", pd.Series()).unique() if "tier_a" in df.columns else [])
        with col2:
            grades = st.multiselect("Filter by Grade", df.get("grade", pd.Series()).unique() if "grade" in df.columns else [])
        with col3:
            severities = st.multiselect("Filter by Severity", df.get("severity", pd.Series()).unique() if "severity" in df.columns else [])
        
        # Apply filters
        filtered_df = df.copy()
        if categories and "tier_a" in filtered_df.columns:
            filtered_df = filtered_df[filtered_df["tier_a"].isin(categories)]
        if grades and "grade" in filtered_df.columns:
            filtered_df = filtered_df[filtered_df["grade"].isin(grades)]
        if severities and "severity" in filtered_df.columns:
            filtered_df = filtered_df[filtered_df["severity"].isin(severities)]
        
        # Summary stats
        col1, col2, col3, col4 = st.columns(4)
        with col1:
            st.metric("Total Evals", len(filtered_df))
        with col2:
            pass_count = len(filtered_df[filtered_df.get("grade", "") == "Pass"]) if "grade" in filtered_df.columns else 0
            st.metric("Pass", pass_count)
        with col3:
            fail_count = len(filtered_df[filtered_df.get("grade", "") == "Fail"]) if "grade" in filtered_df.columns else 0
            st.metric("Fail", fail_count)
        with col4:
            pass_rate = (pass_count / len(filtered_df) * 100) if len(filtered_df) > 0 else 0
            st.metric("Pass Rate", f"{pass_rate:.1f}%")
        
        # Results table
        st.subheader("Results")
        display_cols = ["eval_id", "tier_a", "grade", "severity", "methodology"]
        available_cols = [col for col in display_cols if col in filtered_df.columns]
        st.dataframe(filtered_df[available_cols], width='stretch') # new syntax: use_container_width=True will be deprecated by EOY 2025
        
        # Detailed view
        if len(filtered_df) > 0:
            # Create user-friendly labels for selection
            if "eval_id" in filtered_df.columns:
                # Create display labels: "eval_id (category, grade)"
                options = filtered_df.apply(
                    lambda row: f"{row.get('eval_id', 'Unknown')} ({row.get('tier_a', 'N/A')}, {row.get('grade', 'N/A')})",
                    axis=1
                ).tolist()
                selected_label = st.selectbox("Select eval for details", options)
                # Find the row matching the selected label
                selected_idx = options.index(selected_label)
                selected_eval = filtered_df.iloc[selected_idx].to_dict()
            else:
                # Fallback to index-based selection
                selected_idx = st.selectbox("Select eval for details", range(len(filtered_df)))
                selected_eval = filtered_df.iloc[selected_idx].to_dict()
            
            st.subheader("Eval Details")
            col1, col2 = st.columns(2)
            with col1:
                st.json({k: v for k, v in selected_eval.items() if k not in ["user_input", "agent_response", "final_response", "conversation", "trajectory", "trajectories", "tool_calls"]})
            with col2:
                if "user_input" in selected_eval:
                    st.text_area("User Input", selected_eval["user_input"], height=100)
                if "agent_response" in selected_eval:
                    st.text_area("Agent Response", selected_eval["agent_response"], height=100)
                elif "final_response" in selected_eval:
                    st.text_area("Final Response", selected_eval["final_response"], height=100)
            
            # Display trajectory if available
            if "trajectory" in selected_eval and selected_eval["trajectory"]:
                st.divider()
                st.subheader("🔍 Execution Trajectory")
                trajectory = selected_eval["trajectory"]
                
                # Tool calls section
                tool_calls = trajectory.get("tool_calls", [])
                if tool_calls:
                    st.write(f"**Tool Calls:** {len(tool_calls)}")
                    for i, tool_call in enumerate(tool_calls, 1):
                        with st.expander(f"Step {i}: {tool_call.get('tool_name', 'Unknown Tool')}"):
                            st.write(f"**Tool:** {tool_call.get('tool_name', 'Unknown')}")
                            st.write("**Inputs:**")
                            st.json(tool_call.get("inputs", {}))
                            st.write("**Outputs:**")
                            st.text(tool_call.get("outputs", "No output"))
                else:
                    st.info("No tools were called during this interaction.")
                
                # Agent reasoning (if available)
                if trajectory.get("agent_reasoning"):
                    st.write("**Agent Reasoning:**")
                    st.text(trajectory["agent_reasoning"])
            
            # For multi-turn, show all trajectories
            if "trajectories" in selected_eval and selected_eval["trajectories"]:
                st.divider()
                st.subheader("🔍 All Turn Trajectories")
                for turn_idx, turn_trajectory in enumerate(selected_eval["trajectories"], 1):
                    with st.expander(f"Turn {turn_idx} Trajectory"):
                        tool_calls = turn_trajectory.get("tool_calls", [])
                        if tool_calls:
                            st.write(f"**Tool Calls:** {len(tool_calls)}")
                            for i, tool_call in enumerate(tool_calls, 1):
                                st.write(f"**Step {i}:** {tool_call.get('tool_name', 'Unknown')}")
                                st.json({"inputs": tool_call.get("inputs", {}), "outputs": tool_call.get("outputs", "No output")})
                        else:
                            st.info("No tools were called in this turn.")


def render_metrics_dashboard():
    """Render the Metrics Dashboard tab."""
    
    if not st.session_state.eval_results:
        st.info("No eval results yet. Run evals from the 'Run Evals' tab to see metrics.")
    else:
        results = st.session_state.eval_results
        
        # Severity Distribution Metrics
        st.header("Incident Severity Distribution")
        severity_df = calculate_severity_metrics(results)
        
        # Display severity metrics table
        st.subheader("Severity Metrics")
        st.dataframe(
            severity_df,
            column_config={
                "severity": "Incident Severity",
                "description": "Description",
                "count": st.column_config.NumberColumn("COUNT", format="%d"),
                "share": st.column_config.NumberColumn("SHARE (%)", format="%.1f%%")
            },
            width='stretch',
            hide_index=True
        )
        
        # Visualize severity distribution
        if len(severity_df) > 1:  # More than just TOTAL row
            severity_chart_df = severity_df[severity_df["severity"] != "TOTAL"].copy()
            severity_chart_df = severity_chart_df[severity_chart_df["count"] > 0]
            
            if len(severity_chart_df) > 0:
                col1, col2 = st.columns(2)
                with col1:
                    st.subheader("Count by Severity")
                    st.bar_chart(severity_chart_df.set_index("severity")[["count"]])
                with col2:
                    st.subheader("Share (%) by Severity")
                    st.bar_chart(severity_chart_df.set_index("severity")[["share"]])
        
        st.divider()
        
        # Tier A Category Incidents (P3 or P2)
        st.header("Tier A Categories with Incidents (P3 or P2)")
        category_incidents_df = calculate_category_incidents(results, min_severity="P2")
        
        if len(category_incidents_df) > 0:
            st.dataframe(
                category_incidents_df,
                column_config={
                    "tier_a_category": "Tier A Category",
                    "incident_count": st.column_config.NumberColumn("Incidents in Round 3 (P3 or P2)", format="%d")
                },
                width='stretch',
                hide_index=True
            )
            
            # Bar chart
            if len(category_incidents_df) > 0:
                st.subheader("Incidents by Tier A Category")
                st.bar_chart(category_incidents_df.set_index("tier_a_category")[["incident_count"]])
        else:
            st.info("No P3 or P2 incidents found in results.")
        
        st.divider()
        
        # Category/Sub-category Pass Rates
        st.header("Category Pass Rates")
        category_pass_df = calculate_category_pass_rates(results)
        
        if len(category_pass_df) > 0:
            # Group by category for better display
            categories = category_pass_df["category"].unique()
            
            for category in sorted(categories):
                cat_df = category_pass_df[category_pass_df["category"] == category]
                with st.expander(f"{category} ({len(cat_df)} sub-categories)"):
                    st.dataframe(
                        cat_df[["category_id", "sub_category", "total", "pass_count", "pass_pct"]],
                        column_config={
                            "category_id": "Category ID",
                            "sub_category": "Sub-category",
                            "total": st.column_config.NumberColumn("Total", format="%d"),
                            "pass_count": st.column_config.NumberColumn("Pass #", format="%d"),
                            "pass_pct": st.column_config.NumberColumn("Pass %", format="%.1f%%")
                        },
                        width='stretch',
                        hide_index=True
                    )
        else:
            st.info("No category data available.")
        
        st.divider()
        
        # Methodology Pass Rates
        st.header("Methodology Pass Rates")
        methodology_df = calculate_methodology_pass_rates(results)
        
        if len(methodology_df) > 0:
            # Separate "Easy" (no methodology) from "Hard" (with methodology)
            easy_df = methodology_df[methodology_df["methodology"].str.contains("No explicit", case=False)]
            hard_df = methodology_df[~methodology_df["methodology"].str.contains("No explicit", case=False)]
            
            # Summary row
            col1, col2, col3 = st.columns(3)
            with col1:
                if len(easy_df) > 0:
                    easy_total = easy_df["total"].sum()
                    easy_pass = easy_df["pass_count"].sum()
                    easy_pct = (easy_pass / easy_total * 100) if easy_total > 0 else 0
                    st.metric("Easy (No Methodology)", f"{easy_pct:.1f}%", f"{easy_pass}/{easy_total}")
            with col2:
                if len(hard_df) > 0:
                    hard_total = hard_df["total"].sum()
                    hard_pass = hard_df["pass_count"].sum()
                    hard_pct = (hard_pass / hard_total * 100) if hard_total > 0 else 0
                    st.metric("Hard (With Methodology)", f"{hard_pct:.1f}%", f"{hard_pass}/{hard_total}")
            with col3:
                total_all = methodology_df["total"].sum()
                pass_all = methodology_df["pass_count"].sum()
                pct_all = (pass_all / total_all * 100) if total_all > 0 else 0
                st.metric("Total", f"{pct_all:.1f}%", f"{pass_all}/{total_all}")
            
            st.subheader("Detailed Methodology Breakdown")
            
            # Clean up methodology names for display
            display_df = methodology_df.copy()
            display_df["methodology"] = display_df["methodology"].str.replace("Methodology: ", "", regex=False)
            
            st.dataframe(
                display_df,
                column_config={
                    "methodology": "Methodology",
                    "total": st.column_config.NumberColumn("Total", format="%d"),
                    "pass_count": st.column_config.NumberColumn("Pass #", format="%d"),
                    "pass_pct": st.column_config.NumberColumn("Pass %", format="%.1f%%")
                },
                width='stretch',
                hide_index=True
            )
            
            # Bar chart
            if len(methodology_df) > 0:
                st.subheader("Pass Rate by Methodology")
                st.bar_chart(display_df.set_index("methodology")[["pass_pct"]])
        else:
            st.info("No methodology data available.")
        
        st.divider()
        
        # Summary Statistics
        st.header("Summary Statistics")
        col1, col2, col3, col4 = st.columns(4)
        with col1:
            st.metric("Total Evals", len(results))
        with col2:
            pass_count = len([r for r in results if r.get("grade") == "Pass"])
            st.metric("Pass Count", pass_count)
        with col3:
            pass_rate = (pass_count / len(results) * 100) if results else 0
            st.metric("Pass Rate", f"{pass_rate:.1f}%")
        with col4:
            p2_p3_count = len([r for r in results if r.get("severity") in ["P2", "P3"]])
            st.metric("P2/P3 Incidents", p2_p3_count)

