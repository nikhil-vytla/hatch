This lightweight labeling toolkit brings anywidget-based annotation to Jupyter notebooks with a clean, extensible architecture inspired by molabel. The implementation includes fully-functional text and image widgets (supporting binary classification and bbox/point/polygon annotations), complete with interactive JavaScript frontends, comprehensive documentation, and demo notebooks. Built on minimal dependencies (anywidget + traitlets), the codebase features thoughtfully designed extension points for video (with SAM integration hooks) and PDF labeling, making it straightforward to add new media types. Explore the package at https://github.com/koaning/molabel and https://anywidget.dev for the foundational libraries.

Key deliverables:
- Production-ready TextLabel and ImageLabel widgets with full Python/JS implementations
- Extensible base class architecture enabling easy addition of new widget types
- Detailed design specifications for video and PDF annotation (video.py, pdf.py)
- Two interactive Marimo notebooks demonstrating common labeling workflows
- Complete project setup with pyproject.toml, comprehensive README, and development notes
- Marimo compatibility fix using traitlets.Any() for layout/comm traits
