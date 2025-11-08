// Adapted from koaning/molabel
/**
 * Text labeling widget - Frontend implementation
 */

function render({ model, el }) {
  // Create container
  const container = document.createElement("div");
  container.className = "text-label-container";

  // Create header with progress
  const header = document.createElement("div");
  header.className = "text-label-header";
  container.appendChild(header);

  // Create content area
  const content = document.createElement("div");
  content.className = "text-label-content";
  container.appendChild(content);

  // Create button bar
  const buttonBar = document.createElement("div");
  buttonBar.className = "text-label-buttons";
  container.appendChild(buttonBar);

  // Create buttons
  const prevBtn = document.createElement("button");
  prevBtn.textContent = "← Previous (Alt+1)";
  prevBtn.className = "btn btn-secondary";
  buttonBar.appendChild(prevBtn);

  const yesBtn = document.createElement("button");
  yesBtn.textContent = "✓ Yes (Alt+2)";
  yesBtn.className = "btn btn-yes";
  buttonBar.appendChild(yesBtn);

  const noBtn = document.createElement("button");
  noBtn.textContent = "✗ No (Alt+3)";
  noBtn.className = "btn btn-no";
  buttonBar.appendChild(noBtn);

  const skipBtn = document.createElement("button");
  skipBtn.textContent = "⊘ Skip (Alt+4)";
  skipBtn.className = "btn btn-skip";
  buttonBar.appendChild(skipBtn);

  const nextBtn = document.createElement("button");
  nextBtn.textContent = "Next →";
  nextBtn.className = "btn btn-secondary";
  buttonBar.appendChild(nextBtn);

  // Create notes section (if enabled)
  let notesArea = null;
  if (model.get("enable_notes")) {
    const notesContainer = document.createElement("div");
    notesContainer.className = "text-label-notes";

    const notesLabel = document.createElement("label");
    notesLabel.textContent = "Notes (Alt+5 to focus):";
    notesContainer.appendChild(notesLabel);

    notesArea = document.createElement("textarea");
    notesArea.className = "notes-input";
    notesArea.rows = 3;
    notesContainer.appendChild(notesArea);

    container.appendChild(notesContainer);
  }

  // Update function
  function update() {
    const currentIndex = model.get("current_index");
    const total = model.get("total");
    const rendered = model.get("current_rendered");
    const annotations = model.get("annotations");

    // Update header
    header.innerHTML = `
      <div class="progress-info">
        Example ${currentIndex + 1} of ${total}
      </div>
      <div class="progress-bar">
        <div class="progress-fill" style="width: ${((currentIndex + 1) / total) * 100}%"></div>
      </div>
    `;

    // Update content
    content.innerHTML = rendered;

    // Update notes
    if (notesArea) {
      notesArea.value = annotations[currentIndex]?.notes || "";
    }

    // Update button states
    prevBtn.disabled = currentIndex === 0;
    nextBtn.disabled = currentIndex === total - 1;

    // Highlight current label
    const currentLabel = annotations[currentIndex]?.label;
    yesBtn.classList.toggle("active", currentLabel === "yes");
    noBtn.classList.toggle("active", currentLabel === "no");
    skipBtn.classList.toggle("active", currentLabel === "skip");
  }

  // Label function
  function labelCurrent(label) {
    const currentIndex = model.get("current_index");
    const annotations = [...model.get("annotations")];
    const notes = notesArea ? notesArea.value : "";

    annotations[currentIndex] = {
      index: currentIndex,
      label: label,
      notes: notes,
      timestamp: new Date().toISOString(),
      rendered: model.get("current_rendered"),
    };

    model.set("annotations", annotations);
    model.save_changes();

    // Auto-advance
    if (currentIndex < model.get("total") - 1) {
      model.set("current_index", currentIndex + 1);
      model.save_changes();
    }
  }

  // Event handlers
  prevBtn.onclick = () => {
    const currentIndex = model.get("current_index");
    if (currentIndex > 0) {
      model.set("current_index", currentIndex - 1);
      model.save_changes();
    }
  };

  nextBtn.onclick = () => {
    const currentIndex = model.get("current_index");
    if (currentIndex < model.get("total") - 1) {
      model.set("current_index", currentIndex + 1);
      model.save_changes();
    }
  };

  yesBtn.onclick = () => labelCurrent("yes");
  noBtn.onclick = () => labelCurrent("no");
  skipBtn.onclick = () => labelCurrent("skip");

  // Keyboard shortcuts
  document.addEventListener("keydown", (e) => {
    if (e.altKey) {
      switch (e.key) {
        case "1":
          e.preventDefault();
          prevBtn.click();
          break;
        case "2":
          e.preventDefault();
          yesBtn.click();
          break;
        case "3":
          e.preventDefault();
          noBtn.click();
          break;
        case "4":
          e.preventDefault();
          skipBtn.click();
          break;
        case "5":
          e.preventDefault();
          if (notesArea) notesArea.focus();
          break;
      }
    }
  });

  // Observe changes
  model.on("change:current_index", update);
  model.on("change:current_rendered", update);
  model.on("change:annotations", update);

  // Initial render
  update();

  // Append to element
  el.appendChild(container);
}

export default { render };
