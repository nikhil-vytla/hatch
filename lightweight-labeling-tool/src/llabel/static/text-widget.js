// Adapted from koaning/molabel
/**
 * Text labeling widget - Frontend implementation
 */

function render({ model, el }) {
  // Create container
  const container = document.createElement("div");
  container.className = "text-label-container";
  container.tabIndex = 0; // Make focusable for keyboard shortcuts

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
  prevBtn.textContent = "← Previous";
  prevBtn.className = "btn btn-secondary";
  buttonBar.appendChild(prevBtn);

  const yesBtn = document.createElement("button");
  yesBtn.textContent = "✓ Yes";
  yesBtn.className = "btn btn-yes";
  buttonBar.appendChild(yesBtn);

  const noBtn = document.createElement("button");
  noBtn.textContent = "✗ No";
  noBtn.className = "btn btn-no";
  buttonBar.appendChild(noBtn);

  const skipBtn = document.createElement("button");
  skipBtn.textContent = "⊘ Skip";
  skipBtn.className = "btn btn-skip";
  buttonBar.appendChild(skipBtn);

  const nextBtn = document.createElement("button");
  nextBtn.textContent = "Next →";
  nextBtn.className = "btn btn-secondary";
  buttonBar.appendChild(nextBtn);

  // Create notes section (if enabled)
  let notesArea = null;
  let micBtn = null;
  if (model.get("enable_notes")) {
    const notesContainer = document.createElement("div");
    notesContainer.className = "text-label-notes";

    const notesHeader = document.createElement("div");
    notesHeader.className = "text-label-notes-header";

    const notesLabel = document.createElement("label");
    notesLabel.textContent = "Notes (Alt+5 to focus):";
    notesHeader.appendChild(notesLabel);

    micBtn = document.createElement("button");
    micBtn.className = "mic-btn";
    micBtn.innerHTML = "🎤";
    micBtn.title = "Click to record speech (Alt+6)";
    micBtn.type = "button";
    notesHeader.appendChild(micBtn);

    notesContainer.appendChild(notesHeader);

    notesArea = document.createElement("textarea");
    notesArea.className = "notes-input";
    notesArea.rows = 3;
    notesContainer.appendChild(notesArea);

    container.appendChild(notesContainer);
  }

  // Create shortcuts display
  const shortcutsInfo = document.createElement("div");
  shortcutsInfo.className = "shortcuts-info";
  container.appendChild(shortcutsInfo);

  // Speech recognition setup
  let speechRecognition = null;
  let speechAvailable = false;
  let isRecording = false;
  let originalNotesText = "";

  function initSpeechRecognition() {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

    if (SpeechRecognition) {
      speechRecognition = new SpeechRecognition();
      speechRecognition.continuous = true;
      speechRecognition.interimResults = true;
      speechRecognition.lang = 'en-US';

      speechRecognition.onstart = () => {
        isRecording = true;
        originalNotesText = notesArea?.value || "";
        updateRecordingUI();
      };

      speechRecognition.onresult = (event) => {
        let newFinalTranscript = "";
        let newInterimTranscript = "";

        for (let i = event.resultIndex; i < event.results.length; i++) {
          const transcript = event.results[i][0].transcript;
          if (event.results[i].isFinal) {
            newFinalTranscript += transcript;
          } else {
            newInterimTranscript += transcript;
          }
        }

        if (newFinalTranscript) {
          const separator = originalNotesText ? ' ' : '';
          originalNotesText = originalNotesText + separator + newFinalTranscript;
        }

        if (notesArea) {
          const separator = originalNotesText ? ' ' : '';
          notesArea.value = originalNotesText + (newInterimTranscript ? separator + newInterimTranscript : '');
        }
      };

      speechRecognition.onend = () => {
        isRecording = false;
        if (notesArea) notesArea.value = originalNotesText;
        updateRecordingUI();
      };

      speechRecognition.onerror = (event) => {
        isRecording = false;
        if (notesArea) notesArea.value = originalNotesText;
        updateRecordingUI();
      };

      speechAvailable = true;
    } else {
      speechAvailable = false;
    }

    updateMicButtonState();
  }

  function updateRecordingUI() {
    if (!micBtn || !notesArea) return;

    if (isRecording) {
      micBtn.classList.add('recording');
      notesArea.classList.add('recording');
      micBtn.innerHTML = '🔴';
      micBtn.title = 'Recording... (click to stop)';
    } else {
      micBtn.classList.remove('recording');
      notesArea.classList.remove('recording');
      micBtn.innerHTML = speechAvailable ? '🎤' : '❌';
      micBtn.title = speechAvailable ? 'Click to record speech (Alt+6)' : 'Speech not available';
    }
  }

  function updateMicButtonState() {
    if (micBtn) {
      micBtn.disabled = !speechAvailable;
      updateRecordingUI();
    }
  }

  function startSpeechRecognition() {
    if (speechAvailable && !isRecording) {
      try {
        speechRecognition.start();
      } catch (error) {
        console.error('Speech recognition error:', error);
      }
    }
  }

  function stopSpeechRecognition() {
    if (speechAvailable && isRecording) {
      try {
        speechRecognition.stop();
      } catch (error) {
        console.error('Speech recognition error:', error);
      }
    }
  }

  // Initialize speech if notes enabled
  if (notesArea && micBtn) {
    initSpeechRecognition();

    micBtn.addEventListener('click', () => {
      if (isRecording) {
        stopSpeechRecognition();
      } else {
        startSpeechRecognition();
      }
    });
  }

  // Helper to add flash animation
  function flashButton(btn, className) {
    btn.classList.add(className);
    setTimeout(() => btn.classList.remove(className), 300);
  }

  // Update function
  function update() {
    const currentIndex = model.get("current_index");
    const total = model.get("total");
    const examples = model.get("examples_data");
    const annotations = model.get("annotations");
    const shortcuts = model.get("keyboard_shortcuts");

    // Update header
    header.innerHTML = `
      <div class="progress-info">
        Example ${currentIndex + 1} of ${total}
      </div>
      <div class="progress-bar">
        <div class="progress-fill" style="width: ${((currentIndex + 1) / total) * 100}%"></div>
      </div>
    `;

    // Update content using _html from examples
    if (examples.length > 0 && currentIndex < examples.length) {
      content.innerHTML = examples[currentIndex]._html || "";
    } else {
      content.innerHTML = "No examples to display";
    }

    // Update notes - preserve existing annotation notes (better state management)
    // Don't update if currently recording speech
    if (notesArea && !isRecording) {
      const existingAnnotation = annotations.find(ann => ann.index === currentIndex);
      notesArea.value = existingAnnotation?._notes || "";
    }

    // Update button states
    prevBtn.disabled = currentIndex === 0;
    nextBtn.disabled = currentIndex === total - 1;

    // Highlight current label
    const existingAnnotation = annotations.find(ann => ann.index === currentIndex);
    const currentLabel = existingAnnotation?._label;
    yesBtn.classList.toggle("active", currentLabel === "yes");
    noBtn.classList.toggle("active", currentLabel === "no");
    skipBtn.classList.toggle("active", currentLabel === "skip");

    // Update shortcuts display
    const actions = ['prev', 'yes', 'no', 'skip', 'focus_notes', 'speech_notes'];
    const actionLabels = {
      prev: 'Previous',
      yes: 'Yes',
      no: 'No',
      skip: 'Skip',
      focus_notes: 'Focus Notes',
      speech_notes: 'Speech Notes'
    };

    let shortcutsHTML = '<details><summary>Shortcuts</summary><table class="shortcuts-table"><thead><tr><th>Action</th><th>Shortcut</th></tr></thead><tbody>';

    actions.forEach(action => {
      const key = Object.keys(shortcuts).find(k => shortcuts[k] === action);
      if (key) {
        shortcutsHTML += `<tr><td>${actionLabels[action]}</td><td><span class="shortcut-key">${key}</span></td></tr>`;
      }
    });

    shortcutsHTML += '</tbody></table></details>';
    shortcutsInfo.innerHTML = shortcutsHTML;
  }

  // Label function
  function labelCurrent(label) {
    const currentIndex = model.get("current_index");
    const examples = model.get("examples_data");
    const annotations = model.get("annotations");
    const showNotes = model.get("enable_notes");

    if (currentIndex >= examples.length) return;

    // Flash button
    const flashMap = { yes: 'flash-yes', no: 'flash-no', skip: 'flash-skip' };
    const btn = label === 'yes' ? yesBtn : label === 'no' ? noBtn : skipBtn;
    flashButton(btn, flashMap[label]);

    const annotation = {
      index: currentIndex,
      example: examples[currentIndex],
      _label: label,
      _notes: showNotes ? (notesArea?.value || "") : "",
      _timestamp: new Date().toISOString()
    };

    // Replace existing annotation or add new one
    const newAnnotations = annotations.filter(ann => ann.index !== currentIndex);
    newAnnotations.push(annotation);
    model.set("annotations", newAnnotations);
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
      flashButton(prevBtn, 'flash-prev');
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

  // Keyboard shortcuts - attach to container
  container.addEventListener("keydown", (e) => {
    const shortcuts = model.get("keyboard_shortcuts");
    const modifiers = [];
    if (e.ctrlKey) modifiers.push('Ctrl');
    if (e.altKey) modifiers.push('Alt');
    if (e.shiftKey) modifiers.push('Shift');
    if (e.metaKey) modifiers.push('Meta');

    const key = e.code.replace('Key', '').replace('Digit', '');
    const shortcut = modifiers.length > 0 ? `${modifiers.join('+')}+${key}` : key;
    const action = shortcuts[shortcut.toLowerCase()];

    if (action) {
      e.preventDefault();
      e.stopPropagation();

      switch(action) {
        case 'prev': prevBtn.click(); break;
        case 'yes': yesBtn.click(); break;
        case 'no': noBtn.click(); break;
        case 'skip': skipBtn.click(); break;
        case 'focus_notes': if (notesArea) notesArea.focus(); break;
        case 'speech_notes':
          if (isRecording) {
            stopSpeechRecognition();
          } else {
            startSpeechRecognition();
          }
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
