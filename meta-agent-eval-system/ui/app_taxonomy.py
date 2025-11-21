"""Taxonomy pages: Taxonomy Generator, Taxonomy Explorer."""

import streamlit as st
import pandas as pd
import os
import json
from taxonomy.taxonomy import load_eval_data
from taxonomy.taxonomy_generator import (
    generate_taxonomy,
    analyze_conversation_with_severity,
    GeneratedTaxonomy,
    TierACategory,
    Subcategory,
    Methodology,
    DatasetColumnMapping,
    extract_taxonomy_from_dataset,
    extract_methodologies_from_dataset
)
from ui.app_utils import save_taxonomy, load_taxonomies, delete_taxonomy


def render_taxonomy_generator():
    """Render the Taxonomy Generator page."""
    st.title("🧬 Taxonomy Generator")
    st.markdown("Generate evaluation taxonomy and analyze conversations using LLM.")
    
    # Create tabs for different functionalities
    tab1, tab2, tab3 = st.tabs(["📝 Generate Taxonomy", "📊 Extract from Dataset", "🔍 Analyze Conversation"])
    
    with tab1:
        st.info("💡 **Black Box Approach**: Provide a natural language description of your agent, and we'll generate a comprehensive evaluation taxonomy.")
        
        # Agent description input
        st.subheader("Agent Description")
        agent_description = st.text_area(
            "Describe your agent",
            height=150,
            placeholder="""Example: A customer support chatbot for an airline that helps customers with:
- Checking booking status
- Looking up refund policies
- Answering questions about flights and services

The agent has access to booking databases and policy information.""",
            help="Provide a clear, natural language description of what your agent does and its capabilities."
        )
        
        # Tool descriptions input
        st.subheader("Tool Descriptions (Optional)")
        st.markdown("If your agent has tools, describe them here to help generate more accurate taxonomies.")
        
        num_tools = st.number_input("Number of tools", min_value=0, max_value=10, value=0, step=1)
        tool_descriptions = []
        
        if num_tools > 0:
            for i in range(num_tools):
                with st.expander(f"Tool {i+1}"):
                    tool_name = st.text_input(f"Tool Name", key=f"tool_name_{i}", placeholder="e.g., lookup_refund_policy")
                    tool_desc = st.text_area(
                        f"Tool Description",
                        key=f"tool_desc_{i}",
                        height=100,
                        placeholder="e.g., Looks up refund policy information based on booking tier and reason"
                    )
                    if tool_name and tool_desc:
                        tool_descriptions.append({"name": tool_name, "description": tool_desc})
        
        # Generate button
        if st.button("🚀 Generate Taxonomy", type="primary", disabled=not agent_description.strip()):
            if not agent_description.strip():
                st.error("Please provide an agent description.")
            else:
                with st.spinner("Generating taxonomy using LLM... This may take a moment."):
                    try:
                        # Check if we should use mock API mode
                        use_mock = st.session_state.get("use_mock_mode", not bool(os.getenv("OPENAI_API_KEY")))
                        
                        taxonomy = generate_taxonomy(
                            agent_description=agent_description,
                            tool_descriptions=tool_descriptions if tool_descriptions else None,
                            use_mock=use_mock
                        )
                        
                        st.success("✅ Taxonomy generated successfully!")
                        st.divider()
                        
                        # Display Tier A Categories
                        st.header("📋 Tier A Categories")
                        st.write(f"Generated {len(taxonomy.tier_a_categories)} categories")
                        
                        for i, category in enumerate(taxonomy.tier_a_categories, 1):
                            with st.expander(f"{i}. {category.name}", expanded=True):
                                st.write(f"**Description:** {category.description}")
                                st.write(f"**Subcategories ({len(category.subcategories)}):**")
                                for j, subcat in enumerate(category.subcategories, 1):
                                    st.write(f"  {j}. **{subcat.name}**: {subcat.description}")
                        
                        st.divider()
                        
                        # Display Methodologies
                        st.header("🎯 Attack Methodologies")
                        st.write(f"Generated {len(taxonomy.methodologies)} methodologies")
                        
                        # Group methodologies by category (handle None categories)
                        methodologies_by_category = {}
                        methodologies_without_category = []
                        
                        for meth in taxonomy.methodologies:
                            if meth.category:
                                if meth.category not in methodologies_by_category:
                                    methodologies_by_category[meth.category] = []
                                methodologies_by_category[meth.category].append(meth)
                            else:
                                methodologies_without_category.append(meth)
                        
                        # Show methodologies grouped by category
                        for category_name, methods in methodologies_by_category.items():
                            with st.expander(f"{category_name} ({len(methods)} methodologies)", expanded=False):
                                for meth in methods:
                                    st.write(f"**{meth.name}**")
                                    st.write(f"  {meth.description}")
                                    st.write("")
                        
                        # Show methodologies without category
                        if methodologies_without_category:
                            with st.expander(f"Uncategorized ({len(methodologies_without_category)} methodologies)", expanded=False):
                                for meth in methodologies_without_category:
                                    st.write(f"**{meth.name}**")
                                    st.write(f"  {meth.description}")
                                    st.write("")
                        
                        # Export option
                        st.divider()
                        st.subheader("Export Taxonomy")
                        
                        # Create exportable format
                        export_data = {
                            "tier_a_categories": [
                                {
                                    "name": cat.name,
                                    "description": cat.description,
                                    "subcategories": [
                                        {"name": sub.name, "description": sub.description}
                                        for sub in cat.subcategories
                                    ]
                                }
                                for cat in taxonomy.tier_a_categories
                            ],
                            "methodologies": [
                                {
                                    "name": meth.name,
                                    "description": meth.description,
                                    "category": meth.category
                                }
                                for meth in taxonomy.methodologies
                            ]
                        }
                        
                        json_export = json.dumps(export_data, indent=2)
                        st.download_button(
                            label="📥 Download as JSON",
                            data=json_export,
                            file_name="generated_taxonomy.json",
                            mime="application/json",
                            key="export_taxonomy"
                        )
                        
                        # Store in session state and save to disk
                        if "generated_taxonomies" not in st.session_state:
                            st.session_state.generated_taxonomies = []
                        
                        taxonomy_data = {
                            "agent_description": agent_description,
                            "taxonomy": export_data,
                            "timestamp": pd.Timestamp.now().isoformat()
                        }
                        
                        # Save to disk
                        identifier = save_taxonomy(taxonomy_data, source="generated")
                        taxonomy_data["identifier"] = identifier
                        taxonomy_data["source"] = "generated"
                        
                        # Store in session state
                        st.session_state.generated_taxonomies.append(taxonomy_data)
                        
                    except Exception as e:
                        st.error(f"Error generating taxonomy: {e}")
                        import traceback
                        st.code(traceback.format_exc())
                        use_mock = st.session_state.get("use_mock_mode", not bool(os.getenv("OPENAI_API_KEY")))
                        if not use_mock:
                            st.info("💡 **Tip**: If you don't have an OpenAI API key, enable 'Use Mock API Mode' in the sidebar to see example output.")
    
        # Show previously generated taxonomies
        if "generated_taxonomies" in st.session_state and st.session_state.generated_taxonomies:
            st.divider()
            st.subheader("📚 Previously Generated Taxonomies")
            for i, gen_tax in enumerate(reversed(st.session_state.generated_taxonomies[-5:]), 1):  # Show last 5
                with st.expander(f"Taxonomy {i} - {gen_tax.get('timestamp', 'Unknown time')[:19]}"):
                    st.write(f"**Agent Description:** {gen_tax['agent_description'][:200]}...")
                    st.json(gen_tax["taxonomy"])
    
    with tab2:
        st.info("💡 **Dataset Extraction**: Extract taxonomy structure and methodologies from an existing CSV dataset with configurable column mapping.")
        
        # File selection
        st.subheader("Dataset Selection")
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
            help="Select the CSV file to extract taxonomy from"
        )
        
        # Load CSV to get available columns
        try:
            df_preview = pd.read_csv(csv_file, nrows=5)
            available_columns = list(df_preview.columns)
            
            st.success(f"✅ Loaded CSV with {len(available_columns)} columns")
            
            # Column mapping configuration
            st.subheader("Column Mapping")
            st.markdown("Specify which columns contain taxonomy information:")
            
            tier_a_idx = available_columns.index("Tier A category") if "Tier A category" in available_columns else 0
            tier_b_idx = available_columns.index("Tier B category") if "Tier B category" in available_columns else 0
            tier_c_idx = available_columns.index("Tier C category") if "Tier C category" in available_columns else 0
            methodology_idx = available_columns.index("Methodology") if "Methodology" in available_columns else 0
            
            tier_a_col = st.selectbox(
                "Tier A Category Column *",
                available_columns,
                index=tier_a_idx,
                help="Required: Column containing Tier A categories"
            )
            tier_b_col = st.selectbox(
                "Tier B Category Column (Optional)",
                [None] + available_columns,
                index=(tier_b_idx + 1) if tier_b_idx < len(available_columns) else 0,
                help="Optional: Column containing Tier B subcategories"
            )
            tier_c_col = st.selectbox(
                "Tier C Category Column (Optional)",
                [None] + available_columns,
                index=(tier_c_idx + 1) if tier_c_idx < len(available_columns) else 0,
                help="Optional: Column containing Tier C subcategories"
            )
            methodology_col = st.selectbox(
                "Methodology Column (Optional)",
                [None] + available_columns,
                index=(methodology_idx + 1) if methodology_idx < len(available_columns) else 0,
                help="Optional: Column containing methodologies"
            )
            
            # Preview unique values
            st.subheader("Preview Unique Values")
            col1, col2 = st.columns(2)
            
            with col1:
                if tier_a_col:
                    tier_a_values = df_preview[tier_a_col].dropna().unique()[:10]
                    st.write(f"**Tier A values (sample):**")
                    for val in tier_a_values:
                        st.write(f"- {val}")
                    if len(df_preview[tier_a_col].dropna().unique()) > 10:
                        st.caption(f"... and {len(df_preview[tier_a_col].dropna().unique()) - 10} more")
            
            with col2:
                if methodology_col:
                    meth_values = df_preview[methodology_col].dropna().unique()[:10]
                    st.write(f"**Methodology values (sample):**")
                    for val in meth_values:
                        st.write(f"- {val}")
                    if len(df_preview[methodology_col].dropna().unique()) > 10:
                        st.caption(f"... and {len(df_preview[methodology_col].dropna().unique()) - 10} more")
            
            # Extraction options
            st.subheader("Extraction Options")
            generate_descriptions = st.checkbox(
                "Generate LLM descriptions",
                value=False,
                help="Use LLM to generate descriptions for categories and methodologies (requires API key)"
            )
            
            # Extract button
            if st.button("Extract Taxonomy", type="primary"):
                with st.spinner("Extracting taxonomy from dataset..."):
                    try:
                        column_mapping = DatasetColumnMapping(
                            tier_a_column=tier_a_col,
                            tier_b_column=tier_b_col if tier_b_col else None,
                            tier_c_column=tier_c_col if tier_c_col else None,
                            methodology_column=methodology_col if methodology_col else None
                        )
                        
                        # Extract taxonomy
                        taxonomy = extract_taxonomy_from_dataset(
                            csv_file,
                            column_mapping,
                            use_mock=not generate_descriptions
                        )
                        
                        # Extract methodologies if column specified
                        if methodology_col:
                            methodologies = extract_methodologies_from_dataset(
                                csv_file,
                                methodology_col,
                                use_mock=not generate_descriptions
                            )
                            taxonomy.methodologies = methodologies
                        
                        # Store in session state and save to disk
                        if "generated_taxonomies" not in st.session_state:
                            st.session_state.generated_taxonomies = []
                        
                        from datetime import datetime
                        csv_filename = os.path.basename(csv_file).replace(".csv", "")
                        taxonomy_data = {
                            "timestamp": datetime.now().isoformat(),
                            "agent_description": f"Extracted from {csv_file}",
                            "taxonomy": {
                                "tier_a_categories": [
                                    {
                                        "name": cat.name,
                                        "description": cat.description,
                                        "subcategories": [
                                            {"name": sub.name, "description": sub.description}
                                            for sub in cat.subcategories
                                        ]
                                    }
                                    for cat in taxonomy.tier_a_categories
                                ],
                                "methodologies": [
                                    {
                                        "name": meth.name,
                                        "description": meth.description,
                                        "category": meth.category
                                    }
                                    for meth in taxonomy.methodologies
                                ]
                            }
                        }
                        
                        # Save to disk with identifier based on CSV filename
                        identifier = save_taxonomy(taxonomy_data, source="from_dataset", identifier=f"{csv_filename}_{datetime.now().strftime('%Y%m%d_%H%M%S')}")
                        taxonomy_data["identifier"] = identifier
                        taxonomy_data["source"] = "from_dataset"
                        
                        # Store in session state
                        st.session_state.generated_taxonomies.append(taxonomy_data)
                        
                        st.success(f"✅ Extracted taxonomy with {len(taxonomy.tier_a_categories)} categories and {len(taxonomy.methodologies)} methodologies! (ID: {identifier})")
                        st.rerun()
                        
                    except Exception as e:
                        st.error(f"Error extracting taxonomy: {e}")
                        st.exception(e)
        
        except Exception as e:
            st.error(f"Error loading CSV: {e}")
    
    with tab3:
        st.info("💡 **Conversation Analysis**: Analyze a conversation against a generated taxonomy to classify methodology and risk categories.")
        
        # Select taxonomy to use (load from disk if needed)
        st.subheader("Select Taxonomy")
        
        # Load taxonomies from disk and merge with session state
        disk_taxonomies = load_taxonomies()
        if "generated_taxonomies" in st.session_state:
            session_identifiers = {tax.get("identifier") for tax in st.session_state.generated_taxonomies if tax.get("identifier")}
            for disk_tax in disk_taxonomies:
                if disk_tax.get("identifier") not in session_identifiers:
                    st.session_state.generated_taxonomies.append(disk_tax)
        
        all_taxonomies = st.session_state.get("generated_taxonomies", [])
        if not all_taxonomies and disk_taxonomies:
            all_taxonomies = disk_taxonomies
            st.session_state.generated_taxonomies = disk_taxonomies
        
        if not all_taxonomies:
            st.warning("⚠️ No taxonomies found. Generate a taxonomy in the first tab first.")
        else:
            taxonomy_options = {}
            for i, gen_tax in enumerate(reversed(all_taxonomies), 1):
                timestamp = gen_tax.get('timestamp', 'Unknown')[:19]
                desc = gen_tax['agent_description'][:100] + "..." if len(gen_tax['agent_description']) > 100 else gen_tax['agent_description']
                source = gen_tax.get('source', 'unknown')
                taxonomy_options[i] = f"Taxonomy {i} ({timestamp}) [{source}]: {desc}"
            
            selected_tax_idx = st.selectbox(
                "Choose a taxonomy to analyze against",
                options=list(taxonomy_options.keys()),
                format_func=lambda x: taxonomy_options[x],
                key="taxonomy_selector"
            )
            
            selected_taxonomy_data = list(reversed(all_taxonomies))[selected_tax_idx - 1]
            taxonomy_dict = selected_taxonomy_data["taxonomy"]
            
            # Reconstruct taxonomy object
            selected_taxonomy = GeneratedTaxonomy(
                tier_a_categories=[
                    TierACategory(
                        name=cat["name"],
                        description=cat["description"],
                        subcategories=[
                            Subcategory(name=sub["name"], description=sub["description"])
                            for sub in cat["subcategories"]
                        ]
                    )
                    for cat in taxonomy_dict["tier_a_categories"]
                ],
                methodologies=[
                    Methodology(
                        name=meth["name"],
                        description=meth["description"],
                        category=meth.get("category")  # Handle None categories
                    )
                    for meth in taxonomy_dict["methodologies"]
                ]
            )
            
            st.divider()
            
            # Conversation input
            st.subheader("Conversation Input")
            conversation_mode = st.radio(
                "Input Mode",
                ["Single Turn", "Multi-Turn", "From Thread"],
                help="Choose how to input the conversation"
            )
            
            conversation = []
            
            if conversation_mode == "Single Turn":
                user_input = st.text_area("User Input", height=100, key="single_user_input")
                agent_response = st.text_area("Agent Response", height=100, key="single_agent_response")
                if user_input and agent_response:
                    conversation = [
                        {"role": "user", "content": user_input},
                        {"role": "assistant", "content": agent_response}
                    ]
            
            elif conversation_mode == "Multi-Turn":
                st.markdown("Enter conversation in format: `User: ...` / `Bot: ...` or `Assistant: ...`")
                conversation_text = st.text_area(
                    "Conversation",
                    height=200,
                    placeholder="User: Hello\nBot: Hi! How can I help?\nUser: Can you check my booking?\nBot: Sure, what's your booking reference?",
                    key="multi_turn_text"
                )
                if conversation_text:
                    # Parse conversation
                    lines = conversation_text.split("\n")
                    for line in lines:
                        line = line.strip()
                        if not line:
                            continue
                        if line.startswith("User:"):
                            conversation.append({"role": "user", "content": line.replace("User:", "").strip()})
                        elif line.startswith("Bot:") or line.startswith("Assistant:"):
                            conversation.append({"role": "assistant", "content": line.replace("Bot:", "").replace("Assistant:", "").strip()})
            
            elif conversation_mode == "From Thread":
                # Select from existing threads
                thread_options = {tid: f"{thread['name']} ({len(thread['history'])} msgs)" 
                                 for tid, thread in st.session_state.threads.items()}
                selected_thread_id = st.selectbox(
                    "Select Thread",
                    options=list(thread_options.keys()),
                    format_func=lambda tid: thread_options[tid],
                    key="analysis_thread_selector"
                )
                selected_thread = st.session_state.threads[selected_thread_id]
                conversation = selected_thread.get("history", [])
                
                if conversation:
                    st.markdown("**Conversation Preview:**")
                    with st.expander("View Conversation", expanded=False):
                        for msg in conversation:
                            role = msg.get("role", "unknown")
                            content = msg.get("content", "")
                            st.markdown(f"**{role.capitalize()}:** {content}")
            
            # Analyze button
            if conversation and len(conversation) > 0:
                st.divider()
                if st.button("🔍 Analyze Conversation", type="primary"):
                    with st.spinner("Analyzing conversation (Step 1: Classification, Step 2: Severity)... This may take a moment."):
                        try:
                            use_mock = st.session_state.get("use_mock_mode", not bool(os.getenv("OPENAI_API_KEY")))
                            
                            # Multi-step analysis: classify then judge severity
                            result = analyze_conversation_with_severity(
                                conversation=conversation,
                                taxonomy=selected_taxonomy,
                                use_mock=use_mock
                            )
                            
                            classification = result["classification"]
                            severity = result["severity"]
                            severity_reasoning = result["severity_reasoning"]
                            
                            st.success("✅ Analysis complete!")
                            st.divider()
                            
                            # Display results
                            st.header("📊 Analysis Results")
                            
                            # Step 1: Classification
                            st.subheader("Step 1: Classification")
                            col1, col2 = st.columns(2)
                            with col1:
                                st.metric("Methodology", classification.methodology)
                                st.metric("Tier A Category", classification.tier_a_category)
                            with col2:
                                st.metric("Tier B Subcategory", classification.tier_b_subcategory)
                                st.metric("Tier C Subcategory", classification.tier_c_subcategory)
                            
                            st.write("**User Intent:**")
                            st.write(classification.user_intent)
                            
                            st.write("**Classification Reasoning:**")
                            st.write(classification.classification_reasoning)
                            
                            st.divider()
                            
                            # Step 2: Severity Assessment
                            st.subheader("Step 2: Severity Assessment")
                            st.metric("Severity", severity)
                            st.write("**Severity Reasoning:**")
                            st.write(severity_reasoning)
                            
                            # Store analysis results
                            if "conversation_analyses" not in st.session_state:
                                st.session_state.conversation_analyses = []
                            st.session_state.conversation_analyses.append({
                                "conversation": conversation,
                                "analysis": {
                                    "user_intent": classification.user_intent,
                                    "methodology": classification.methodology,
                                    "tier_a_category": classification.tier_a_category,
                                    "tier_b_subcategory": classification.tier_b_subcategory,
                                    "tier_c_subcategory": classification.tier_c_subcategory,
                                    "severity": severity,
                                    "classification_reasoning": classification.classification_reasoning,
                                    "severity_reasoning": severity_reasoning
                                },
                                "taxonomy_timestamp": selected_taxonomy_data.get("timestamp", "Unknown"),
                                "taxonomy_identifier": selected_taxonomy_data.get("identifier", "Unknown"),
                                "taxonomy_source": selected_taxonomy_data.get("source", "Unknown"),
                                "timestamp": pd.Timestamp.now().isoformat()
                            })
                            
                        except Exception as e:
                            st.error(f"Error analyzing conversation: {e}")
                            import traceback
                            st.code(traceback.format_exc())
                            use_mock = st.session_state.get("use_mock_mode", not bool(os.getenv("OPENAI_API_KEY")))
                            if not use_mock:
                                st.info("💡 **Tip**: If you don't have an OpenAI API key, enable 'Use Mock API Mode' in the sidebar to see example output.")
            else:
                st.info("💬 Enter a conversation above to analyze it.")
            
            # Show previous analyses
            if "conversation_analyses" in st.session_state and st.session_state.conversation_analyses:
                st.divider()
                st.subheader("📚 Previous Analyses")
                for i, analysis_data in enumerate(reversed(st.session_state.conversation_analyses[-5:]), 1):
                    with st.expander(f"Analysis {i} - {analysis_data.get('timestamp', 'Unknown')[:19]}"):
                        st.write("**Classification (Step 1):**")
                        st.write(f"- Methodology: {analysis_data['analysis']['methodology']}")
                        st.write(f"- Tier A: {analysis_data['analysis']['tier_a_category']}")
                        st.write(f"- Tier B: {analysis_data['analysis']['tier_b_subcategory']}")
                        st.write(f"- Tier C: {analysis_data['analysis']['tier_c_subcategory']}")
                        st.write(f"**User Intent:** {analysis_data['analysis']['user_intent']}")
                        st.write(f"**Classification Reasoning:** {analysis_data['analysis'].get('classification_reasoning', 'N/A')}")
                        st.write("**Severity Assessment (Step 2):**")
                        st.write(f"- Severity: {analysis_data['analysis'].get('severity', 'N/A')}")
                        st.write(f"**Severity Reasoning:** {analysis_data['analysis'].get('severity_reasoning', 'N/A')}")


def render_taxonomy_explorer():
    """Render the Taxonomy Explorer page."""
    st.title("🌳 Taxonomy Explorer")
    st.markdown("Explore taxonomy hierarchies from generated or extracted taxonomies.")
    
    st.info("💡 Explore taxonomies that were generated via LLM or extracted from datasets.")
    
    # Load taxonomies from disk and merge with session state
    disk_taxonomies = load_taxonomies()
    if "generated_taxonomies" not in st.session_state:
        st.session_state.generated_taxonomies = []
    
    session_identifiers = {tax.get("identifier") for tax in st.session_state.generated_taxonomies if tax.get("identifier")}
    for disk_tax in disk_taxonomies:
        if disk_tax.get("identifier") not in session_identifiers:
            st.session_state.generated_taxonomies.append(disk_tax)
    
    all_taxonomies = st.session_state.generated_taxonomies
    
    if not all_taxonomies:
        st.warning("⚠️ No taxonomies found. Generate or extract a taxonomy in the Taxonomy Generator first.")
    else:
        # Select taxonomy to explore
            taxonomy_options = {}
            for i, gen_tax in enumerate(reversed(all_taxonomies), 1):
                timestamp = gen_tax.get('timestamp', 'Unknown')[:19]
                desc = gen_tax['agent_description'][:100] + "..." if len(gen_tax['agent_description']) > 100 else gen_tax['agent_description']
                source = gen_tax.get('source', 'unknown')
                taxonomy_options[i] = f"Taxonomy {i} ({timestamp}) [{source}]: {desc}"
            
            selected_tax_idx = st.selectbox(
                "Choose a taxonomy to explore",
                options=list(taxonomy_options.keys()),
                format_func=lambda x: taxonomy_options[x],
                key="explorer_taxonomy_selector"
            )
            
            selected_taxonomy_data = list(reversed(all_taxonomies))[selected_tax_idx - 1]
            taxonomy_dict = selected_taxonomy_data["taxonomy"]
            
            # Show metadata
            col1, col2 = st.columns(2)
            with col1:
                st.caption(f"**Source:** {selected_taxonomy_data.get('source', 'unknown')}")
            with col2:
                st.caption(f"**ID:** {selected_taxonomy_data.get('identifier', 'N/A')}")
            
            # Reconstruct taxonomy object
            selected_taxonomy = GeneratedTaxonomy(
                tier_a_categories=[
                    TierACategory(
                        name=cat["name"],
                        description=cat["description"],
                        subcategories=[
                            Subcategory(name=sub["name"], description=sub["description"])
                            for sub in cat["subcategories"]
                        ]
                    )
                    for cat in taxonomy_dict["tier_a_categories"]
                ],
                methodologies=[
                    Methodology(
                        name=meth["name"],
                        description=meth["description"],
                        category=meth.get("category")
                    )
                    for meth in taxonomy_dict["methodologies"]
                ]
            )
            
            # Delete button
            st.divider()
            if st.button("🗑️ Delete Taxonomy", type="secondary", key=f"delete_tax_{selected_taxonomy_data.get('identifier')}"):
                identifier = selected_taxonomy_data.get("identifier")
                source = selected_taxonomy_data.get("source")
                if identifier and source:
                    if delete_taxonomy(identifier, source):
                        # Remove from session state
                        st.session_state.generated_taxonomies = [
                            t for t in st.session_state.generated_taxonomies 
                            if t.get("identifier") != identifier
                        ]
                        st.success(f"✅ Taxonomy deleted!")
                        st.rerun()
                    else:
                        st.error("Failed to delete taxonomy file.")
                else:
                    st.error("Cannot delete: missing identifier or source.")
            
            st.divider()
            
            # Display taxonomy hierarchy
            st.header("📊 Taxonomy Structure")
            
            # Tier A Categories
            st.subheader("Tier A Categories")
            for cat in selected_taxonomy.tier_a_categories:
                expander_title = f"**{cat.name}**"
                if cat.description:
                    expander_title += f" - {cat.description}"
                with st.expander(expander_title, expanded=False):
                    if cat.description:
                        st.write(f"**Description:** {cat.description}")
                    st.write(f"**Subcategories:** {len(cat.subcategories)}")
                    
                    # Display subcategories
                    for subcat in cat.subcategories:
                        subcat_text = f"  - **{subcat.name}**"
                        if subcat.description:
                            subcat_text += f": {subcat.description}"
                        st.write(subcat_text)
            
            # Methodologies
            if selected_taxonomy.methodologies:
                st.divider()
                st.subheader("🎯 Methodologies")
                
                # Group methodologies by category
                methodologies_by_category = {}
                methodologies_without_category = []
                
                for meth in selected_taxonomy.methodologies:
                    if meth.category:
                        if meth.category not in methodologies_by_category:
                            methodologies_by_category[meth.category] = []
                        methodologies_by_category[meth.category].append(meth)
                    else:
                        methodologies_without_category.append(meth)
                
                # Show methodologies grouped by category
                for category_name, methods in methodologies_by_category.items():
                    with st.expander(f"{category_name} ({len(methods)} methodologies)", expanded=False):
                        for meth in methods:
                            st.write(f"**{meth.name}**")
                            if meth.description:
                                st.write(f"  {meth.description}")
                            st.write("")
                
                # Show methodologies without category
                if methodologies_without_category:
                    with st.expander(f"Uncategorized ({len(methodologies_without_category)} methodologies)", expanded=False):
                        for meth in methodologies_without_category:
                            st.write(f"**{meth.name}**")
                            if meth.description:
                                st.write(f"  {meth.description}")
                            st.write("")
            
            # Summary statistics
            st.divider()
            st.subheader("📈 Summary")
            col1, col2, col3 = st.columns(3)
            with col1:
                st.metric("Tier A Categories", len(selected_taxonomy.tier_a_categories))
            with col2:
                total_subcats = sum(len(cat.subcategories) for cat in selected_taxonomy.tier_a_categories)
                st.metric("Total Subcategories", total_subcats)
            with col3:
                st.metric("Methodologies", len(selected_taxonomy.methodologies))

