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
        **kwargs,
    ):
        """
        Initialize the base labeling widget.

        Args:
            examples: List of examples to label
            shortcuts: Custom keyboard shortcut mapping (key -> action)
            notes: Enable notes field
            **kwargs: Additional arguments passed to parent
        """
        # Set layout to None to avoid Marimo compatibility issues
        kwargs.setdefault('layout', None)
        super().__init__(**kwargs)

        self.examples = examples
        self.total = len(examples)
        self.enable_notes = notes

        # Initialize annotations
        self.annotations = [
            {
                "index": i,
                "label": None,
                "notes": "",
                "timestamp": None,
            }
            for i in range(len(examples))
        ]

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
        return [a for a in self.annotations if a["label"] is not None]

    def export_annotations(self, include_examples: bool = False) -> List[Dict[str, Any]]:
        """
        Export annotations in a serializable format.

        Args:
            include_examples: Whether to include example data

        Returns:
            List of annotation dictionaries
        """
        exported = []
        for i, annotation in enumerate(self.get_labeled_annotations()):
            item = {
                "index": annotation["index"],
                "label": annotation["label"],
                "notes": annotation["notes"],
                "timestamp": annotation["timestamp"],
            }

            if include_examples:
                item["example"] = self.examples[i]

            exported.append(item)

        return exported

    def reset(self):
        """Reset all annotations and return to first example."""
        self.current_index = 0
        self.annotations = [
            {
                "index": i,
                "label": None,
                "notes": "",
                "timestamp": None,
            }
            for i in range(len(self.examples))
        ]

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
