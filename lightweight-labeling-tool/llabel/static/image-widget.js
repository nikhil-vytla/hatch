// Adapted from koaning/molabel
/**
 * Image labeling widget - Frontend implementation
 * Supports bounding boxes, points, and polygons
 */

function render({ model, el }) {
  const container = document.createElement("div");
  container.className = "image-label-container";

  // Create header
  const header = document.createElement("div");
  header.className = "image-label-header";
  container.appendChild(header);

  // Create canvas container
  const canvasContainer = document.createElement("div");
  canvasContainer.className = "image-label-canvas-container";
  container.appendChild(canvasContainer);

  // Create canvas for image
  const canvas = document.createElement("canvas");
  canvas.className = "image-label-canvas";
  canvasContainer.appendChild(canvas);
  const ctx = canvas.getContext("2d");

  // Create controls
  const controls = document.createElement("div");
  controls.className = "image-label-controls";
  container.appendChild(controls);

  // Navigation buttons
  const navButtons = document.createElement("div");
  navButtons.className = "nav-buttons";
  controls.appendChild(navButtons);

  const prevBtn = document.createElement("button");
  prevBtn.textContent = "← Previous";
  prevBtn.className = "btn btn-secondary";
  navButtons.appendChild(prevBtn);

  const nextBtn = document.createElement("button");
  nextBtn.textContent = "Next →";
  nextBtn.className = "btn btn-secondary";
  navButtons.appendChild(nextBtn);

  // Class selection (if classes provided)
  let classSelect = null;
  const classes = model.get("classes");
  if (classes && classes.length > 0) {
    const classContainer = document.createElement("div");
    classContainer.className = "class-selection";

    const classLabel = document.createElement("label");
    classLabel.textContent = "Class: ";
    classContainer.appendChild(classLabel);

    classSelect = document.createElement("select");
    classSelect.className = "class-select";
    classes.forEach((cls, idx) => {
      const option = document.createElement("option");
      option.value = idx;
      option.textContent = cls;
      classSelect.appendChild(option);
    });
    classContainer.appendChild(classSelect);

    controls.appendChild(classContainer);
  }

  // Clear button
  const clearBtn = document.createElement("button");
  clearBtn.textContent = "Clear Annotations";
  clearBtn.className = "btn btn-clear";
  controls.appendChild(clearBtn);

  // State
  let img = new Image();
  let currentAnnotations = [];
  let isDrawing = false;
  let startPoint = null;
  let currentPolygon = [];
  const mode = model.get("annotation_mode");

  // Load and draw image
  function loadImage(src) {
    img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      // Set canvas size to match image
      canvas.width = img.width;
      canvas.height = img.height;
      redraw();
    };
    img.src = src;
  }

  // Redraw canvas
  function redraw() {
    // Clear canvas
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Draw image
    ctx.drawImage(img, 0, 0);

    // Draw annotations
    const colors = model.get("colors");
    currentAnnotations.forEach((ann, idx) => {
      const color = ann.class_idx !== undefined ? colors[ann.class_idx] : colors[0] || "#FF6B6B";

      if (ann.type === "bbox") {
        // Draw bounding box
        const [x1, y1, x2, y2] = ann.coords.map((c, i) =>
          i % 2 === 0 ? c * canvas.width : c * canvas.height
        );

        ctx.strokeStyle = color;
        ctx.lineWidth = 2;
        ctx.strokeRect(x1, y1, x2 - x1, y2 - y1);

        // Draw semi-transparent fill
        ctx.fillStyle = color + "33";
        ctx.fillRect(x1, y1, x2 - x1, y2 - y1);
      } else if (ann.type === "point") {
        // Draw point
        const [x, y] = ann.coords.map((c, i) =>
          i === 0 ? c * canvas.width : c * canvas.height
        );

        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(x, y, 5, 0, 2 * Math.PI);
        ctx.fill();
      } else if (ann.type === "polygon") {
        // Draw polygon
        if (ann.coords.length > 0) {
          ctx.strokeStyle = color;
          ctx.fillStyle = color + "33";
          ctx.lineWidth = 2;
          ctx.beginPath();

          ann.coords.forEach(([x, y], i) => {
            const px = x * canvas.width;
            const py = y * canvas.height;
            if (i === 0) {
              ctx.moveTo(px, py);
            } else {
              ctx.lineTo(px, py);
            }
          });

          ctx.closePath();
          ctx.stroke();
          ctx.fill();
        }
      }
    });

    // Draw current polygon in progress
    if (mode === "polygon" && currentPolygon.length > 0) {
      ctx.strokeStyle = "#FFF";
      ctx.lineWidth = 2;
      ctx.setLineDash([5, 5]);
      ctx.beginPath();

      currentPolygon.forEach(([x, y], i) => {
        if (i === 0) {
          ctx.moveTo(x, y);
        } else {
          ctx.lineTo(x, y);
        }
      });

      ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  // Get mouse position relative to canvas
  function getMousePos(e) {
    const rect = canvas.getBoundingClientRect();
    return {
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
    };
  }

  // Mouse handlers
  canvas.addEventListener("mousedown", (e) => {
    const pos = getMousePos(e);

    if (mode === "bbox") {
      isDrawing = true;
      startPoint = pos;
    } else if (mode === "point") {
      // Add point immediately
      const classIdx = classSelect ? parseInt(classSelect.value) : 0;
      currentAnnotations.push({
        type: "point",
        coords: [pos.x / canvas.width, pos.y / canvas.height],
        class_idx: classIdx,
      });
      saveAnnotations();
      redraw();
    } else if (mode === "polygon") {
      // Add point to polygon
      currentPolygon.push([pos.x, pos.y]);

      // Check if close to first point (to close polygon)
      if (currentPolygon.length > 2) {
        const [fx, fy] = currentPolygon[0];
        const dist = Math.sqrt((pos.x - fx) ** 2 + (pos.y - fy) ** 2);
        if (dist < 10) {
          // Close polygon
          const classIdx = classSelect ? parseInt(classSelect.value) : 0;
          currentAnnotations.push({
            type: "polygon",
            coords: currentPolygon.map(([x, y]) => [
              x / canvas.width,
              y / canvas.height,
            ]),
            class_idx: classIdx,
          });
          currentPolygon = [];
          saveAnnotations();
        }
      }

      redraw();
    }
  });

  canvas.addEventListener("mousemove", (e) => {
    if (mode === "bbox" && isDrawing && startPoint) {
      const pos = getMousePos(e);

      // Redraw with preview
      redraw();

      // Draw preview rectangle
      ctx.strokeStyle = "#FFF";
      ctx.lineWidth = 2;
      ctx.setLineDash([5, 5]);
      ctx.strokeRect(
        startPoint.x,
        startPoint.y,
        pos.x - startPoint.x,
        pos.y - startPoint.y
      );
      ctx.setLineDash([]);
    }
  });

  canvas.addEventListener("mouseup", (e) => {
    if (mode === "bbox" && isDrawing && startPoint) {
      const pos = getMousePos(e);

      // Calculate normalized coordinates
      const x1 = Math.min(startPoint.x, pos.x) / canvas.width;
      const y1 = Math.min(startPoint.y, pos.y) / canvas.height;
      const x2 = Math.max(startPoint.x, pos.x) / canvas.width;
      const y2 = Math.max(startPoint.y, pos.y) / canvas.height;

      // Only add if bbox has area
      if (Math.abs(x2 - x1) > 0.01 && Math.abs(y2 - y1) > 0.01) {
        const classIdx = classSelect ? parseInt(classSelect.value) : 0;
        currentAnnotations.push({
          type: "bbox",
          coords: [x1, y1, x2, y2],
          class_idx: classIdx,
        });
        saveAnnotations();
      }

      isDrawing = false;
      startPoint = null;
      redraw();
    }
  });

  // Save annotations to model
  function saveAnnotations() {
    const currentIndex = model.get("current_index");
    const annotations = [...model.get("annotations")];

    annotations[currentIndex] = {
      index: currentIndex,
      elements: currentAnnotations,
      timestamp: new Date().toISOString(),
    };

    model.set("annotations", annotations);
    model.save_changes();
  }

  // Update function
  function update() {
    const currentIndex = model.get("current_index");
    const total = model.get("total");
    const src = model.get("current_src");
    const annotations = model.get("annotations");

    // Update header
    header.innerHTML = `
      <div class="progress-info">
        Image ${currentIndex + 1} of ${total}
        <span class="mode-info">Mode: ${mode}</span>
      </div>
      <div class="progress-bar">
        <div class="progress-fill" style="width: ${((currentIndex + 1) / total) * 100}%"></div>
      </div>
    `;

    // Load current annotations
    currentAnnotations = annotations[currentIndex]?.elements || [];

    // Load image
    loadImage(src);

    // Update button states
    prevBtn.disabled = currentIndex === 0;
    nextBtn.disabled = currentIndex === total - 1;
  }

  // Event handlers
  prevBtn.onclick = () => {
    const currentIndex = model.get("current_index");
    if (currentIndex > 0) {
      currentPolygon = [];
      model.set("current_index", currentIndex - 1);
      model.save_changes();
    }
  };

  nextBtn.onclick = () => {
    const currentIndex = model.get("current_index");
    if (currentIndex < model.get("total") - 1) {
      currentPolygon = [];
      model.set("current_index", currentIndex + 1);
      model.save_changes();
    }
  };

  clearBtn.onclick = () => {
    currentAnnotations = [];
    currentPolygon = [];
    saveAnnotations();
    redraw();
  };

  // Keyboard shortcuts
  document.addEventListener("keydown", (e) => {
    if (e.key === "ArrowLeft") {
      e.preventDefault();
      prevBtn.click();
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      nextBtn.click();
    } else if (e.key === "Escape") {
      currentPolygon = [];
      redraw();
    }
  });

  // Observe changes
  model.on("change:current_index", update);
  model.on("change:current_src", update);

  // Initial render
  update();

  el.appendChild(container);
}

export default { render };
