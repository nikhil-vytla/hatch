# Adapted from koaning/molabel
"""Image labeling widget for annotation tasks."""

from pathlib import Path
from typing import Any, Dict, List, Optional, Union
import base64
from io import BytesIO

import anywidget
import traitlets


def to_src(input_data: Union[str, Any]) -> str:
    """Converts various input types to a data URI string for display in the widget.

    Supports:
    - URLs (http/https)
    - Local file paths
    - Base64 strings
    - PIL/Pillow Image objects
    - NumPy arrays
    - File-like objects (BytesIO, etc.)
    """
    # Handle string inputs (URLs, paths, or base64)
    if isinstance(input_data, str):
        # Check if it's a URL
        if input_data.startswith(("http://", "https://")):
            return input_data

        # Check if it's already a data URI
        if input_data.startswith("data:image/"):
            return input_data

        # Check if it's a base64 string (not a file path)
        if not Path(input_data).exists():
            # Try to decode it to verify it's valid base64
            try:
                base64.b64decode(input_data)
                return f"data:image/png;base64,{input_data}"
            except Exception:
                pass

        # Handle local file path
        path_obj = Path(input_data)
        with open(path_obj, "rb") as f:
            return f"data:image/{path_obj.suffix[1:]};base64," + base64.b64encode(f.read()).decode("utf-8")

    # Handle PIL/Pillow Image objects
    try:
        from PIL import Image
        if isinstance(input_data, Image.Image):
            buffered = BytesIO()
            format = input_data.format if input_data.format else "PNG"
            input_data.save(buffered, format=format)
            img_str = base64.b64encode(buffered.getvalue()).decode("utf-8")
            return f"data:image/{format.lower()};base64,{img_str}"
    except ImportError:
        pass

    # Handle numpy arrays
    try:
        import numpy as np
        if isinstance(input_data, np.ndarray):
            from PIL import Image
            img = Image.fromarray(input_data.astype('uint8'))
            buffered = BytesIO()
            img.save(buffered, format="PNG")
            img_str = base64.b64encode(buffered.getvalue()).decode("utf-8")
            return f"data:image/png;base64,{img_str}"
    except ImportError:
        pass

    # Handle file-like objects (BytesIO, etc.)
    if hasattr(input_data, 'read') and hasattr(input_data, 'seek'):
        input_data.seek(0)
        img_bytes = input_data.read()
        img_str = base64.b64encode(img_bytes).decode("utf-8")
        # Try to determine format from bytes
        format = "png"
        if img_bytes.startswith(b'\xff\xd8\xff'):
            format = "jpeg"
        elif img_bytes.startswith(b'\x89PNG'):
            format = "png"
        elif img_bytes.startswith(b'GIF89a') or img_bytes.startswith(b'GIF87a'):
            format = "gif"
        return f"data:image/{format};base64,{img_str}"

    raise TypeError(f"Unsupported input type: {type(input_data)}")


class ImageLabel(anywidget.AnyWidget):
    """
    An annotation tool for images.

    Args:
        images (list): A list of images to annotate. Each item can be:
            - URL string (http:// or https://)
            - Local file path string
            - Base64 encoded string
            - PIL/Pillow Image object
            - NumPy array
            - File-like object (BytesIO, etc.)
        classes (list, optional): A list of classes to use for annotation
        colors (dict or list, optional): Colors for each class. Can be dict mapping
            class names to colors, or list of colors in same order as classes
    """
    # JavaScript and CSS (read as text like molabel)
    _esm = (Path(__file__).parent / "static" / "image-widget.js").read_text()
    _css = (Path(__file__).parent / "static" / "image-widget.css").read_text()

    # Override ipywidgets traits to prevent conflicts with Marimo (Marimo compatibility)
    layout = traitlets.Any(default_value=None, allow_none=True)
    comm = traitlets.Any(default_value=None, allow_none=True)

    # Traitlets (molabel's simpler approach)
    srcs = traitlets.List([]).tag(sync=True)
    filenames = traitlets.List([]).tag(sync=True)
    annotations = traitlets.List([]).tag(sync=True)
    classes = traitlets.List([]).tag(sync=True)
    colors = traitlets.Dict({}).tag(sync=True)

    def __init__(self, images=None, paths=None, classes=None, colors=None, **kwargs):
        super().__init__(**kwargs)

        # Support both 'images' (new) and 'paths' (backward compatibility)
        input_items = images if images is not None else paths

        if input_items:
            self.srcs = [to_src(item) for item in input_items]
            self.filenames = [self._extract_filename(item) for item in input_items]
            self.annotations = [{"src": src, "elements": []} for src in self.srcs]
        if classes:
            self.classes = classes
        if colors:
            if isinstance(colors, list):
                if len(colors) != len(self.classes):
                    raise ValueError("The length of `colors` must match the length of `classes`.")
                self.colors = dict(zip(self.classes, colors))
            else:
                self.colors = colors

    def _extract_filename(self, item):
        """Extract a display filename from the input item."""
        if isinstance(item, str):
            # If it's a file path, extract filename
            if not item.startswith(("http://", "https://", "data:")):
                return Path(item).name
            # If it's a URL, extract the last segment
            if item.startswith(("http://", "https://")):
                return item.split("/")[-1].split("?")[0] or "image"
        # For other types (PIL, numpy, etc), use index-based name
        return f"image_{id(item) % 10000}"

    def _normalize_points(self, annotation: dict) -> dict:
        if "elements" not in annotation:
            return annotation

        elements = []
        for element in annotation["elements"]:
            points = []
            for point in element["points"]:
                points.append({
                    "x": int(point["x"] * element["imageDimensions"]["width"]),
                    "y": int(point["y"] * element["imageDimensions"]["height"])
                })
            new_element = {**element}
            new_element["points"] = points
            elements.append(new_element)
        return {
            **annotation,
            "elements": elements
        }

    def get_normalized_annotations(self):
        """
        Get the coordinates of the annotations for a given image.
        """
        return [self._normalize_points(annotation) for annotation in self.annotations]
