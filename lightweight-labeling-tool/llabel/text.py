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

    # JavaScript and CSS
    _esm = Path(__file__).parent / "static" / "text-widget.js"
    _css = Path(__file__).parent / "static" / "text-widget.css"

    def __init__(
        self,
        examples: List[Any],
        render: Optional[Callable[[Any], Any]] = None,
        shortcuts: Optional[Dict[str, str]] = None,
        notes: bool = True,
        **kwargs,
    ):
        """
        Initialize the text labeling widget.

        Args:
            examples: List of examples to label (any type)
            render: Function to convert example to displayable format
                   If None, uses str() conversion
            shortcuts: Custom keyboard shortcut mapping
            notes: Enable notes field
            **kwargs: Additional arguments passed to parent
        """
        super().__init__(examples=examples, shortcuts=shortcuts, notes=notes, **kwargs)

        # Store render function
        self.render_fn = render if render else str

        # Render initial example
        self._update_rendered()

        # Set up observers
        self.observe(self._on_index_change, names=["current_index"])
        self.observe(self._on_annotation_update, names=["annotations"])

    def _update_rendered(self):
        """Update the rendered content for current example."""
        if 0 <= self.current_index < len(self.examples):
            example = self.examples[self.current_index]
            rendered = self.render_fn(example)
            self.current_rendered = autocast_render(rendered)

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
