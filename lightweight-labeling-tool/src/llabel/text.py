# Adapted from koaning/molabel
"""Text labeling widget for classification tasks."""

from datetime import datetime
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional

import traitlets

from .base import BaseLabelWidget
from .utils import autocast_render


class TextLabel(BaseLabelWidget):
    """
    Widget for labeling text examples.

    Supports binary classification (yes/no/skip) and custom render functions
    for flexible display of examples.
    """

    # Additional traitlets specific to text widget
    current_rendered = traitlets.Unicode("").tag(sync=True)
    examples_data = traitlets.List([]).tag(sync=True)

    # JavaScript and CSS
    _esm = Path(__file__).parent / "static" / "text-widget.js"
    _css = Path(__file__).parent / "static" / "text-widget.css"

    def __init__(
        self,
        examples: List[Dict[str, Any]],
        render: Callable[[Dict[str, Any]], Any],
        shortcuts: Optional[Dict[str, str]] = None,
        notes: bool = True,
    ):
        """
        Initialize the text labeling widget.

        Args:
            examples: List of example dicts to label
            render: Function that takes an example dict and returns displayable format
            shortcuts: Custom keyboard shortcut mapping
            notes: Enable notes field
        """
        # Render all examples and store with _html key (molabel approach)
        rendered_examples = [
            {**ex, "_html": autocast_render(render(ex.copy()))}
            for ex in examples
        ]

        super().__init__(examples=rendered_examples, shortcuts=shortcuts, notes=notes)

        # Sync examples to frontend
        self.examples_data = rendered_examples

        # Render initial example
        self._update_rendered()

        # Set up observers
        self.observe(self._on_index_change, names=["current_index"])
        self.observe(self._on_annotation_update, names=["annotations"])

    def _update_rendered(self):
        """Update the rendered content for current example."""
        if 0 <= self.current_index < len(self.examples):
            self.current_rendered = self.examples[self.current_index].get("_html", "")

    def _on_index_change(self, change):
        """Handle index changes."""
        self._update_rendered()

    def _on_annotation_update(self, change):
        """Handle annotation updates from frontend."""
        # Sync annotations from frontend
        pass

    def label_current(self, label: str, notes: str = ""):
        """
        Label the current example.

        Args:
            label: The label to assign ('yes', 'no', or 'skip')
            notes: Optional notes
        """
        if 0 <= self.current_index < len(self.examples):
            self.annotations[self.current_index] = {
                "index": self.current_index,
                "label": label,
                "notes": notes,
                "timestamp": datetime.now().isoformat(),
                "rendered": self.current_rendered,
            }

    def next(self):
        """Move to next example."""
        if self.current_index < len(self.examples) - 1:
            self.current_index += 1

    def prev(self):
        """Move to previous example."""
        if self.current_index > 0:
            self.current_index -= 1
