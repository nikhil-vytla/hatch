"""Customer support chatbot agent using LangChain v1.0+."""

import os
from typing import List, Dict, Any, Optional, Union, Tuple
from pathlib import Path
from langchain_openai import ChatOpenAI
from langchain.agents import create_agent
from langchain_core.messages import HumanMessage, AIMessage, ToolMessage
from agent.tools import lookup_refund_policy, check_booking_status
from agent.mock_agent import MockCustomerSupportAgent

# Load .env file if it exists
try:
    from dotenv import load_dotenv
    env_path = Path(__file__).parent.parent / ".env"
    if env_path.exists():
        load_dotenv(env_path)
except ImportError:
    # python-dotenv not installed, skip .env loading
    pass
except Exception:
    # If .env loading fails, continue without it
    pass

# Initialize agent (only if API key is available)
_agent = None

def _initialize_agent():
    """Initialize the real agent if API key is available."""
    global _agent
    if _agent is None:
        api_key = os.getenv("OPENAI_API_KEY")
        if not api_key:
            print("Warning: OPENAI_API_KEY not set. Agent will not be initialized.")
            return False
        
        try:
            # Create model
            model = ChatOpenAI(
                model="gpt-4o-mini",
                temperature=0,
                api_key=api_key,
            )
            
            # Create tools list
            tools = [lookup_refund_policy, check_booking_status]
            
            # Create agent using LangChain v1.0+ API
            # See: https://docs.langchain.com/oss/python/langchain/agents
            _agent = create_agent(
                model=model,
                tools=tools,
                system_prompt="""You are a helpful customer support agent for an airline.
You can help customers with:
- Checking booking status
- Looking up refund policies

Always be polite, accurate, and only provide information you can verify through your tools.
If you don't know something or cannot verify it, say so clearly.
Never make up refund policies or booking information."""
            )
            print("Agent initialized successfully.")
            return True
        except Exception as e:
            print(f"Error initializing agent: {e}")
            import traceback
            traceback.print_exc()
            return False
    return _agent is not None


class CustomerSupportAgent:
    """Customer support agent that handles multi-turn conversations."""
    
    def __init__(self, use_mock: Optional[bool] = None):
        """
        Initialize agent.
        
        Args:
            use_mock: If True, use mock agent. If False, use real agent. If None, auto-detect.
        """
        self.conversation_history: List[Dict[str, Any]] = []
        self.use_mock = use_mock
        self._mock_agent: Optional[MockCustomerSupportAgent] = None
        
        # Auto-detect: use mock if no API key or if explicitly requested
        if use_mock is None:
            self.use_mock = not bool(os.getenv("OPENAI_API_KEY"))
        
        if self.use_mock:
            self._mock_agent = MockCustomerSupportAgent()
        else:
            # Initialize agent if not already initialized
            if _agent is None:
                _initialize_agent()
    
    def chat(self, user_input: str, return_trajectory: bool = False) -> Union[str, Tuple[str, Dict[str, Any]]]:
        """
        Process a user message and return agent response.
        
        Args:
            user_input: User's message
            return_trajectory: If True, return (response, trajectory) tuple
        
        Returns:
            Agent's response, or (response, trajectory) if return_trajectory=True
        """
        if self.use_mock and self._mock_agent:
            agent_response, trajectory = self._mock_agent.chat(user_input, return_trajectory=True)
            # Update conversation history for consistency
            self.conversation_history.append({"role": "user", "content": user_input})
            self.conversation_history.append({"role": "assistant", "content": agent_response})
            if return_trajectory:
                return agent_response, trajectory
            return agent_response
        
        # Use real agent
        if _agent is None:
            error_msg = "Error: Agent not initialized. Please set OPENAI_API_KEY or use mock API mode."
            # Still update history with error message so user can see it
            self.conversation_history.append({"role": "user", "content": user_input})
            self.conversation_history.append({"role": "assistant", "content": error_msg})
            if return_trajectory:
                error_trajectory = {
                    "user_input": user_input,
                    "agent_reasoning": None,
                    "tool_calls": [],
                    "response": error_msg
                }
                return error_msg, error_trajectory
            return error_msg
        
        # Convert conversation history to LangChain message format
        # LangChain v1.0+ uses message objects or dict format
        messages = []
        for turn in self.conversation_history[-10:]:  # Keep last 10 turns for context
            if turn["role"] == "user":
                messages.append(HumanMessage(content=turn["content"]))
            elif turn["role"] == "assistant":
                messages.append(AIMessage(content=turn["content"]))
        
        # Add current user message
        messages.append(HumanMessage(content=user_input))
        
        # Execute agent using LangChain v1.0+ API
        # See: https://docs.langchain.com/oss/python/langchain/agents
        trajectory = {
            "user_input": user_input,
            "agent_reasoning": None,  # Not directly available from LangChain
            "tool_calls": [],
            "response": None
        }
        
        try:
            result = _agent.invoke({
                "messages": messages
            })
            
            # Extract messages from result
            result_messages = []
            if hasattr(result, "messages") and result.messages:
                result_messages = result.messages
            elif isinstance(result, dict) and "messages" in result:
                result_messages = result["messages"]
            
            # Extract tool calls and tool results from messages
            tool_call_map = {}  # tool_call_id -> tool_call
            tool_result_map = {}  # tool_call_id -> tool_result
            
            for msg in result_messages:
                # Check for AIMessage with tool_calls
                if isinstance(msg, AIMessage) and hasattr(msg, "tool_calls") and msg.tool_calls:
                    for tool_call in msg.tool_calls:
                        tool_call_id = tool_call.get("id") if isinstance(tool_call, dict) else getattr(tool_call, "id", None)
                        tool_name = tool_call.get("name") if isinstance(tool_call, dict) else getattr(tool_call, "name", None)
                        tool_args = tool_call.get("args") if isinstance(tool_call, dict) else getattr(tool_call, "args", {})
                        
                        if tool_call_id:
                            tool_call_map[tool_call_id] = {
                                "tool_name": tool_name,
                                "inputs": tool_args if isinstance(tool_args, dict) else {},
                                "id": tool_call_id
                            }
                
                # Check for ToolMessage with tool results
                elif isinstance(msg, ToolMessage):
                    tool_call_id = msg.tool_call_id if hasattr(msg, "tool_call_id") else getattr(msg, "tool_call_id", None)
                    tool_content = msg.content if hasattr(msg, "content") else str(msg)
                    if tool_call_id:
                        tool_result_map[tool_call_id] = tool_content
            
            # Match tool calls with their results
            step = 0
            for tool_call_id, tool_call_info in tool_call_map.items():
                step += 1
                tool_result = tool_result_map.get(tool_call_id, "No result available")
                trajectory["tool_calls"].append({
                    "tool_name": tool_call_info["tool_name"],
                    "inputs": tool_call_info["inputs"],
                    "outputs": tool_result if isinstance(tool_result, str) else str(tool_result),
                    "step": step
                })
            
            # Extract the final message content
            agent_response = None
            if result_messages:
                last_message = result_messages[-1]
                if hasattr(last_message, "content"):
                    agent_response = last_message.content
                elif isinstance(last_message, dict) and "content" in last_message:
                    agent_response = last_message["content"]
                else:
                    agent_response = str(last_message)
            elif isinstance(result, dict):
                if "output" in result:
                    agent_response = result["output"]
                elif "content" in result:
                    agent_response = result["content"]
                else:
                    agent_response = str(result)
            elif hasattr(result, "content"):
                agent_response = result.content
            
            # Fallback: convert to string
            if agent_response is None:
                agent_response = str(result) if result else "I apologize, but I couldn't generate a response."
            
            trajectory["response"] = agent_response
                
        except Exception as e:
            import traceback
            agent_response = f"I apologize, but I encountered an error: {str(e)}\n\nDebug: {traceback.format_exc()}"
            trajectory["response"] = agent_response
        
        # Update conversation history
        self.conversation_history.append({"role": "user", "content": user_input})
        self.conversation_history.append({"role": "assistant", "content": agent_response})
        
        if return_trajectory:
            return agent_response, trajectory
        return agent_response
    
    def reset(self):
        """Reset conversation history."""
        self.conversation_history = []
        if self._mock_agent:
            self._mock_agent.reset()
    
    def get_history(self) -> List[Dict[str, Any]]:
        """Get conversation history."""
        return self.conversation_history
    
    def get_mock_agent(self) -> Optional[MockCustomerSupportAgent]:
        """Get the mock agent if in mock mode."""
        return self._mock_agent

