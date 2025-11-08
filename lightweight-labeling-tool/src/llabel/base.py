# Adapted from koaning/molabel
"""Base widget class for labeling tasks."""

from datetime import datetime
from enum import Enum
from typing import Any, Callable, Dict, List, Optional

import anywidget
import traitlets


class Action(str, Enum):
    """Available user actions."""

    PREV = "prev"
    YES = "yes"
    NO = "no"
    SKIP = "skip"
    FOCUS_NOTES = "focus_notes"
    SPEECH_NOTES = "speech_notes"


class BaseLabelWidget(anywidget.AnyWidget):
    """
    Base class for labeling widgets.

    Provides common functionality for navigating examples,
    recording annotations, and managing keyboard shortcuts.
    """

    # Override ipywidgets traits to prevent conflicts with Marimo (Marimo compatibility)
    layout = traitlets.Any(default_value=None, allow_none=True)
    comm = traitlets.Any(default_value=None, allow_none=True)

    # Traitlets for state synchronization
    current_index = traitlets.Int(0).tag(sync=True)
    annotations = traitlets.List([]).tag(sync=True)
    total = traitlets.Int(0).tag(sync=True)
    keyboard_shortcuts = traitlets.Dict({}).tag(sync=True)
    enable_notes = traitlets.Bool(False).tag(sync=True)

    def __init__(
        self,
        examples: List[Any],
        shortcuts: Optional[Dict[str, str]] = None,
        notes: bool = False,
    ):
        """
        Initialize the base labeling widget.

        Args:
            examples: List of examples to label
            shortcuts: Custom keyboard shortcut mapping (key -> action)
            notes: Enable notes field
        """
        super().__init__()

        self.examples = examples
        self.total = len(examples)
        self.enable_notes = notes

        # Initialize annotations as empty list (molabel approach)
        self.annotations = []

        # Set up keyboard shortcuts
        default_shortcuts = {
            "alt+1": Action.PREV,
            "alt+2": Action.YES,
            "alt+3": Action.NO,
            "alt+4": Action.SKIP,
            "alt+5": Action.FOCUS_NOTES,
            "alt+6": Action.SPEECH_NOTES,
        }

        if shortcuts:
            self.keyboard_shortcuts = self._process_shortcuts(shortcuts)
        else:
            self.keyboard_shortcuts = default_shortcuts

    def _process_shortcuts(self, shortcuts: Dict[str, str]) -> Dict[str, str]:
        """
        Validate and process keyboard shortcuts.

        Args:
            shortcuts: User-provided shortcut mapping

        Returns:
            Validated shortcut dictionary

        Raises:
            ValueError: If shortcuts are invalid
        """
        processed = {}
        valid_actions = {a.value for a in Action}

        for key, action in shortcuts.items():
            if not isinstance(key, str):
                raise ValueError(f"Shortcut key must be string, got {type(key)}")

            if action not in valid_actions:
                raise ValueError(
                    f"Invalid action '{action}'. Must be one of {valid_actions}"
                )

            processed[key.lower()] = action

        return processed

    def get_annotations(self) -> List[Dict[str, Any]]:
        """
        Get all annotations.

        Returns:
            List of annotation dictionaries
        """
        return self.annotations

    def get_labeled_annotations(self) -> List[Dict[str, Any]]:
        """
        Get only labeled annotations (skip those with label=None).

        Returns:
            List of labeled annotation dictionaries
        """
        return [a for a in self.annotations if a.get("_label") is not None]

    def export_annotations(self, include_examples: bool = False) -> List[Dict[str, Any]]:
        """
        Export annotations in a serializable format.

        Args:
            include_examples: Whether to include example data

        Returns:
            List of annotation dictionaries
        """
        exported = []
        for annotation in self.get_labeled_annotations():
            item = {
                "index": annotation["index"],
                "label": annotation.get("_label"),
                "notes": annotation.get("_notes", ""),
                "timestamp": annotation.get("_timestamp"),
            }

            if include_examples:
                # Use the example from annotation if available, otherwise lookup
                item["example"] = annotation.get("example", self.examples[annotation["index"]])

            exported.append(item)

        return exported

    def reset(self):
        """Reset all annotations and return to first example."""
        self.current_index = 0
        self.annotations = []

    def progress(self) -> Dict[str, int]:
        """
        Get labeling progress statistics.

        Returns:
            Dictionary with progress information
        """
        labeled = len(self.get_labeled_annotations())
        return {
            "total": self.total,
            "labeled": labeled,
            "remaining": self.total - labeled,
            "percent": round(labeled / self.total * 100, 1) if self.total > 0 else 0,
        }
