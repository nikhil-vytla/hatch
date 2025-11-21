"""Streamlit UI for eval pipeline and taxonomy."""

import streamlit as st
import os
import uuid
from pathlib import Path

# Load .env file if it exists
try:
    from dotenv import load_dotenv
    env_path = Path(__file__).parent / ".env"
    if env_path.exists():
        load_dotenv(env_path)
except ImportError:
    # python-dotenv not installed, skip .env loading
    pass
except Exception:
    # If .env loading fails, continue without it
    pass
from agent.chatbot import CustomerSupportAgent
from ui.app_utils import load_eval_results, load_threads, save_threads
from ui.app_live_evals import render_live_evals_page
from ui.app_batch_evals import render_batch_evals_page
from ui.app_taxonomy import render_taxonomy_generator, render_taxonomy_explorer
from ui.app_auxiliary import render_auxiliary_tools_page

# Page config
st.set_page_config(
    page_title="Meta Agent Eval System",
    page_icon="🔒",
    layout="wide"
)

# Initialize session state
if "use_mock_mode" not in st.session_state:
    st.session_state.use_mock_mode = not bool(os.getenv("OPENAI_API_KEY"))


if "eval_results" not in st.session_state:
    st.session_state.eval_results = []

if "eval_data_loaded" not in st.session_state:
    st.session_state.eval_data_loaded = False




# Thread management - load from file or create default (must be after function definitions)
if "threads" not in st.session_state:
    loaded_threads = load_threads()
    if loaded_threads:
        st.session_state.threads = loaded_threads
    else:
        # Create default thread
        from datetime import datetime
        default_thread_id = str(uuid.uuid4())
        st.session_state.threads = {
            default_thread_id: {
                "name": default_thread_id,
                "history": [],
                "created_at": datetime.now().isoformat()
            }
        }
        save_threads(st.session_state.threads)

if "current_thread_id" not in st.session_state:
    st.session_state.current_thread_id = list(st.session_state.threads.keys())[0] if st.session_state.threads else None

# Initialize agent (after threads are loaded)
if "agent" not in st.session_state:
    st.session_state.agent = CustomerSupportAgent(use_mock=st.session_state.use_mock_mode)
    # Load current thread history into agent
    if st.session_state.current_thread_id and st.session_state.current_thread_id in st.session_state.threads:
        current_thread = st.session_state.threads[st.session_state.current_thread_id]
        st.session_state.agent.conversation_history = current_thread["history"].copy()

# Sidebar navigation
st.sidebar.title("🔒 Meta Agent Eval System")

# Mock mode toggle
use_mock = st.sidebar.checkbox("Use Mock API Mode", value=not bool(os.getenv("OPENAI_API_KEY")), help="Enable mock API mode to test without OpenAI API key")

# Main navigation
st.sidebar.markdown("### Live Evaluations")
if st.sidebar.button("📱 Run Live Evals", width='stretch'):
    st.session_state.last_section = "main"
    st.session_state.page = "Live Evals"
    st.rerun()

# Eval Dashboard section
st.sidebar.markdown("---")
st.sidebar.markdown("### Batch Evaluations")
if st.sidebar.button("📊 Run Batch Evals", width='stretch'):
    st.session_state.last_section = "eval"
    st.session_state.page = "Batch Evals"
    st.rerun()

# Taxonomy section
st.sidebar.markdown("---")
st.sidebar.markdown("### Taxonomy")
if st.sidebar.button("🧬 Taxonomy Generator", width='stretch'):
    st.session_state.last_section = "taxonomy"
    st.session_state.page = "Taxonomy Generator"
    st.rerun()
if st.sidebar.button("🔍 Taxonomy Explorer", width='stretch'):
    st.session_state.last_section = "taxonomy"
    st.session_state.page = "Taxonomy Explorer"
    st.rerun()

# Auxiliary tools section
st.sidebar.markdown("---")
st.sidebar.markdown("### Auxiliary Tools")
if st.sidebar.button("🛠️ Auxiliary Tools", width='stretch'):
    st.session_state.last_section = "auxiliary"
    st.session_state.page = "Auxiliary Tools"
    st.rerun()

# Determine which page to show
if "page" not in st.session_state:
    st.session_state.page = "Live Evals"
if "last_section" not in st.session_state:
    st.session_state.last_section = "main"

page = st.session_state.page

# Load eval results
if not st.session_state.eval_data_loaded:
    st.session_state.eval_results = load_eval_results()
    st.session_state.eval_data_loaded = True

# Update mock mode if changed (preserve conversation history)
if use_mock != st.session_state.use_mock_mode:
    # Save current history before recreating agent
    old_history = st.session_state.agent.get_history() if "agent" in st.session_state else []
    st.session_state.use_mock_mode = use_mock
    st.session_state.agent = CustomerSupportAgent(use_mock=use_mock)
    # Restore history if switching modes
    if old_history:
        # Restore history by manually adding messages back
        for msg in old_history:
            st.session_state.agent.conversation_history.append(msg)

# Route to appropriate page renderer
if page == "Live Evals":
    render_live_evals_page(use_mock)

elif page == "Batch Evals":
    render_batch_evals_page(use_mock)

elif page == "Auxiliary Tools":
    render_auxiliary_tools_page()

elif page == "Taxonomy Explorer":
    render_taxonomy_explorer()

elif page == "Taxonomy Generator":
    render_taxonomy_generator()
