/** Materials' 25 Hz clock. A stopped or invisible scene has no recurring frame. */
export function materialFrames({
  request,
  cancel,
  step,
  draw,
  publish,
}: {
  request: (callback: FrameRequestCallback) => number;
  cancel: (id: number) => void;
  step: () => void;
  draw: () => void;
  publish: () => void;
}) {
  let pending: number | null = null;
  let playing = false,
    visible = false,
    pageVisible = true,
    disposed = false;
  let dirty = true,
    previous: number | null = null,
    accumulator = 0,
    lastPublish = 0;
  const active = () => !disposed && visible && pageVisible;
  function stop() {
    if (pending !== null) cancel(pending);
    pending = null;
    previous = null;
    accumulator = 0;
  }
  function schedule() {
    if (active() && pending === null && (playing || dirty))
      pending = request(materialFrame);
  }
  function materialFrame(now: number) {
    pending = null;
    if (!active()) return;
    let advanced = false;
    if (playing) {
      accumulator +=
        previous === null ? 0 : Math.max(0, Math.min(80, now - previous));
      previous = now;
      while (accumulator >= 40) {
        step();
        accumulator -= 40;
        advanced = true;
      }
      dirty ||= advanced;
    }
    if (dirty) {
      dirty = false;
      draw();
    }
    if (advanced && now - lastPublish >= 300) {
      lastPublish = now;
      publish();
    }
    schedule();
  }
  return {
    setPlaying(value: boolean) {
      if (playing === value) return;
      playing = value;
      if (!value) stop();
      schedule();
    },
    setVisible(value: boolean) {
      if (visible === value) return;
      visible = value;
      dirty = true;
      if (!value) stop();
      schedule();
    },
    setPageVisible(value: boolean) {
      if (pageVisible === value) return;
      pageVisible = value;
      dirty = true;
      if (!value) stop();
      schedule();
    },
    invalidate() {
      dirty = true;
      schedule();
    },
    dispose() {
      disposed = true;
      stop();
    },
  };
}
