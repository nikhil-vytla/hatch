# Adapted from koaning/molabel
"""Utility functions for data conversion and processing."""

import base64
from io import BytesIO
from pathlib import Path
from typing import Any, Union


def autocast_render(output: Any) -> str:
    """
    Convert render function output to HTML string.

    Tries multiple conversion methods in order:
    1. _repr_html_() method
    2. _repr_markdown_() method
    3. str() conversion

    Args:
        output: The output from a render function

    Returns:
        HTML string representation
    """
    if hasattr(output, "_repr_html_"):
        return output._repr_html_()
    elif hasattr(output, "_repr_markdown_"):
        md = output._repr_markdown_()
        # Simple markdown to HTML conversion for common cases
        md = md.replace("\n", "<br>")
        return md
    else:
        return str(output)


def to_data_uri(source: Union[str, bytes, Any], mime_type: str = None) -> str:
    """
    Convert various input formats to data URI.

    Handles:
    - URLs (http/https) - returned as-is
    - Local file paths
    - Base64 strings (if already data URI)
    - PIL/Pillow Image objects
    - NumPy arrays
    - BytesIO objects
    - Raw bytes

    Args:
        source: The input to convert
        mime_type: MIME type (auto-detected if None)

    Returns:
        Data URI string or URL
    """
    # If it's already a URL, return as-is
    if isinstance(source, str):
        if source.startswith(("http://", "https://", "data:")):
            return source

        # Try as file path
        path = Path(source)
        if path.exists() and path.is_file():
            with open(path, "rb") as f:
                data = f.read()

            # Auto-detect MIME type from extension
            if mime_type is None:
                ext = path.suffix.lower()
                mime_map = {
                    ".jpg": "image/jpeg",
                    ".jpeg": "image/jpeg",
                    ".png": "image/png",
                    ".gif": "image/gif",
                    ".webp": "image/webp",
                    ".svg": "image/svg+xml",
                    ".mp4": "video/mp4",
                    ".webm": "video/webm",
                    ".pdf": "application/pdf",
                }
                mime_type = mime_map.get(ext, "application/octet-stream")

            b64 = base64.b64encode(data).decode("utf-8")
            return f"data:{mime_type};base64,{b64}"

    # Handle PIL Image
    try:
        from PIL import Image
        if isinstance(source, Image.Image):
            buffer = BytesIO()
            fmt = source.format or "PNG"
            source.save(buffer, format=fmt)
            data = buffer.getvalue()

            if mime_type is None:
                mime_type = f"image/{fmt.lower()}"

            b64 = base64.b64encode(data).decode("utf-8")
            return f"data:{mime_type};base64,{b64}"
    except ImportError:
        pass

    # Handle NumPy array
    try:
        import numpy as np
        if isinstance(source, np.ndarray):
            from PIL import Image

            # Convert to PIL Image
            if source.dtype != np.uint8:
                # Normalize to 0-255
                source = ((source - source.min()) / (source.max() - source.min()) * 255).astype(np.uint8)

            img = Image.fromarray(source)
            buffer = BytesIO()
            img.save(buffer, format="PNG")
            data = buffer.getvalue()

            if mime_type is None:
                mime_type = "image/png"

            b64 = base64.b64encode(data).decode("utf-8")
            return f"data:{mime_type};base64,{b64}"
    except (ImportError, ValueError):
        pass

    # Handle BytesIO
    if isinstance(source, BytesIO):
        data = source.getvalue()
        if mime_type is None:
            mime_type = "application/octet-stream"

        b64 = base64.b64encode(data).decode("utf-8")
        return f"data:{mime_type};base64,{b64}"

    # Handle raw bytes
    if isinstance(source, bytes):
        if mime_type is None:
            mime_type = "application/octet-stream"

        b64 = base64.b64encode(source).decode("utf-8")
        return f"data:{mime_type};base64,{b64}"

    # Fallback: convert to string
    return str(source)
