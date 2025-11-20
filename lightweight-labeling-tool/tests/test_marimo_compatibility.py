"""
Tests for Marimo compatibility and general widget functionality.
"""
import pytest
import sys
import os
from unittest.mock import MagicMock, patch

# Add project root to path
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

from llabel import TextLabel, ImageLabel

@pytest.fixture
def text_examples():
    return [{"text": "Example 1"}, {"text": "Example 2"}, {"text": "Example 3"}]

@pytest.fixture
def image_examples():
    # Using dummy paths/urls since we just want to test instantiation
    return ["https://example.com/1.jpg", "https://example.com/2.jpg"]

def test_text_label_instantiation(text_examples):
    """Test that TextLabel can be instantiated with correct arguments."""
    widget = TextLabel(
        examples=text_examples,
        render=lambda x: x["text"],
        notes=True
    )
    assert widget.total == 3
    assert widget.enable_notes is True
    assert widget.current_index == 0
    assert len(widget.examples) == 3

def test_image_label_instantiation(image_examples):
    """Test that ImageLabel can be instantiated."""
    # Mock to_src to avoid network calls or file checks if any
    with patch('llabel.image.to_src', side_effect=lambda x: x):
        widget = ImageLabel(
            images=image_examples,
            classes=["cat", "dog"],
            colors=["red", "blue"]
        )
        # ImageLabel doesn't have 'total' attribute like TextLabel (which inherits from BaseLabelWidget)
        # So we check the length of the source list directly
        assert len(widget.srcs) == 2
        assert len(widget.classes) == 2
        assert widget.colors == {"cat": "red", "dog": "blue"}

def test_trait_compatibility(text_examples):
    """
    Verify that layout and comm traits are overridden for Marimo compatibility.
    They should accept any value (including None) without validation errors.
    """
    widget = TextLabel(
        examples=text_examples,
        render=lambda x: x["text"]
    )
    
    # Test layout trait
    # It might be None or initialized, but we should be able to set it to an arbitrary string
    widget.layout = "some_random_string"  # Should not raise error
    assert widget.layout == "some_random_string"
    
    # Test comm trait
    # It might be initialized (ipykernel.comm.Comm), but we should be able to set it to anything
    mock_comm = MagicMock()
    widget.comm = mock_comm  # Should not raise error
    assert widget.comm == mock_comm

def test_render_function(text_examples):
    """Test that the render function is applied correctly."""
    def custom_render(item):
        return f"Rendered: {item['text']}"

    widget = TextLabel(
        examples=text_examples,
        render=custom_render
    )
    
    # Check if internal examples have the _html key with rendered content
    # Note: internal implementation detail, but useful for verifying render logic
    assert widget.examples_data[0]["_html"] == "Rendered: Example 1"

def test_annotation_methods(text_examples):
    """Test annotation retrieval methods."""
    widget = TextLabel(
        examples=text_examples,
        render=lambda x: x["text"]
    )
    
    # Initially empty
    assert len(widget.get_annotations()) == 0
    assert widget.progress()["labeled"] == 0
    
    # Simulate an annotation (modifying internal state directly as we can't click UI)
    widget.annotations = [
        {"index": 0, "_label": "positive", "_timestamp": 1234567890}
    ]
    
    assert len(widget.get_annotations()) == 1
    assert len(widget.get_labeled_annotations()) == 1
    assert widget.progress()["labeled"] == 1
    assert widget.progress()["percent"] == 33.3
