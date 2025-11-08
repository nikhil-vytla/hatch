# llabel - Lightweight Labeling Widgets

A lightweight, extensible data labeling toolkit for interactive notebooks (Jupyter, Marimo), inspired by [koaning/molabel](https://github.com/koaning/molabel) and built on [anywidget](https://anywidget.dev).

## Features

- **Lightweight**: Minimal dependencies, clean API
- **Extensible**: Easy to add new media types and annotation modes
- **Interactive**: Modern, responsive UI with keyboard shortcuts
- **Flexible**: Custom render functions, multiple annotation types
- **Export-friendly**: Standard formats (JSON, COCO, etc.)

## Supported Media Types

### ✅ Currently Implemented

- **Text**: Binary/multi-class classification with custom render functions
- **Images**: Bounding boxes, points, and polygons with multiple input formats

### 🚧 Planned Extensions

- **Video**: Frame-by-frame annotation with SAM integration
- **PDF**: Multi-page documents with text selection and region marking

## Installation

```bash
uv pip install -e .

# With optional dependencies
uv pip install -e ".[image]"      # Image support (Pillow, NumPy)
uv pip install -e ".[sam]"         # SAM integration (Segment Anything)
uv pip install -e ".[demos]"       # Run demo notebooks (HuggingFace datasets, SAM)
uv pip install -e ".[all]"         # All features
uv pip install -e ".[dev]"         # Development tools
```

## Quick Start

### Text Labeling

```python
from llabel import TextLabel

# TextLabel requires examples as a list of dicts
# and a render function to display them
examples = [
    {"text": "I love this product!"},
    {"text": "Terrible experience."},
    {"text": "It's okay, nothing special."}
]

widget = TextLabel(
    examples=examples,
    render=lambda ex: ex["text"],  # Extract text field from dict
    notes=True  # Enable notes field (default: True)
)

widget
```

**Features:**
- ✓ Yes/No/Skip buttons
- Keyboard shortcuts (Alt+1-6)
- Optional notes field
- Progress tracking
- Custom render functions

### Image Labeling

```python
from llabel import ImageLabel
import numpy as np
from PIL import Image

# ImageLabel accepts multiple input formats:
# - NumPy arrays
# - PIL/Pillow Image objects
# - File paths (strings)
# - URLs (http:// or https://)
# - Base64 encoded strings
# - File-like objects (BytesIO, etc.)

images = [
    np.random.randint(0, 255, (400, 600, 3), dtype=np.uint8),
    Image.open("path/to/image.jpg"),
    "https://example.com/image.png",
    # ... more images
]

# The widget handles all annotation types flexibly (no mode parameter)
widget = ImageLabel(
    images=images,  # or use paths=[] for backward compatibility
    classes=["person", "car", "bicycle"],
    colors=["red", "blue", "green"]  # Optional: list or dict
)

widget
```

**Features:**
- Multiple annotation types: bounding boxes, points, polygons (all supported simultaneously)
- Multi-class support with color coding
- Multiple input formats (NumPy arrays, PIL Images, file paths, URLs, base64, file-like objects)
- Coordinate normalization (relative 0-1 and absolute pixel coordinates)
- COCO format export

### Using with Marimo

When using in Marimo notebooks, wrap widgets with `mo.ui.anywidget()`:

```python
import marimo as mo
from llabel import TextLabel

# Create and wrap widget
# Note: examples must be a list of dicts, and render function is required
examples = [{"text": "Example 1"}, {"text": "Example 2"}]
widget = mo.ui.anywidget(
    TextLabel(examples=examples, render=lambda ex: ex["text"], notes=True)
)
widget  # Display the widget

# Access widget methods directly on the wrapped widget
annotations = widget.get_annotations()
progress = widget.progress()
```

## Usage Examples

### Custom Render Function

```python
def render_tweet(example):
    return f"""
    <div style="border-left: 4px solid #1DA1F2; padding: 16px;">
        <p style="font-size: 18px;">{example['text']}</p>
        <p style="color: #666;">@{example['author']} · {example['date']}</p>
    </div>
    """

widget = TextLabel(
    examples=tweet_data,
    render=render_tweet
)
```

### Export Annotations

```python
# Get all annotations
all_annotations = widget.get_annotations()

# Get only labeled examples
labeled = widget.get_labeled_annotations()

# Export with examples
export = widget.export_annotations(include_examples=True)

# Check progress
progress = widget.progress()
print(f"Progress: {progress['percent']}%")
```

### Image Annotation Types

The `ImageLabel` widget supports all annotation types simultaneously (no mode parameter needed):

**Bounding Boxes:**
- Click and drag to draw boxes
- Auto-saves on release
- Represented by 2 points (top-left and bottom-right corners)

**Points:**
- Click to place points
- Ideal for keypoint annotation
- Represented by 1 point

**Polygons:**
- Click to place vertices
- Close polygon by clicking near first point
- Represented by 3+ points

All annotation types can be used together in the same widget. The widget automatically distinguishes between them based on the number of points in each annotation.

### Export to COCO Format

```python
# Get normalized annotations (absolute pixel coordinates)
normalized = widget.get_normalized_annotations()

# Export to COCO format
def to_coco(widget, image_size):
    coco = {"images": [], "annotations": [], "categories": []}

    # Add categories
    for idx, cls in enumerate(widget.classes):
        coco["categories"].append({"id": idx, "name": cls})

    # Add annotations
    annotations = widget.get_normalized_annotations(
        image_width=image_size[0],
        image_height=image_size[1]
    )

    # ... process annotations
    return coco
```

## Keyboard Shortcuts

### Text Widget
- `Alt+1`: Previous
- `Alt+2`: Yes
- `Alt+3`: No
- `Alt+4`: Skip
- `Alt+5`: Focus notes
- `Alt+6`: Speech notes

## Demo Notebooks

Interactive Marimo notebooks are available in the `notebooks/` directory:

### 01_text_labeling_demo.py
Sentiment analysis with real IMDB movie reviews from HuggingFace datasets.

```bash
# Install demo dependencies
uv pip install -e ".[demos]"

# Run the notebook (use marimo edit for editable mode)
marimo run notebooks/01_text_labeling_demo.py
```

### 02_image_labeling_demo.py
Image annotation with bbox, point, and polygon modes. Demonstrates COCO format export.

```bash
# Run the notebook (use marimo edit for editable mode)
marimo run notebooks/02_image_labeling_demo.py
```

### 03_sam_integration_demo.py
**Segment Anything Model (SAM) integration!** Click points or draw boxes, and SAM automatically segments the objects.

```bash
# Install SAM dependencies (includes PyTorch, ~2.4GB model)
uv pip install -e ".[sam]"

# Run the notebook (use marimo edit for editable mode)
marimo run notebooks/03_sam_integration_demo.py
```

This notebook demonstrates:
- Loading and running SAM on CPU or GPU
- Using point prompts for segmentation
- Using box prompts for segmentation
- Visualizing segmentation masks
- Saving masked images

## Extending llabel

### Adding a New Widget

```python
from llabel.base import BaseLabelWidget
import traitlets

class MyCustomWidget(BaseLabelWidget):
    # Add custom traitlets
    custom_data = traitlets.Unicode("").tag(sync=True)

    # Define JS/CSS files
    _esm = Path(__file__).parent / "static" / "custom-widget.js"
    _css = Path(__file__).parent / "static" / "custom-widget.css"

    def __init__(self, examples, **kwargs):
        super().__init__(examples=examples, **kwargs)
        # Custom initialization
```

### Custom Render Functions

Render functions can return:
- Strings (converted to HTML)
- Objects with `_repr_html_()` method
- Objects with `_repr_markdown_()` method

```python
def render_with_markdown(example):
    class MarkdownWrapper:
        def _repr_markdown_(self):
            return f"# {example['title']}\n\n{example['content']}"
    return MarkdownWrapper()
```

## Future Extensions

### Video Labeling
- Frame-by-frame navigation with video player
- Temporal annotation propagation
- SAM (Segment Anything Model) integration
- Mask tracking across frames
- Activity labeling (time ranges)

**Key integrations:**
- Compatibility with SAM2 for segmentation
- Optical flow for tracking
- Export to video segmentation formats

### PDF Labeling
- Multi-page PDF rendering (PDF.js)
- Text selection and highlighting
- Region annotation for tables/figures
- Named entity recognition (NER)
- Export to SpaCy, COCO, annotated PDF

**Key integrations:**
- LayoutLM compatibility
- OCR integration for scanned documents
- Document layout analysis

## Development

```bash
# Install development dependencies
uv pip install -e ".[dev]"

# Run marimo notebooks
marimo edit notebooks/01_text_labeling_demo.py

# Run tests
pytest

# Format code
black llabel/
ruff llabel/

# Enable HMR for development
export ANYWIDGET_HMR=1
```

## Examples & Notebooks

See the `notebooks/` directory for complete examples (using [Marimo](https://marimo.io)):

- `01_text_labeling_demo.py`: Text classification with custom rendering
- `02_image_labeling_demo.py`: Image annotation (bbox, point, polygon)

**Running the examples:**

```bash
# Install marimo
uv pip install marimo

# Run as interactive notebook
marimo edit notebooks/01_text_labeling_demo.py

# Or run as app
marimo run notebooks/01_text_labeling_demo.py
```

The notebooks also work in Jupyter and other anywidget-compatible environments.

## Credits

This project is inspired by and adapted from [koaning/molabel](https://github.com/koaning/molabel) by Vincent D. Warmerdam. The core architecture follows molabel's elegant design while extending it for additional media types and annotation modes.

Built on [anywidget](https://anywidget.dev) by Trevor Manz.


## Contributing

Contributions welcome! Areas of interest:

- [ ] Implementing video labeling widget
- [ ] Implementing PDF labeling widget
- [ ] Improving mobile responsiveness
- [ ] Additional export formats
- [ ] More annotation modes
