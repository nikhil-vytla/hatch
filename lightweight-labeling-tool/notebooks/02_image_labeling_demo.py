"""Image Labeling Demo - Marimo Notebook

This notebook demonstrates how to use the ImageLabel widget for image annotation tasks.
"""

import marimo

__generated_with = "0.9.0"
app = marimo.App()


@app.cell
def __():
    import marimo as mo
    import sys
    sys.path.insert(0, '..')
    from llabel import ImageLabel
    import numpy as np
    from PIL import Image
    return Image, ImageLabel, mo, np, sys


@app.cell(hide_code=True)
def __(mo):
    mo.md("""
    # Image Labeling Demo

    This notebook demonstrates how to use the `ImageLabel` widget for image annotation tasks.
    """)
    return


@app.cell(hide_code=True)
def __(mo):
    mo.md("""
    ## Bounding Box Annotation

    Annotate images with bounding boxes for object detection.
    """)
    return


@app.cell
def __(ImageLabel, mo, np):
    # Create sample images with NumPy
    sample_images = [
        np.random.randint(0, 255, (400, 600, 3), dtype=np.uint8),
        np.random.randint(0, 255, (400, 600, 3), dtype=np.uint8),
        np.random.randint(0, 255, (400, 600, 3), dtype=np.uint8),
    ]

    # Define object classes
    classes = ["person", "car", "bicycle", "dog"]

    # Create widget
    _widget = ImageLabel(
        images=sample_images,
        classes=classes,
        mode="bbox"
    )

    # Wrap with Marimo's anywidget wrapper
    widget = mo.ui.anywidget(_widget)

    widget
    return classes, sample_images, widget


@app.cell(hide_code=True)
def __(mo):
    mo.md("""
    ### Instructions for Bounding Box Mode

    1. Select a class from the dropdown
    2. Click and drag on the image to draw a bounding box
    3. Release to create the annotation
    4. Use **Previous/Next** buttons or **Arrow keys** to navigate
    5. Click **Clear Annotations** to remove all boxes from current image
    6. Press **Esc** to cancel current drawing
    """)
    return


@app.cell(hide_code=True)
def __(mo):
    mo.md("""
    ## Point Annotation

    Annotate specific points of interest (e.g., keypoints, landmarks).
    """)
    return


@app.cell
def __(ImageLabel, mo, np):
    # Create sample images
    point_images = [
        np.random.randint(0, 255, (500, 500, 3), dtype=np.uint8),
        np.random.randint(0, 255, (500, 500, 3), dtype=np.uint8),
    ]

    # Define keypoint classes
    keypoint_classes = ["nose", "left_eye", "right_eye", "left_ear", "right_ear"]

    _widget_points = ImageLabel(
        images=point_images,
        classes=keypoint_classes,
        mode="point"
    )

    # Wrap with Marimo's anywidget wrapper
    widget_points = mo.ui.anywidget(_widget_points)

    widget_points
    return keypoint_classes, point_images, widget_points


@app.cell(hide_code=True)
def __(mo):
    mo.md("""
    ### Instructions for Point Mode

    1. Select a keypoint class
    2. Click on the image to place a point
    3. Points are immediately saved
    4. Clear all points with **Clear Annotations**
    """)
    return


@app.cell(hide_code=True)
def __(mo):
    mo.md("""
    ## Polygon Annotation

    Draw polygons for segmentation tasks.
    """)
    return


@app.cell
def __(ImageLabel, mo, np):
    # Create sample images
    poly_images = [
        np.random.randint(0, 255, (400, 600, 3), dtype=np.uint8),
    ]

    # Define segmentation classes
    seg_classes = ["background", "foreground", "object"]

    _widget_poly = ImageLabel(
        images=poly_images,
        classes=seg_classes,
        mode="polygon"
    )

    # Wrap with Marimo's anywidget wrapper
    widget_poly = mo.ui.anywidget(_widget_poly)

    widget_poly
    return poly_images, seg_classes, widget_poly


@app.cell(hide_code=True)
def __(mo):
    mo.md("""
    ### Instructions for Polygon Mode

    1. Select a class
    2. Click to place polygon vertices
    3. Click near the first point to close the polygon
    4. Press **Esc** to cancel current polygon
    5. Polygon is saved when closed
    """)
    return


@app.cell(hide_code=True)
def __(mo):
    mo.md("""
    ## Working with PIL Images
    """)
    return


@app.cell
def __(Image, ImageLabel, mo):
    # Create PIL images
    pil_images = [
        Image.new('RGB', (400, 300), color=(255, 0, 0)),
        Image.new('RGB', (400, 300), color=(0, 255, 0)),
        Image.new('RGB', (400, 300), color=(0, 0, 255)),
    ]

    _widget_pil = ImageLabel(
        images=pil_images,
        classes=["red", "green", "blue"],
        mode="bbox"
    )

    # Wrap with Marimo's anywidget wrapper
    widget_pil = mo.ui.anywidget(_widget_pil)

    widget_pil
    return pil_images, widget_pil


@app.cell(hide_code=True)
def __(mo):
    mo.md("""
    ## Export Annotations

    Get annotations with normalized coordinates (0-1 range).
    """)
    return


@app.cell
def __(_widget, mo):
    # Get raw annotations (relative coordinates)
    annotations = _widget.get_annotations()

    # Get normalized annotations (absolute pixel coordinates)
    normalized = _widget.get_normalized_annotations()

    mo.vstack([
        mo.md("**Raw annotations (relative coordinates 0-1):**"),
        mo.json(annotations[0] if annotations else {}),
        mo.md("**Normalized annotations (absolute pixels):**"),
        mo.json(normalized[0] if normalized else {})
    ])
    return annotations, normalized


@app.cell(hide_code=True)
def __(mo):
    mo.md("""
    ## Export to COCO Format

    Convert annotations to COCO format for object detection.
    """)
    return


@app.cell
def __(_widget):
    def export_to_coco(widget_instance, image_width=600, image_height=400):
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
        annotations_list = widget_instance.get_normalized_annotations(
            image_width=image_width,
            image_height=image_height
        )

        ann_id = 0
        for img_idx, img_ann in enumerate(annotations_list):
            # Add image info
            coco_format["images"].append({
                "id": img_idx,
                "width": image_width,
                "height": image_height,
                "file_name": f"image_{img_idx}.jpg"
            })

            # Add annotations
            for elem in img_ann["elements"]:
                if elem["type"] == "bbox":
                    x1, y1, x2, y2 = elem["coords"]
                    width = x2 - x1
                    height = y2 - y1

                    coco_format["annotations"].append({
                        "id": ann_id,
                        "image_id": img_idx,
                        "category_id": elem["class_idx"],
                        "bbox": [x1, y1, width, height],
                        "area": width * height,
                        "iscrowd": 0
                    })
                    ann_id += 1

        return coco_format

    # Export
    coco_data = export_to_coco(_widget)
    return coco_data, export_to_coco


@app.cell
def __(coco_data, mo):
    mo.vstack([
        mo.md(f"**Exported {len(coco_data['annotations'])} annotations**"),
        mo.md(f"**Categories:** {[c['name'] for c in coco_data['categories']]}"),
        mo.json(coco_data)
    ])
    return


@app.cell(hide_code=True)
def __(mo):
    mo.md("""
    ## Save Annotations
    """)
    return


@app.cell
def __(coco_data, mo):
    import json

    # Button to save COCO annotations
    save_coco_button = mo.ui.button(label="Save COCO Annotations")

    if save_coco_button.value:
        with open('coco_annotations.json', 'w') as f:
            json.dump(coco_data, f, indent=2)
        save_result = mo.md("✓ Saved annotations to coco_annotations.json")
    else:
        save_result = mo.md("")

    mo.vstack([save_coco_button, save_result])
    return json, save_coco_button, save_result


@app.cell(hide_code=True)
def __(mo):
    mo.md("""
    ## Custom Colors

    Customize annotation colors for each class.
    """)
    return


@app.cell
def __(ImageLabel, mo, sample_images, classes):
    # Custom colors (CSS color strings)
    custom_colors = [
        "#FF0000",  # Red
        "#00FF00",  # Green
        "#0000FF",  # Blue
        "#FFFF00",  # Yellow
    ]

    _widget_custom = ImageLabel(
        images=sample_images[:1],
        classes=classes,
        colors=custom_colors,
        mode="bbox"
    )

    # Wrap with Marimo's anywidget wrapper
    widget_custom = mo.ui.anywidget(_widget_custom)

    widget_custom
    return custom_colors, widget_custom


if __name__ == "__main__":
    app.run()
