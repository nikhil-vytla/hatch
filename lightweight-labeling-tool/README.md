# llabel - Lightweight Labeling Widgets

A lightweight, extensible data labeling toolkit for Jupyter notebooks, inspired by [koaning/molabel](https://github.com/koaning/molabel) and built on [anywidget](https://anywidget.dev).

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
pip install -e .

# With optional dependencies
pip install -e ".[image]"      # Image support (Pillow, NumPy)
pip install -e ".[all]"         # All features
pip install -e ".[dev]"         # Development tools
```

## Quick Start

### Text Labeling

```python
from llabel import TextLabel

# Simple text classification
texts = [
    "I love this product!",
    "Terrible experience.",
    "It's okay, nothing special."
]

widget = TextLabel(
    examples=texts,
    notes=True  # Enable notes field
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

# Create or load images
images = [
    np.random.randint(0, 255, (400, 600, 3), dtype=np.uint8),
    # ... more images
]

widget = ImageLabel(
    images=images,
    classes=["person", "car", "bicycle"],
    mode="bbox"  # or "point", "polygon"
)

widget
```

**Features:**
- Three annotation modes: bounding boxes, points, polygons
- Multi-class support with color coding
- Multiple input formats (NumPy, PIL, file paths, URLs)
- Coordinate normalization
- COCO format export

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

### Image Annotation Modes

**Bounding Boxes:**
```python
widget = ImageLabel(images=images, classes=["cat", "dog"], mode="bbox")
```
- Click and drag to draw boxes
- Auto-saves on release

**Points:**
```python
widget = ImageLabel(images=images, classes=["nose", "eye"], mode="point")
```
- Click to place points
- Ideal for keypoint annotation

**Polygons:**
```python
widget = ImageLabel(images=images, classes=["object"], mode="polygon")
```
- Click to place vertices
- Close polygon by clicking near first point

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

### Image Widget
- `←/→`: Navigate images
- `Esc`: Cancel current drawing
- `1-9`: Quick class selection (if < 10 classes)

## Architecture

### Design Principles

1. **Minimal dependencies**: anywidget + traitlets (+ optional Pillow/NumPy)
2. **Extensible base class**: Easy to add new widget types
3. **Flexible rendering**: Custom functions for any data format
4. **State synchronization**: Traitlets handle Python ↔ JavaScript communication
5. **Modern frontend**: ES modules + CSS, no build step required

### Package Structure

```
llabel/
├── __init__.py       # Package exports
├── base.py           # Base widget class
├── text.py           # Text labeling widget
├── image.py          # Image labeling widget
├── video.py          # Video widget design (future)
├── pdf.py            # PDF widget design (future)
├── utils.py          # Shared utilities
└── static/
    ├── text-widget.js
    ├── text-widget.css
    ├── image-widget.js
    └── image-widget.css
```

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
- Compatible with SAM for segmentation
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

## Comparison with molabel

| Feature | llabel | molabel |
|---------|--------|---------|
| Text labeling | ✅ | ✅ |
| Image labeling | ✅ | ✅ |
| Custom render | ✅ | ✅ |
| Keyboard shortcuts | ✅ | ✅ |
| Gamepad support | ❌ | ✅ |
| Speech-to-text | ❌ | ✅ |
| Multiple annotation modes | ✅ (bbox/point/polygon) | ⚠️ (basic) |
| Video support | 🚧 (designed) | ❌ |
| PDF support | 🚧 (designed) | ❌ |
| Base class architecture | ✅ | ❌ |

## Development

```bash
# Install development dependencies
pip install -e ".[dev]"

# Run tests
pytest

# Format code
black llabel/
ruff llabel/

# Enable HMR for development
export ANYWIDGET_HMR=1
```

## Examples & Notebooks

See the `notebooks/` directory for complete examples:

- `01_text_labeling_demo.ipynb`: Text classification with custom rendering
- `02_image_labeling_demo.ipynb`: Image annotation (bbox, point, polygon)

## Credits

This project is inspired by and adapted from [koaning/molabel](https://github.com/koaning/molabel) by Vincent D. Warmerdam. The core architecture follows molabel's elegant design while extending it for additional media types and annotation modes.

Built on [anywidget](https://anywidget.dev) by Trevor Manz.

## License

MIT License

## Contributing

Contributions welcome! Areas of interest:

- [ ] Implementing video labeling widget
- [ ] Implementing PDF labeling widget
- [ ] Adding gamepad support
- [ ] Adding speech-to-text integration
- [ ] Improving mobile responsiveness
- [ ] Additional export formats
- [ ] More annotation modes
