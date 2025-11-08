.PHONY: docs clean install test format lint pypi

# Clean build artifacts
clean:
	rm -rf dist
	rm -rf build
	rm -rf *.egg-info
	rm -rf *.egg
	rm -rf *.whl
	rm -rf *.tar.gz
	find . -type d -name __pycache__ -exec rm -rf {} +
	find . -type f -name "*.pyc" -delete

# Install package in development mode
install:
	pip install -e ".[dev]"

# Install with all optional dependencies
install-all:
	pip install -e ".[all,dev]"

# Export demo notebooks to HTML/WASM
docs:
	mkdir -p docs
	marimo --yes export html-wasm notebooks/01_text_labeling_demo.py -o docs/text_demo.html --mode edit
	marimo --yes export html-wasm notebooks/02_image_labeling_demo.py -o docs/image_demo.html --mode edit
	marimo --yes export html-wasm notebooks/03_sam_integration_demo.py -o docs/sam_demo.html --mode edit

# Export single demo (for quick testing)
docs-quick:
	mkdir -p docs
	marimo --yes export html-wasm notebooks/02_image_labeling_demo.py -o docs/index.html --mode edit

# Run tests
test:
	pytest -v

# Format code with black
format:
	black llabel/ notebooks/ test_marimo_compatibility.py

# Lint code with ruff
lint:
	ruff check llabel/ notebooks/ test_marimo_compatibility.py

# Build and publish to PyPI
pypi: clean
	pip install --upgrade build twine
	python -m build
	python -m twine upload dist/*

# Development server (run marimo demo)
dev:
	marimo edit notebooks/02_image_labeling_demo.py
