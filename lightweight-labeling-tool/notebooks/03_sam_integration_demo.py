"""SAM Integration Demo - Marimo Notebook

This notebook demonstrates how to integrate Segment Anything Model (SAM) with the ImageLabel widget.
"""

import marimo

__generated_with = "0.9.0"
app = marimo.App(width="columns")


@app.cell(column=0, hide_code=True)
def _(mo):
    mo.md(r"""## SAM Integration Demo

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
    return Image, ImageLabel, mo, np, sys


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
    return ImageDraw, draw, test_image


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
    return Path, urllib


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

    return cuda_available, device, torch


@app.cell
def _(device):
    from segment_anything import SamPredictor, sam_model_registry

    sam = sam_model_registry["vit_h"](checkpoint="sam_vit_h_4b8939.pth")
    sam.to(device=device)

    predictor = SamPredictor(sam)
    return SamPredictor, predictor, sam, sam_model_registry


@app.cell
def _(np, predictor, test_image):
    # Set the image for SAM
    predictor.set_image(np.array(test_image))
    return


@app.cell(column=1, hide_code=True)
def _(mo):
    mo.md(r"""## Annotation Widget

    **Instructions:**
    - Use **point mode** to click points for SAM prompts
    - Use **bbox mode** to draw bounding boxes for SAM prompts
    - SAM will segment based on your annotations
    """)
    return


@app.cell
def _(ImageLabel, mo):
    # Create annotation widget
    label_widget = mo.ui.anywidget(
        ImageLabel(
            paths=["test_image.png"],
            classes=["foreground", "background"],
            colors=["orange", "blue"],
            mode="point"  # Start with point mode, user can switch to bbox
        )
    )
    label_widget
    return (label_widget,)


@app.cell
def _(label_widget):
    # Get annotations from widget
    annots = label_widget.get_normalized_annotations(image_width=600, image_height=400)

    if annots:
        elements = annots[0]["elements"]
        points = [e for e in elements if e["type"] == "point"]
        boxes = [e for e in elements if e["type"] == "bbox"]
    else:
        points = []
        boxes = []

    return annots, boxes, elements, points


@app.cell
def _(boxes, label_widget, points):
    # Extract point coordinates for SAM
    point_coords = [
        [p["coords"][0], p["coords"][1]]
        for p in points
    ]

    # Extract box coordinates for SAM (x1, y1, x2, y2 format)
    box_coords = [
        [b["coords"][0], b["coords"][1], b["coords"][2], b["coords"][3]]
        for b in boxes
    ]

    # Get labels (class indices)
    from sklearn.preprocessing import LabelEncoder
    if label_widget.annotations and label_widget.annotations[0]["elements"]:
        _labels = [e.get("class_idx", 0) for e in label_widget.annotations[0]["elements"]]
        labels = [l + 1 for l in _labels]  # SAM uses 1 for foreground
    else:
        labels = []

    return LabelEncoder, box_coords, labels, point_coords


@app.cell(column=2, hide_code=True)
def _(mo):
    mo.md(r"""## SAM Segmentation Results""")
    return


@app.cell
def _(labels, mo, np, point_coords, predictor):
    # Run SAM prediction if we have annotations
    mo.stop(len(point_coords) == 0)

    masks, scores, logits = predictor.predict(
        point_coords=np.array(point_coords),
        point_labels=np.array(labels),
        multimask_output=False,
    )

    return logits, masks, scores


@app.cell
def _(box_coords, mo, point_coords, test_image):
    import matplotlib.pyplot as plt

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

    gca = plt.gca()
    return ax, fig, gca, plt


@app.cell
def _(box_coords, masks, mo, point_coords, test_image):
    import matplotlib.pyplot as plt

    mo.stop(len(point_coords + box_coords) == 0)

    fig2, ax2 = plt.subplots(figsize=(8, 6))
    ax2.imshow(test_image)

    # Overlay the mask
    ax2.imshow(masks[0], alpha=0.5, cmap='jet')

    # Plot points
    if len(point_coords) > 0:
        points_array = list(zip(*point_coords))
        ax2.scatter(*points_array, c='red', s=100, marker='*', edgecolors='white', linewidths=2)

    ax2.set_title("SAM Segmentation Result")
    ax2.axis('off')

    gca2 = plt.gca()
    return ax2, fig2, gca2


@app.cell
def _(Image, masks, mo, np, point_coords, test_image):
    # Create masked image with alpha channel
    mo.stop(len(point_coords) == 0)

    rgba_image = np.dstack([np.array(test_image), masks[0].astype(np.uint8) * 255])
    masked_image = Image.fromarray(rgba_image.astype(np.uint8), mode="RGBA")

    masked_image
    return masked_image, rgba_image


@app.cell
def _(mo):
    mo.md("""
    ## Save Masked Image

    The masked image above can be saved for further use.
    """)
    return


@app.cell
def __(mo):
    save_button = mo.ui.button(label="Save Masked Image")
    save_button
    return (save_button,)


@app.cell
def _(masked_image, mo, point_coords, save_button):
    mo.stop(len(point_coords) == 0)

    if save_button.value:
        masked_image.save("sam_output.png")
        mo.md("✓ Saved masked image to `sam_output.png`")
    else:
        mo.md("Click button above to save the masked image")
    return


if __name__ == "__main__":
    app.run()
