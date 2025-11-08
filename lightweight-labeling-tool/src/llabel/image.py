# Adapted from koaning/molabel
"""Image labeling widget for annotation tasks."""

from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional, Union

import traitlets

from .base import BaseLabelWidget
from .utils import to_data_uri


class ImageLabel(BaseLabelWidget):
    """
    Widget for labeling images with bounding boxes, points, or polygons.

    Supports multiple image formats: URLs, file paths, PIL Images, NumPy arrays.
    """

    # Additional traitlets specific to image widget
    srcs = traitlets.List([]).tag(sync=True)
    classes = traitlets.List([]).tag(sync=True)
    colors = traitlets.List([]).tag(sync=True)
    current_src = traitlets.Unicode("").tag(sync=True)
    annotation_mode = traitlets.Unicode("bbox").tag(sync=True)  # bbox, point, polygon

    # JavaScript and CSS
    _esm = Path(__file__).parent / "static" / "image-widget.js"
    _css = Path(__file__).parent / "static" / "image-widget.css"

    def __init__(
        self,
        images: Optional[List[Any]] = None,
        paths: Optional[List[str]] = None,
        classes: Optional[List[str]] = None,
        colors: Optional[List[str]] = None,
        mode: str = "bbox",
        shortcuts: Optional[Dict[str, str]] = None,
    ):
        """
        Initialize the image labeling widget.

        Args:
            images: List of images (PIL, numpy, URLs, etc.)
            paths: Alternative to images - list of file paths
            classes: List of class names for classification
            colors: List of colors for each class (CSS color strings)
            mode: Annotation mode - 'bbox', 'point', or 'polygon'
            shortcuts: Custom keyboard shortcut mapping
        """
        # Process image sources
        if images is not None:
            sources = images
        elif paths is not None:
            sources = paths
        else:
            raise ValueError("Either 'images' or 'paths' must be provided")

        # Convert all sources to data URIs
        self._original_sources = sources
        self.srcs = [to_data_uri(src, "image/png") for src in sources]

        # Initialize parent with dummy examples (we use srcs instead)
        super().__init__(examples=sources, shortcuts=shortcuts, notes=False)

        # Set classes and colors
        self.classes = classes or []
        if colors:
            self.colors = colors
        elif len(self.classes) > 0:
            # Generate default colors
            self.colors = self._generate_colors(len(self.classes))
        else:
            self.colors = []

        # Set annotation mode
        if mode not in ["bbox", "point", "polygon"]:
            raise ValueError("mode must be 'bbox', 'point', or 'polygon'")
        self.annotation_mode = mode

        # Initialize annotations with proper structure
        self.annotations = [
            {
                "index": i,
                "elements": [],  # List of {type, coords, class_idx}
                "timestamp": None,
            }
            for i in range(len(self.srcs))
        ]

        # Set current image
        if len(self.srcs) > 0:
            self.current_src = self.srcs[0]

        # Set up observers
        self.observe(self._on_index_change, names=["current_index"])

    def _generate_colors(self, n: int) -> List[str]:
        """Generate n distinct colors."""
        colors = [
            "#FF6B6B",  # Red
            "#4ECDC4",  # Teal
            "#45B7D1",  # Blue
            "#FFA07A",  # Light Salmon
            "#98D8C8",  # Mint
            "#F7DC6F",  # Yellow
            "#BB8FCE",  # Purple
            "#85C1E2",  # Sky Blue
        ]

        # Repeat if we need more colors
        while len(colors) < n:
            colors.extend(colors)

        return colors[:n]

    def _on_index_change(self, change):
        """Handle index changes."""
        if 0 <= self.current_index < len(self.srcs):
            self.current_src = self.srcs[self.current_index]

    def get_normalized_annotations(
        self, image_width: int = None, image_height: int = None
    ) -> List[Dict[str, Any]]:
        """
        Convert relative coordinates to absolute pixel coordinates.

        Args:
            image_width: Image width in pixels (required if not using PIL)
            image_height: Image height in pixels (required if not using PIL)

        Returns:
            List of annotations with absolute coordinates
        """
        normalized = []

        for i, annotation in enumerate(self.annotations):
            if annotation["elements"]:
                # Try to get image dimensions
                width, height = None, None

                try:
                    from PIL import Image

                    # Try to open original source
                    source = self._original_sources[i]
                    if isinstance(source, str) and not source.startswith("http"):
                        img = Image.open(source)
                        width, height = img.size
                    elif hasattr(source, "size"):
                        width, height = source.size
                except:
                    pass

                # Use provided dimensions if image dimensions not available
                if width is None:
                    width = image_width
                if height is None:
                    height = image_height

                if width is None or height is None:
                    raise ValueError(
                        "Cannot normalize coordinates without image dimensions"
                    )

                # Normalize elements
                norm_elements = []
                for elem in annotation["elements"]:
                    norm_elem = {
                        "type": elem["type"],
                        "class_idx": elem.get("class_idx"),
                        "coords": [],
                    }

                    # Convert relative (0-1) to absolute coordinates
                    coords = elem["coords"]
                    if elem["type"] == "bbox":
                        # [x1, y1, x2, y2] relative to absolute
                        norm_elem["coords"] = [
                            coords[0] * width,
                            coords[1] * height,
                            coords[2] * width,
                            coords[3] * height,
                        ]
                    elif elem["type"] == "point":
                        # [x, y] relative to absolute
                        norm_elem["coords"] = [coords[0] * width, coords[1] * height]
                    elif elem["type"] == "polygon":
                        # List of [x, y] pairs
                        norm_elem["coords"] = [
                            [x * width, y * height] for x, y in coords
                        ]

                    norm_elements.append(norm_elem)

                normalized.append(
                    {
                        "index": i,
                        "elements": norm_elements,
                        "timestamp": annotation["timestamp"],
                    }
                )

        return normalized

    def next(self):
        """Move to next image."""
        if self.current_index < len(self.srcs) - 1:
            self.current_index += 1

    def prev(self):
        """Move to previous image."""
        if self.current_index > 0:
            self.current_index -= 1
