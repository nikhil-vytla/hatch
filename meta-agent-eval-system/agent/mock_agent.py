"""Mock agent for testing without OpenAI API."""

from typing import List, Dict, Any, Optional, Union, Tuple


class MockCustomerSupportAgent:
    """Mock customer support agent that uses manual responses."""
    
    def __init__(self):
        self.conversation_history: List[Dict[str, Any]] = []
        self.mock_responses: Dict[str, str] = {}  # user_input -> response
        self.default_response: str = "I understand your request. How can I help you today?"
        self.mock_tool_calls: Dict[str, List[Dict[str, Any]]] = {}  # user_input -> list of tool calls
        self.default_tool_calls: List[Dict[str, Any]] = []
    
    def set_mock_response(self, user_input: str, response: str):
        """Set a mock response for a specific user input."""
        self.mock_responses[user_input.lower().strip()] = response
    
    def set_default_response(self, response: str):
        """Set default response when no specific mock is found."""
        self.default_response = response
    
    def set_mock_tool_calls(self, user_input: str, tool_calls: List[Dict[str, Any]]):
        """
        Set mock tool calls for a specific user input.
        
        Args:
            user_input: User's message
            tool_calls: List of tool call dicts with keys: tool_name, inputs, outputs, step
        """
        self.mock_tool_calls[user_input.lower().strip()] = tool_calls
    
    def set_default_tool_calls(self, tool_calls: List[Dict[str, Any]]):
        """Set default tool calls when no specific mock is found."""
        self.default_tool_calls = tool_calls
    
    def chat(self, user_input: str, return_trajectory: bool = False) -> Union[str, Tuple[str, Dict[str, Any]]]:
        """
        Process a user message and return mock agent response.
        
        Args:
            user_input: User's message
            return_trajectory: If True, return (response, trajectory) tuple
        
        Returns:
            Mock agent's response, or (response, trajectory) if return_trajectory=True
        """
        # Check for specific mock response
        key = user_input.lower().strip()
        if key in self.mock_responses:
            agent_response = self.mock_responses[key]
        else:
            # Use default or check for partial matches
            agent_response = self._find_matching_response(user_input)
        
        # Get tool calls for this input
        tool_calls = []
        if key in self.mock_tool_calls:
            tool_calls = self.mock_tool_calls[key]
        elif self.default_tool_calls:
            tool_calls = self.default_tool_calls.copy()
        
        # Build trajectory
        trajectory = {
            "user_input": user_input,
            "agent_reasoning": None,
            "tool_calls": tool_calls,
            "response": agent_response
        }
        
        # Update conversation history
        self.conversation_history.append({"role": "user", "content": user_input})
        self.conversation_history.append({"role": "assistant", "content": agent_response})
        
        if return_trajectory:
            return agent_response, trajectory
        return agent_response
    
    def _find_matching_response(self, user_input: str) -> str:
        """Find a matching response based on keywords or return default."""
        user_lower = user_input.lower()
        
        # Check for keyword matches
        for mock_input, response in self.mock_responses.items():
            if mock_input in user_lower or user_lower in mock_input:
                return response
        
        return self.default_response
    
    def reset(self):
        """Reset conversation history."""
        self.conversation_history = []
    
    def get_history(self) -> List[Dict[str, Any]]:
        """Get conversation history."""
        return self.conversation_history
    
    def clear_mock_responses(self):
        """Clear all mock responses."""
        self.mock_responses = {}
        self.mock_tool_calls = {}
        self.default_tool_calls = []

