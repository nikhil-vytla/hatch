# Development Notes - Lightweight Labeling Tool

## Goal
Build a lightweight data labeling tool inspired by molabel (https://github.com/koaning/molabel) using anywidget.

## Initial Setup
- Created project folder: lightweight-labeling-tool
- Starting research phase on molabel and anywidget architecture

## Research Phase

### molabel Architecture (from source)
- Built on anywidget (v0.9.0+) and traitlets (v5.0.0+)
- Two main widgets:
  - **SimpleLabel**: Binary classification (yes/no/skip) with notes
  - **ImageLabel**: Image annotation with bounding boxes/points
- Uses Python for backend logic and ES modules for frontend
- Key patterns:
  - Extends `anywidget.AnyWidget`
  - Uses traitlets for state synchronization between Python and JS
  - Render function pattern for customization
  - Action enum for user interactions (PREV, YES, NO, SKIP, etc.)
  - Supports keyboard shortcuts, gamepad, speech-to-text

### anywidget Architecture
- Modern Jupyter widget framework (v0.9.18)
- Minimal boilerplate - just Python class + ES module
- Built-in Hot Module Replacement (HMR) for development
- Works across Jupyter, VS Code, Colab, Panel, Shiny, etc.
- Uses standard web technologies (ES modules, CSS)

### ImageLabel Implementation Details
- `to_src()` function converts various formats to data URIs
- Handles: URLs, file paths, Base64, PIL Images, NumPy arrays, BytesIO
- Maintains annotations with coordinates
- `get_normalized_annotations()` converts relative to absolute coordinates
- External JS/CSS files for interactive UI

### Design Decisions for Our Clone
1. Keep similar architecture: Base class + specific implementations
2. Support text, image initially
3. Plan for extensibility to video and PDF
4. Use composition for shared functionality
5. Keep dependencies minimal (anywidget, traitlets, pillow, numpy)

## Architecture Design

### Package Structure
```
llabel/
├── __init__.py           # Package exports
├── base.py              # Base labeling widget class
├── text.py              # Text labeling widget
├── image.py             # Image labeling widget
├── video.py             # Video labeling widget (future)
├── pdf.py               # PDF labeling widget (future)
├── utils.py             # Shared utilities (format conversion, etc.)
└── static/
    ├── text-widget.js
    ├── text-widget.css
    ├── image-widget.js
    └── image-widget.css
```

### Core Components

#### 1. Base Widget (base.py)
- Common annotation logic
- Shared traitlets (current_index, annotations, etc.)
- Action handling (prev, next, skip, etc.)
- Keyboard shortcut management
- Export functionality

#### 2. Text Widget (text.py)
- Extends base widget
- Binary/multi-class classification
- Custom render function support
- Notes field with optional speech-to-text

#### 3. Image Widget (image.py)
- Extends base widget
- Bounding box annotations
- Point/polygon annotations
- Multiple image format support (PIL, numpy, URLs, paths)
- Coordinate normalization

#### 4. Video Widget (video.py) - Planned
- Frame-by-frame annotation
- SAM (Segment Anything Model) integration points
- Temporal consistency helpers
- Video format support (mp4, avi, etc.)

#### 5. PDF Widget (pdf.py) - Planned
- Page-based annotation
- Text selection/highlighting
- Region marking
- Multi-page navigation

### Key Design Patterns
1. **Template Method**: Base class defines workflow, subclasses customize
2. **Strategy Pattern**: Pluggable render functions
3. **Data URI Conversion**: Consistent handling of various input formats
4. **State Synchronization**: Traitlets for Python-JS communication

### Extensibility Features
- Custom render functions for any data type
- Pluggable annotation formats
- Flexible keyboard shortcuts
- Export to standard formats (JSON, CSV, etc.)

## Implementation Progress

### Completed Components

#### 1. Package Setup
- ✅ pyproject.toml with dependencies
- ✅ Package structure (llabel/)
- ✅ __init__.py with exports

#### 2. Core Modules
- ✅ utils.py: Data conversion utilities
  - autocast_render(): Convert any format to HTML
  - to_data_uri(): Universal format converter for images/video/PDF
- ✅ base.py: Base widget class
  - Action enum for user interactions
  - Common traitlets for state sync
  - Annotation management
  - Progress tracking
  - Export functionality

#### 3. Text Widget (text.py)
- ✅ Binary classification (yes/no/skip)
- ✅ Custom render function support
- ✅ Notes field
- ✅ Keyboard shortcuts
- ✅ Auto-advance after labeling

#### 4. Image Widget (image.py)
- ✅ Multiple input formats (PIL, numpy, paths, URLs)
- ✅ Three annotation modes: bbox, point, polygon
- ✅ Class-based labeling
- ✅ Color customization
- ✅ Coordinate normalization (relative to absolute)

#### 5. Frontend (JavaScript/CSS)
- ✅ text-widget.js: Text labeling interface
  - Interactive buttons
  - Progress display
  - Keyboard shortcuts (Alt+1-6)
  - Notes support
- ✅ text-widget.css: Clean, modern styling
- ✅ image-widget.js: Image annotation interface
  - Canvas-based drawing
  - Bbox/point/polygon support
  - Live preview during drawing
  - Class selection
- ✅ image-widget.css: Canvas and controls styling

### Implementation Notes

#### Design Patterns Used
1. **Inheritance**: BaseLabelWidget → TextLabel/ImageLabel
2. **Strategy Pattern**: Custom render functions
3. **Observer Pattern**: Traitlets for state synchronization
4. **Template Method**: Base class workflow, subclass customization

#### Key Features
- Lightweight: Minimal dependencies
- Extensible: Easy to add new media types
- Type-safe: Python type hints throughout
- Well-documented: Docstrings for all public APIs
- Modern UI: Clean, responsive design

## Future Extensions Designed

### Video Labeling (video.py)
- Frame-by-frame annotation
- SAM (Segment Anything Model) integration points
- Temporal annotation propagation
- Support for bbox, mask, point, and activity labels
- Tracking across frames (optical flow, SAM-based)
- Export formats compatible with video segmentation models

### PDF Labeling (pdf.py)
- Multi-page PDF rendering (using PDF.js in browser)
- Text selection and highlighting
- Region/bbox annotation for figures and tables
- Page classification
- Entity recognition (NER-style)
- Export to multiple formats (COCO, SpaCy, highlighted PDF)
- Layout analysis integration (LayoutLM compatibility)

## Notebooks Created

1. **01_text_labeling_demo.ipynb**
   - Basic text classification
   - Custom render functions
   - Export annotations
   - Progress tracking
   - Custom keyboard shortcuts

2. **02_image_labeling_demo.ipynb**
   - Bounding box annotation
   - Point/keypoint annotation
   - Polygon segmentation
   - Multiple input formats (NumPy, PIL, paths)
   - COCO format export
   - Custom colors

## Final Reflections

### What Worked Well
1. **Clean Architecture**: Base class pattern makes adding new widgets straightforward
2. **Minimal Dependencies**: Keeping core dependencies minimal (anywidget + traitlets) ensures compatibility
3. **Extensibility**: Design accommodates future media types (video, PDF) without major refactoring
4. **Documentation**: Comprehensive docstrings and examples make the library approachable

### Key Design Decisions
1. **Data URI conversion**: Universal format handling through `to_data_uri()` simplifies image/video/PDF support
2. **Relative coordinates**: Storing annotations in 0-1 range makes them resolution-independent
3. **Traitlets for state**: Automatic Python-JS synchronization reduces boilerplate
4. **ES modules**: Modern JavaScript without build step keeps development simple

### Future Implementation Priorities
For video and PDF widgets:
1. Start with basic rendering and navigation (highest value)
2. Add simple annotation modes (bbox for video, page classification for PDF)
3. Integrate advanced features (SAM, text selection) incrementally
4. Focus on export formats that integrate with existing ML pipelines

### Comparison with molabel
- **Kept**: Core philosophy, keyboard shortcuts, anywidget foundation
- **Extended**: Multiple annotation modes, base class architecture, future media types
- **Simplified**: Removed gamepad/speech features for initial implementation
- **Added**: Comprehensive documentation, example notebooks, extensibility design

### File Count
- Python modules: 7 (base, text, image, video, pdf, utils, __init__)
- JavaScript: 2 (text-widget.js, image-widget.js)
- CSS: 2 (text-widget.css, image-widget.css)
- Config: 1 (pyproject.toml)
- Documentation: 2 (README.md, NOTES.md)
- Notebooks: 2 (text demo, image demo)
- Total: 16 core files
