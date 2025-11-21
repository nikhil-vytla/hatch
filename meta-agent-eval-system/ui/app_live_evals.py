"""Live evaluation pages: Agent Chat, Live Evals, Live Eval Results."""

import streamlit as st
import pandas as pd
import os
import uuid
from datetime import datetime
from pathlib import Path
from ui.app_utils import save_threads


def render_live_evals_page(use_mock: bool):
    """Render the Live Evals page with tabs for Agent Chat, Live Evals, and Live Eval Results."""
    st.title("⚡ Live Evaluations")
    
    # Create tabs
    tab1, tab2, tab3 = st.tabs(["🤖 Agent Chat", "📝 Run Live Eval", "📊 Live Eval Results"])
    
    with tab1:
        render_agent_chat(use_mock)
    
    with tab2:
        render_live_evals(use_mock)
    
    with tab3:
        render_live_eval_results()


def render_agent_chat(use_mock: bool):
    """Render the Agent Chat tab."""
    
    # Thread management UI
    col1, col2, col3 = st.columns([2, 1, 1])
    with col1:
        # Thread selector
        thread_options = {tid: f"{thread['name']} ({len(thread['history'])} msgs)" 
                         for tid, thread in st.session_state.threads.items()}
        # Get current thread index for default selection
        current_options = list(thread_options.keys())
        current_index = current_options.index(st.session_state.current_thread_id) if st.session_state.current_thread_id in current_options else 0
        
        selected_thread_id = st.selectbox(
            "Current Thread",
            options=current_options,
            index=current_index,
            format_func=lambda tid: thread_options[tid],
            key="thread_selector"
        )
        if selected_thread_id != st.session_state.current_thread_id:
            # Switch thread - save current thread history, load new thread
            current_thread = st.session_state.threads[st.session_state.current_thread_id]
            current_thread["history"] = st.session_state.agent.get_history()
            save_threads(st.session_state.threads)
            st.session_state.current_thread_id = selected_thread_id
            # Load new thread history into agent
            new_thread = st.session_state.threads[selected_thread_id]
            st.session_state.agent.conversation_history = new_thread["history"].copy()
            st.rerun()
    
    with col2:
        if st.button("➕ New Thread"):
            new_thread_id = str(uuid.uuid4())
            st.session_state.threads[new_thread_id] = {
                "name": new_thread_id,
                "history": [],
                "created_at": datetime.now().isoformat()
            }
            # Save current thread before switching
            current_thread = st.session_state.threads[st.session_state.current_thread_id]
            current_thread["history"] = st.session_state.agent.get_history()
            save_threads(st.session_state.threads)
            # Switch to new thread
            st.session_state.current_thread_id = new_thread_id
            st.session_state.agent.reset()
            st.rerun()
    
    with col3:
        if st.button("🗑️ Delete Thread"):
            if len(st.session_state.threads) > 1:
                # Don't allow deleting if it's the only thread
                del st.session_state.threads[st.session_state.current_thread_id]
                save_threads(st.session_state.threads)
                # Switch to first available thread
                st.session_state.current_thread_id = list(st.session_state.threads.keys())[0]
                st.session_state.agent.conversation_history = st.session_state.threads[st.session_state.current_thread_id]["history"].copy()
                st.rerun()
            else:
                st.warning("Cannot delete the last thread!")
    
    st.divider()
    
    # Show mock mode status
    if use_mock:
        st.info("🔧 Mock Mode: ON - Agent responses are manually configured")
    else:
        # Check if API key is set
        has_api_key = bool(os.getenv("OPENAI_API_KEY"))
        if has_api_key:
            st.info("🔧 Mock API Mode: OFF - Using OpenAI API")
        else:
            st.warning("⚠️ **OPENAI_API_KEY not set!** Please either:")
            st.markdown("""
            1. Set the environment variable: `export OPENAI_API_KEY=your_key_here`
            2. Or enable Mock Mode in the sidebar to test without an API key
            """)
            st.info("💡 For now, you can use Mock API Mode to test the interface.")
    
    st.markdown("Interact with the customer support agent directly.")
    
    # Get current thread history
    current_thread = st.session_state.threads[st.session_state.current_thread_id]
    # Sync agent history with thread history
    st.session_state.agent.conversation_history = current_thread["history"].copy()
    history = st.session_state.agent.get_history()
    
    # Debug: Show history count and agent status
    if use_mock:
        st.caption(f"Mock mode: {len(history)} messages in history")
    else:
        agent_initialized = st.session_state.agent is not None and not st.session_state.agent.use_mock
        st.caption(f"Normal mode: {len(history)} messages in history | Agent initialized: {agent_initialized}")
    
    for message in history:
        role = message["role"]
        content = message["content"]
        if role == "user":
            with st.chat_message("user"):
                st.write(content)
        elif role == "assistant":
            with st.chat_message("assistant"):
                st.write(content)
    
    # User input - this must be at the end to work properly
    user_input = st.chat_input("Type your message...")
    if user_input:
        # Process the message (this updates history)
        with st.spinner("Agent is thinking..."):
            try:
                # Check if agent is properly initialized
                if not st.session_state.agent:
                    st.error("Agent not initialized. Please refresh the page.")
                    st.stop()
                
                response = st.session_state.agent.chat(user_input)
                
                # Update thread history with agent's updated history
                current_thread = st.session_state.threads[st.session_state.current_thread_id]
                current_thread["history"] = st.session_state.agent.get_history()
                save_threads(st.session_state.threads)  # Persist to file
                
                # Verify history was updated
                updated_history = st.session_state.agent.get_history()
                if len(updated_history) == 0:
                    st.warning("⚠️ Warning: Conversation history is empty after sending message. This may indicate an issue with the agent.")
                
                if not response or response.strip() == "":
                    st.error("Agent returned empty response. Check console for errors.")
                else:
                    # Success - history should be updated
                    st.success(f"✅ Response received ({len(updated_history)} messages in history)")
            except Exception as e:
                st.error(f"Error getting agent response: {e}")
                import traceback
                st.code(traceback.format_exc())
        
        # Rerun to display the updated history
        st.rerun()
    
    # Clear current thread button
    if st.button("🗑️ Clear Current Thread", help="Clear conversation history for current thread"):
        st.session_state.agent.reset()
        current_thread = st.session_state.threads[st.session_state.current_thread_id]
        current_thread["history"] = []
        save_threads(st.session_state.threads)
        st.rerun()


def render_live_evals(use_mock: bool):
    """Render the Run Live Eval tab."""
    st.markdown("Evaluate conversations in real-time.")
    
    # Show summary of recent live eval results
    if "live_eval_results" in st.session_state and st.session_state.live_eval_results:
        recent_count = len(st.session_state.live_eval_results)
        st.info(f"📊 You have {recent_count} live evaluation{'s' if recent_count != 1 else ''}. View them in the 'Live Eval Results' tab.")
    
    # Thread selector for Live Evals
    thread_options = {tid: f"{thread['name']} ({len(thread['history'])} msgs)" 
                     for tid, thread in st.session_state.threads.items()}
    selected_thread_id = st.selectbox(
        "Select Thread to Evaluate",
        options=list(thread_options.keys()),
        format_func=lambda tid: thread_options[tid],
        key="live_eval_thread_selector"
    )
    
    # Get history from selected thread
    selected_thread = st.session_state.threads[selected_thread_id]
    history = selected_thread["history"]
    
    if not history:
        st.info("💬 No conversation yet. Go to the 'Agent Chat' tab to start a conversation, then come back here to evaluate it.")
    else:
        # Show conversation preview
        st.subheader("Current Conversation")
        with st.expander("View Conversation", expanded=True):
            for i, message in enumerate(history):
                role = message["role"]
                content = message["content"]
                if role == "user":
                    st.markdown(f"**User:** {content}")
                elif role == "assistant":
                    st.markdown(f"**Agent:** {content}")
        
        # Eval configuration
        st.divider()
        st.subheader("Manually Configure Evaluation")
        
        col1, col2 = st.columns(2)
        with col1:
            methodology = st.text_input(
                "Methodology",
                value="Live Conversation Evaluation",
                help="Evaluation methodology name"
            )
            category = st.text_input(
                "Category (Tier A)",
                value="General",
                help="Tier A category for this evaluation"
            )
        
        with col2:
            tier_b = st.text_input("Tier B Category", value="")
            tier_c = st.text_input("Tier C Category", value="")
        
        # Determine if this is single-turn or multi-turn
        is_multi_turn = len([m for m in history if m["role"] == "user"]) > 1
        
        if is_multi_turn:
            st.info(f"📊 **Multi-turn conversation detected** ({len([m for m in history if m['role'] == 'user'])} user turns)")
            
            # For multi-turn, evaluate the entire conversation trajectory
            # Pass the full conversation history and use the final exchange as the primary evaluation target
            # The judge will evaluate the whole conversation, not just the final exchange
            if len(history) >= 2:
                final_user_input = history[-2]["content"] if history[-2]["role"] == "user" else history[-1]["content"]
                final_agent_response = history[-1]["content"] if history[-1]["role"] == "assistant" else ""
                # Pass full conversation history so judge can evaluate entire trajectory
                conversation_history = history
            else:
                final_user_input = history[0]["content"] if history[0]["role"] == "user" else ""
                final_agent_response = history[-1]["content"] if history[-1]["role"] == "assistant" else ""
                conversation_history = history
        else:
            st.info("📊 **Single-turn conversation**")
            final_user_input = history[0]["content"] if history[0]["role"] == "user" else ""
            final_agent_response = history[-1]["content"] if history[-1]["role"] == "assistant" else ""
            conversation_history = []
        
        # Run evaluation
        if st.button("🚀 Run Evaluation", type="primary"):
            from eval.judge import evaluate_response
            
            with st.spinner("Evaluating conversation..."):
                try:
                    grade = evaluate_response(
                        user_input=final_user_input,
                        agent_response=final_agent_response,
                        methodology=methodology,
                        category=category,
                        conversation_history=conversation_history if conversation_history else None,
                        trajectory=None,  # Trajectory not available for live evals from existing history
                        use_mock=use_mock
                    )
                    
                    # Display results
                    st.success("✅ Evaluation Complete!")
                    st.divider()
                    
                    col1, col2, col3 = st.columns(3)
                    with col1:
                        st.metric("Grade", grade.grade)
                    with col2:
                        st.metric("Severity", grade.severity)
                    with col3:
                        st.metric("Category", category)
                    
                    st.subheader("Reasoning")
                    st.write(grade.reasoning)
                    
                    if grade.notes:
                        st.subheader("Notes")
                        st.write(grade.notes)
                    
                    # Save to eval results
                    eval_result = {
                        "eval_id": f"LIVE_{datetime.now().strftime('%Y%m%d_%H%M%S')}",
                        "tier_a": category,
                        "tier_b": tier_b,
                        "tier_c": tier_c,
                        "methodology": methodology,
                        "user_input": final_user_input,
                        "agent_response": final_agent_response,
                        "conversation_history": history,  # Save full history including final exchange
                        "grade": grade.grade,
                        "severity": grade.severity,
                        "reasoning": grade.reasoning,
                        "notes": grade.notes,
                        "turns": len([m for m in history if m["role"] == "user"]),
                        "is_live_eval": True,
                        "thread_id": selected_thread_id
                    }
                    
                    # Add to live eval results only (not mixed with dataset results)
                    if "live_eval_results" not in st.session_state:
                        st.session_state.live_eval_results = []
                    st.session_state.live_eval_results.append(eval_result)
                    
                    st.success("💾 Evaluation saved! View it in the 'Live Eval Results' tab.")
                    
                except Exception as e:
                    st.error(f"Error running evaluation: {e}")
                    import traceback
                    st.code(traceback.format_exc())


def render_live_eval_results():
    """Render the Live Eval Results tab."""
    st.markdown("View and analyze live evaluation results from real-time conversations.")
    
    if "live_eval_results" not in st.session_state or not st.session_state.live_eval_results:
        st.info("No live eval results yet. Run evaluations from the 'Run Live Eval' tab.")
    else:
        live_results = st.session_state.live_eval_results
        df = pd.DataFrame(live_results)
        
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
            st.metric("Total Live Evals", len(filtered_df))
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
        display_cols = ["eval_id", "thread_id", "tier_a", "grade", "severity", "methodology", "turns"]
        available_cols = [col for col in display_cols if col in filtered_df.columns]
        st.dataframe(filtered_df[available_cols], width='stretch', hide_index=True)
        
        # Export button
        csv = filtered_df.to_csv(index=False)
        st.download_button(
            label="📥 Export CSV",
            data=csv,
            file_name=f"live_eval_results_{datetime.now().strftime('%Y%m%d_%H%M%S')}.csv",
            mime="text/csv",
            key="export_live_eval_results"
        )
        
        # Detailed view
        if len(filtered_df) > 0:
            st.divider()
            # Create user-friendly labels for selection
            if "eval_id" in filtered_df.columns and "thread_id" in filtered_df.columns:
                # Create display labels: "eval_id (thread_id, grade)"
                options = filtered_df.apply(
                    lambda row: f"{row.get('eval_id', 'Unknown')} (Thread: {row.get('thread_id', 'Unknown')[:8]}..., {row.get('grade', 'N/A')})",
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
                st.json({k: v for k, v in selected_eval.items() if k not in ["user_input", "agent_response", "final_response", "conversation", "conversation_history", "trajectory", "trajectories", "tool_calls"]})
            with col2:
                if "user_input" in selected_eval:
                    st.text_area("User Input", selected_eval["user_input"], height=100)
                if "agent_response" in selected_eval:
                    st.text_area("Agent Response", selected_eval["agent_response"], height=100)
                elif "final_response" in selected_eval:
                    st.text_area("Final Response", selected_eval["final_response"], height=100)
            
            # Display conversation history if available
            if "conversation_history" in selected_eval and selected_eval["conversation_history"]:
                st.subheader("Full Conversation")
                with st.expander("View Conversation History", expanded=False):
                    for i, message in enumerate(selected_eval["conversation_history"]):
                        role = message.get("role", "unknown")
                        content = message.get("content", "")
                        if role == "user":
                            st.markdown(f"**User:** {content}")
                        elif role == "assistant":
                            st.markdown(f"**Agent:** {content}")
            
            # Display trajectory if available
            if "trajectory" in selected_eval and selected_eval["trajectory"]:
                st.divider()
                st.subheader("🔍 Execution Trajectory")
                trajectory = selected_eval["trajectory"]
                
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

