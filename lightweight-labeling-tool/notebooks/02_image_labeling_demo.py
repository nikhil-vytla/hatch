"""Image Labeling Demo - Marimo Notebook

This notebook demonstrates how to use the ImageLabel widget for image annotation tasks.
"""

import marimo

__generated_with = "0.17.7"
app = marimo.App()


@app.cell
def _():
    import marimo as mo
    import sys
    sys.path.insert(0, '..')
    from llabel import ImageLabel
    import numpy as np
    from PIL import Image
    return ImageLabel, mo


@app.cell(hide_code=True)
def _(mo):
    mo.md("""
    # Image Labeling Demo

    This notebook demonstrates how to use the `ImageLabel` widget for image annotation tasks.
    """)
    return


@app.cell(hide_code=True)
def _(mo):
    mo.md("""
    ## Image Annotation Widget

    Annotate images with bounding boxes, points, or polygons.
    """)
    return


@app.cell
def _(ImageLabel, mo):
    from pathlib import Path

    # Load images from pexels_mixed directory
    # Use absolute path from project root
    project_root = Path.cwd()
    if project_root.name == "notebooks":
        project_root = project_root.parent
    image_dir = project_root / "data" / "image" / "pexels_mixed"
    image_paths = sorted(str(p) for p in image_dir.glob("*.jpg"))

    # Define object classes
    classes = ["person", "car", "bicycle", "dog"]

    # Create widget (no mode parameter - handles all annotation types flexibly)
    _widget = ImageLabel(
        paths=image_paths,
        classes=classes
    )

    # Wrap with Marimo's anywidget wrapper
    widget = mo.ui.anywidget(_widget)

    widget
    return classes, image_paths, widget


@app.cell(hide_code=True)
def _(mo):
    mo.md("""
    ### How to Use

    **Annotation Modes:**
    - **Bounding Box**: Click and drag to draw a rectangle
    - **Point**: Click to place a point
    - **Polygon**: Click to place vertices, close by clicking near the first point

    **Keyboard Shortcuts:**
    - Use **Previous/Next** buttons or **Arrow keys** to navigate images
    - Press **Esc** to cancel current drawing
    - Click **Clear Annotations** to remove all annotations from current image

    **Getting Started:**
    1. Select a class from the dropdown
    2. Choose your annotation mode (bbox/point/polygon)
    3. Annotate the image
    4. Navigate to the next image
    """)
    return


@app.cell(hide_code=True)
def _(mo):
    mo.md("""
    ## Export Annotations

    Get annotations with normalized coordinates (0-1 range).
    """)
    return


@app.cell
def _(mo, widget):
    # Get raw annotations (relative coordinates)
    annotations = widget.annotations

    # Get normalized annotations (absolute pixel coordinates)
    normalized = widget.get_normalized_annotations()

    mo.vstack([
        mo.md("**Raw annotations (relative coordinates 0-1):**"),
        mo.json(annotations[0] if annotations else {}),
        mo.md("**Normalized annotations (absolute pixels):**"),
        mo.json(normalized[0] if normalized else {})
    ])
    return


@app.cell(hide_code=True)
def _(mo):
    mo.md("""
    ## Export to COCO Format

    Convert annotations to COCO format for object detection.
    """)
    return


@app.cell
def _(widget):
    def export_to_coco(widget_instance):
        """Export annotations to COCO format."""
        coco_format = {
            "images": [],
            "annotations": [],
            "categories": []
        }

        # Add categories
        classes_list = widget_instance.classes
        for idx, cls in enumerate(classes_list):
            coco_format["categories"].append({
                "id": idx,
                "name": cls
            })

        # Get normalized annotations
        annotations_list = widget_instance.get_normalized_annotations()

        ann_id = 0
        for img_idx, img_ann in enumerate(annotations_list):
            # Get image dimensions from first element if available
            if img_ann.get("elements"):
                img_dims = img_ann["elements"][0].get("imageDimensions", {"width": 600, "height": 400})
                width = img_dims["width"]
                height = img_dims["height"]
            else:
                width, height = 600, 400

             # Extract image filename
            filename = (
                widget_instance.filenames[img_idx]
                if widget_instance.filenames and img_idx < len(widget_instance.filenames)
                # or fallback 
                else f"image_{img_idx}.jpg"
            )
            # Add image info
            coco_format["images"].append({
                "id": img_idx,
                "width": width,
                "height": height,
                "file_name": filename
            })

            # Add annotations (convert points to bbox if we have 2 points)
            for elem in img_ann.get("elements", []):
                points = elem.get("points", [])
                if len(points) >= 2:
                    # Assume first two points define bbox corners
                    x1, y1 = points[0]["x"], points[0]["y"]
                    x2, y2 = points[1]["x"], points[1]["y"]
                    bbox_width = abs(x2 - x1)
                    bbox_height = abs(y2 - y1)

                    coco_format["annotations"].append({
                        "id": ann_id,
                        "image_id": img_idx,
                        "category_id": elem.get("label", 0),
                        "bbox": [min(x1, x2), min(y1, y2), bbox_width, bbox_height],
                        "area": bbox_width * bbox_height,
                        "iscrowd": 0
                    })
                    ann_id += 1

        return coco_format

    # Export
    coco_data = export_to_coco(widget)
    return (coco_data,)


@app.cell
def _(coco_data, mo):
    mo.vstack([
        mo.md(f"**Exported {len(coco_data['annotations'])} annotations**"),
        mo.md(f"**Categories:** {[c['name'] for c in coco_data['categories']]}"),
        mo.json(coco_data)
    ])
    return


@app.cell(hide_code=True)
def _(mo):
    mo.md("""
    ## Save Annotations
    """)
    return


@app.cell
def _(mo):
    import json

    # Button to save COCO annotations
    save_coco_button = mo.ui.run_button(label="Save COCO Annotations")
    save_coco_button
    return json, save_coco_button


@app.cell
def _(coco_data, json, mo, save_coco_button):
    mo.stop(not save_coco_button.value)

    with open('coco_annotations.json', 'w') as f:
        json.dump(coco_data, f, indent=2)

    mo.md("✓ Saved annotations to coco_annotations.json")
    return


@app.cell(hide_code=True)
def _(mo):
    mo.md("""
    ## Custom Colors

    Customize annotation colors for each class.
    """)
    return


@app.cell
def _(ImageLabel, classes, image_paths, mo):
    # Custom colors (CSS color strings)
    custom_colors = [
        "#FF0000",  # Red
        "#00FF00",  # Green
        "#0000FF",  # Blue
        "#FFFF00",  # Yellow
    ]

    _widget_custom = ImageLabel(
        paths=image_paths[:1],
        classes=classes,
        colors=custom_colors
    )

    # Wrap with Marimo's anywidget wrapper
    widget_custom = mo.ui.anywidget(_widget_custom)

    widget_custom
    return


if __name__ == "__main__":
    app.run()
