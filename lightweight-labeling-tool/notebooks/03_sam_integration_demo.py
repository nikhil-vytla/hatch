"""SAM Integration Demo - Marimo Notebook

This notebook demonstrates how to integrate Segment Anything Model (SAM) with the ImageLabel widget.
"""

import marimo

__generated_with = "0.17.7"
app = marimo.App(width="columns")


@app.cell(column=0, hide_code=True)
def _(mo):
    mo.md(r"""
    ## SAM Integration Demo

    ### Troubleshooting

    If you get a torchvision import error, reinstall compatible versions:

    ```bash
    # Uninstall existing versions
    pip uninstall torch torchvision segment-anything -y

    # Reinstall with compatible versions
    uv pip install torch torchvision
    uv pip install segment-anything
    ```

    Or use the demos extra which includes compatible versions:
    ```bash
    uv pip install -e ".[demos]"
    ```

    Currently, this notebook supports point and box annotations, not polygon annotations. 
    I plan to add polygon support in the future.
    """)
    return


@app.cell
def _():
    import marimo as mo
    import sys
    sys.path.insert(0, '..')
    from llabel import ImageLabel
    import numpy as np
    from PIL import Image
    return Image, ImageLabel, mo, np


@app.cell
def _(Image, mo):
    # For demo, create a sample image or use file upload
    # You can replace this with mo.ui.file() for image upload

    # Create a simple test image
    test_image = Image.new('RGB', (600, 400), color=(200, 200, 200))

    # Draw some shapes for testing
    from PIL import ImageDraw
    draw = ImageDraw.Draw(test_image)
    draw.rectangle([100, 100, 300, 250], fill=(255, 0, 0))
    draw.ellipse([350, 150, 500, 300], fill=(0, 0, 255))

    test_image.save("test_image.png")

    mo.md("Test image created. Click points or draw boxes on the widget below.")
    return (test_image,)


@app.cell(hide_code=True)
def _():
    from pathlib import Path
    import urllib.request

    # Download SAM model if not present
    if not Path("sam_vit_h_4b8939.pth").exists():
        print("Downloading SAM model (2.4GB)... This may take a while.")
        urllib.request.urlretrieve(
            "https://dl.fbaipublicfiles.com/segment_anything/sam_vit_h_4b8939.pth",
            "sam_vit_h_4b8939.pth",
        )
        print("Download complete!")
    return


@app.cell(hide_code=True)
def _():
    import torch

    # Check if CUDA is available
    cuda_available = torch.cuda.is_available()
    device = "cuda" if cuda_available else "cpu"

    print(f"Using device: {device}")

    if cuda_available:
        num_gpus = torch.cuda.device_count()
        for gpu_id in range(num_gpus):
            print(f"GPU {gpu_id}: {torch.cuda.get_device_name(gpu_id)}")
    return (device,)


@app.cell
def _(device):
    from segment_anything import SamPredictor, sam_model_registry

    sam = sam_model_registry["vit_h"](checkpoint="sam_vit_h_4b8939.pth")
    sam.to(device=device)

    predictor = SamPredictor(sam)
    return (predictor,)


@app.cell
def _(np, predictor, test_image):
    # Set the image for SAM
    predictor.set_image(np.array(test_image))
    return


@app.cell(column=1, hide_code=True)
def _(mo):
    mo.md(r"""
    ## Annotation Widget

    **Instructions:**
    - Use **point mode** to click points for SAM prompts
    - Use **bbox mode** to draw bounding boxes for SAM prompts
    - SAM will segment based on your annotations
    """)
    return


@app.cell
def _(ImageLabel, mo):
    # Create annotation widget (no mode parameter - handles all annotation types flexibly)
    label_widget = mo.ui.anywidget(
        ImageLabel(
            paths=["test_image.png"],
            classes=["rectangle", "circle", "background"],
            colors=["orange", "blue", "black"]
        )
    )
    label_widget
    return (label_widget,)


@app.cell
def _(label_widget):
    # Get annotations from widget
    annots = label_widget.get_normalized_annotations()

    if annots and len(annots) > 0:
        elements = annots[0].get("elements", [])
        # In the new structure, all annotations use points
        # Single points have 1 point, bboxes have 2+ points
        points = [e for e in elements if len(e.get("points", [])) == 1]
        boxes = [e for e in elements if len(e.get("points", [])) >= 2]
    else:
        points = []
        boxes = []
    return boxes, points


@app.cell
def _(boxes, label_widget, points):
    # Extract point coordinates for SAM (from normalized points)
    point_coords = [
        [p["points"][0]["x"], p["points"][0]["y"]]
        for p in points
    ]

    # Extract box coordinates for SAM (x1, y1, x2, y2 format)
    box_coords = [
        [b["points"][0]["x"], b["points"][0]["y"], b["points"][1]["x"], b["points"][1]["y"]]
        for b in boxes
    ]

    # Get labels for points (can be either positive or negative)
    # Note: Boxes don't need labels - they're always treated as positive prompts by SAM
    # SAM uses: 1 = foreground (positive), 0 = background (negative)
    annots_raw = label_widget.annotations
    if annots_raw and len(annots_raw) > 0 and annots_raw[0].get("elements"):
        point_labels = []
        classes = label_widget.classes
        for elem in annots_raw[0]["elements"]:
            if len(elem.get("points", [])) == 1:  # Only for point annotations
                class_name = elem.get("label", "")
                # Validate that the class name exists in the classes list
                if class_name and class_name in classes:
                    # Map: background class -> 0 (negative prompt), everything else -> 1 (positive prompt)
                    sam_label = 0 if class_name == "background" else 1
                    point_labels.append(sam_label)
                else:
                    # Default to positive prompt if class name is invalid or missing
                    point_labels.append(1)
    else:
        point_labels = [1] * len(point_coords)
    return box_coords, point_coords, point_labels


@app.cell(column=2, hide_code=True)
def _(mo):
    mo.md(r"""
    ## SAM Segmentation Results
    """)
    return


@app.cell
def _(box_coords, mo, np, point_coords, point_labels, predictor):
    # Run SAM prediction if we have annotations
    mo.stop(len(point_coords) == 0 and len(box_coords) == 0)

    # Prepare arguments for SAM
    sam_kwargs = {"multimask_output": False}

    if len(point_coords) > 0:
        sam_kwargs["point_coords"] = np.array(point_coords)
        sam_kwargs["point_labels"] = np.array(point_labels)

    if len(box_coords) > 0:
        # SAM expects box in format [x1, y1, x2, y2]
        # Use the first box if multiple are drawn
        sam_kwargs["box"] = np.array(box_coords[0])

    masks, scores, logits = predictor.predict(**sam_kwargs)
    return (masks,)


@app.cell
def _(box_coords, mo, point_coords, test_image):
    import matplotlib.pyplot as plt

    mo.stop(len(point_coords) == 0 and len(box_coords) == 0)

    fig, ax = plt.subplots(figsize=(8, 6))
    ax.imshow(test_image)

    # Plot points
    if len(point_coords) > 0:
        points_array = list(zip(*point_coords))
        ax.scatter(*points_array, c='red', s=100, marker='*', edgecolors='white', linewidths=2)

    # Plot boxes
    for box in box_coords:
        x1, y1, x2, y2 = box
        rect = plt.Rectangle((x1, y1), x2-x1, y2-y1, fill=False, edgecolor='green', linewidth=2)
        ax.add_patch(rect)

    ax.set_title("Annotations")
    ax.axis('off')

    plt.gca()
    return (plt,)


@app.cell
def _(box_coords, masks, mo, plt, point_coords, test_image):
    mo.stop(len(point_coords) == 0 and len(box_coords) == 0)

    fig2, ax2 = plt.subplots(figsize=(8, 6))
    ax2.imshow(test_image)

    # Overlay the mask
    ax2.imshow(masks[0], alpha=0.5, cmap='jet')

    # Plot points
    if len(point_coords) > 0:
        points_array2 = list(zip(*point_coords))
        ax2.scatter(*points_array2, c='red', s=100, marker='*', edgecolors='white', linewidths=2)

    ax2.set_title("SAM Segmentation Result")
    ax2.axis('off')

    plt.gca()
    return


@app.cell
def _(Image, box_coords, masks, mo, np, point_coords, test_image):
    # Create masked image with alpha channel
    mo.stop(len(point_coords) == 0 and len(box_coords) == 0)

    rgba_image = np.dstack([np.array(test_image), masks[0].astype(np.uint8) * 255])
    masked_image = Image.fromarray(rgba_image.astype(np.uint8), mode="RGBA")

    masked_image
    return (masked_image,)


@app.cell
def _(mo):
    mo.md("""
    ## Save Masked Image

    The masked image above can be saved for further use.
    """)
    return


@app.cell
def _(mo):
    save_button = mo.ui.run_button(label="Save Masked Image")
    save_button
    return (save_button,)


@app.cell
def _(masked_image, mo, point_coords, save_button):
    mo.stop(len(point_coords) == 0)
    mo.stop(not save_button.value)

    masked_image.save("sam_output.png")
    mo.md("✓ Saved masked image to `sam_output.png`")
    return


if __name__ == "__main__":
    app.run()
