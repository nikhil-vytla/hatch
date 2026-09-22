import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type PointerEvent as ReactPointerEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type CSSProperties,
} from "react";
import type { Artwork } from "../visual-search/protocol";
import type { RankedArtwork } from "../visual-search/ranking";
import {
  layoutField,
  visibleNodes,
  zoomAt,
  cameraToNode,
  navigateField,
  FIELD_MIN_ZOOM,
  FIELD_MAX_ZOOM,
  type Camera,
  type FieldNode,
  type Direction,
} from "./field-layout";
import "./image-field.css";

type Props = {
  rows: readonly RankedArtwork[];
  onOpen: (work: Artwork, trigger: HTMLButtonElement) => void;
  queryKey: string;
  busy: boolean;
  inspecting: boolean;
  renderImage: (work: Artwork) => ReactNode;
};
type Point = { x: number; y: number };
type Pointer = Point & { target: Element };
type Gesture = {
  start: Point;
  camera: Camera;
  moved: boolean;
  pinch?: { distance: number; center: Point; camera: Camera };
};
const origin = (): Camera => ({ x: 0, y: 0, zoom: 1 });
const clampZoom = (zoom: number) =>
  Math.max(FIELD_MIN_ZOOM, Math.min(FIELD_MAX_ZOOM, zoom));
const centerOf = (a: Point, b: Point): Point => ({
  x: (a.x + b.x) / 2,
  y: (a.y + b.y) / 2,
});

export function ArtworkField({
  rows,
  onOpen,
  queryKey,
  busy,
  inspecting,
  renderImage,
}: Props) {
  const captionId = useId();
  const viewportRef = useRef<HTMLDivElement>(null);
  const buttons = useRef(new Map<number, HTMLButtonElement>());
  const signature = `${queryKey}\u0000${rows.map((row) => row.work.id).join(",")}`;
  const [placement, setPlacement] = useState(() => ({
    queryKey,
    signature,
    rows: [...rows],
  }));
  const [activeId, setActiveId] = useState<number | null>(
    () => rows[0]?.work.id ?? null,
  );
  const activeRef = useRef(activeId);
  const [viewport, setViewport] = useState({ width: 800, height: 560 });
  const [camera, setCamera] = useState<Camera>(origin);
  const cameraRef = useRef(camera);
  const frame = useRef(0);
  const pointers = useRef(new Map<number, Pointer>());
  const gesture = useRef<Gesture | null>(null);
  const suppressClickUntil = useRef(0);
  const pendingFocus = useRef<number | null>(null);
  const [interacting, setInteracting] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [touchPan, setTouchPan] = useState(false);
  // Freeze ordering within a query, never membership from a previous query.
  const positionedRows =
    placement.queryKey === queryKey ? placement.rows : rows;
  const nodes = useMemo(
    () => layoutField(positionedRows.map((row) => row.work.id)),
    [positionedRows],
  );
  const nodesById = useMemo(
    () => new Map(nodes.map((node) => [node.id, node])),
    [nodes],
  );
  const latestRows = useMemo(
    () => new Map(rows.map((row) => [row.work.id, row])),
    [rows],
  );
  const placedRows = useMemo(
    () => new Map(positionedRows.map((row) => [row.work.id, row])),
    [positionedRows],
  );
  const visible = useMemo(
    () => visibleNodes(nodes, camera, viewport, activeId ?? undefined),
    [nodes, camera, viewport, activeId],
  );
  const activeRow =
    activeId == null
      ? undefined
      : (latestRows.get(activeId) ?? placedRows.get(activeId));

  function moveCamera(next: Camera) {
    cameraRef.current = next;
    if (!frame.current)
      frame.current = requestAnimationFrame(() => {
        frame.current = 0;
        setCamera(cameraRef.current);
      });
  }
  function activate(id: number | null) {
    activeRef.current = id;
    setActiveId(id);
  }
  function reveal(node: FieldNode, center = false) {
    const current = cameraRef.current;
    const left = viewport.width / 2 + current.x + node.x * current.zoom;
    const top = viewport.height / 2 + current.y + node.y * current.zoom;
    if (
      center ||
      left < 12 ||
      top < 12 ||
      left + node.width * current.zoom > viewport.width - 12 ||
      top + node.height * current.zoom > viewport.height - 12
    ) {
      moveCamera(cameraToNode(current, node, viewport));
    }
  }
  function focusNode(id: number, center = false) {
    const node = nodesById.get(id);
    if (!node) return;
    const button = buttons.current.get(id);
    pendingFocus.current = button ? null : id;
    activate(id);
    reveal(node, center);
    button?.focus({ preventScroll: true });
  }
  useEffect(() => {
    const changedQuery = placement.queryKey !== queryKey;
    if (
      placement.signature === signature ||
      (!changedQuery && (busy || interacting || inspecting))
    )
      return;
    if (changedQuery) {
      pendingFocus.current = null;
      const captured = [...pointers.current];
      pointers.current.clear();
      gesture.current = null;
      setInteracting(false);
      setDragging(false);
      if (captured.length) suppressClickUntil.current = performance.now() + 250;
      for (const [id, pointer] of captured) {
        if (pointer.target.hasPointerCapture(id))
          pointer.target.releasePointerCapture(id);
      }
    }
    const nextId = rows.some((row) => row.work.id === activeRef.current)
      ? activeRef.current
      : (rows[0]?.work.id ?? null);
    const hadFocus = viewportRef.current?.contains(document.activeElement);
    setPlacement({ queryKey, signature, rows: [...rows] });
    activate(nextId);
    if (hadFocus && nextId != null) pendingFocus.current = nextId;
  }, [
    rows,
    queryKey,
    signature,
    placement.queryKey,
    placement.signature,
    busy,
    interacting,
    inspecting,
  ]);
  useEffect(() => {
    const id = pendingFocus.current;
    if (id == null) return;
    const button = buttons.current.get(id),
      node = nodesById.get(id);
    if (button && node) {
      pendingFocus.current = null;
      reveal(node);
      button.focus({ preventScroll: true });
    }
  }, [activeId, visible, nodesById]);
  useEffect(() => {
    const element = viewportRef.current;
    if (!element) return;
    const measure = () => {
      const box = element.getBoundingClientRect();
      setViewport((previous) =>
        previous.width === box.width && previous.height === box.height
          ? previous
          : { width: box.width, height: box.height },
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useEffect(
    () => () => {
      cancelAnimationFrame(frame.current);
      for (const [id, pointer] of pointers.current) {
        if (pointer.target.hasPointerCapture(id))
          pointer.target.releasePointerCapture(id);
      }
      pointers.current.clear();
      gesture.current = null;
    },
    [],
  );

  function point(event: ReactPointerEvent<HTMLDivElement>): Point {
    const box = event.currentTarget.getBoundingClientRect();
    return {
      x: event.clientX - box.left - box.width / 2,
      y: event.clientY - box.top - box.height / 2,
    };
  }
  function pointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (
      (event.pointerType === "touch" && !touchPan) ||
      inspecting ||
      event.button !== 0 ||
      pointers.current.size >= 2
    )
      return;
    pendingFocus.current = null;
    const position = point(event);
    const artwork = (event.target as Element).closest<HTMLButtonElement>(
      "button[data-artwork]",
    );
    const target = artwork ?? event.currentTarget;
    if (artwork) activate(Number(artwork.dataset.artwork));
    pointers.current.set(event.pointerId, { ...position, target });
    target.setPointerCapture(event.pointerId);
    setInteracting(true);
    if (pointers.current.size === 1) {
      gesture.current = {
        start: position,
        camera: cameraRef.current,
        moved: false,
      };
    } else {
      const [a, b] = [...pointers.current.values()];
      gesture.current = {
        start: position,
        camera: cameraRef.current,
        moved: true,
        pinch: {
          distance: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)),
          center: centerOf(a, b),
          camera: cameraRef.current,
        },
      };
      setDragging(true);
    }
  }
  function pointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const previous = pointers.current.get(event.pointerId),
      current = gesture.current;
    if (!previous || !current) return;
    const position = point(event);
    pointers.current.set(event.pointerId, { ...previous, ...position });
    if (pointers.current.size === 2 && current.pinch) {
      const [a, b] = [...pointers.current.values()],
        pinch = current.pinch;
      const center = centerOf(a, b);
      const zoom = clampZoom(
        (pinch.camera.zoom * Math.hypot(a.x - b.x, a.y - b.y)) / pinch.distance,
      );
      const next = zoomAt(pinch.camera, zoom, pinch.center);
      moveCamera({
        ...next,
        x: next.x + center.x - pinch.center.x,
        y: next.y + center.y - pinch.center.y,
      });
      event.preventDefault();
      return;
    }
    const dx = position.x - current.start.x,
      dy = position.y - current.start.y;
    if (!current.moved && Math.hypot(dx, dy) < 6) return;
    current.moved = true;
    setDragging(true);
    moveCamera({
      ...current.camera,
      x: current.camera.x + dx,
      y: current.camera.y + dy,
    });
    event.preventDefault();
  }
  function pointerEnd(
    event: ReactPointerEvent<HTMLDivElement>,
    cancelled = false,
  ) {
    const previous = pointers.current.get(event.pointerId);
    if (!previous) return;
    pointers.current.delete(event.pointerId);
    if (gesture.current?.moved || cancelled)
      suppressClickUntil.current = performance.now() + 250;
    if (previous.target.hasPointerCapture(event.pointerId))
      previous.target.releasePointerCapture(event.pointerId);
    if (pointers.current.size) {
      const remaining = [...pointers.current.values()][0];
      gesture.current = {
        start: remaining,
        camera: cameraRef.current,
        moved: true,
      };
    } else {
      gesture.current = null;
      setInteracting(false);
      setDragging(false);
    }
  }
  function keyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.altKey || event.ctrlKey || event.metaKey || !nodes.length) return;
    const directions: Record<string, Direction> = {
      ArrowLeft: "left",
      ArrowRight: "right",
      ArrowUp: "up",
      ArrowDown: "down",
    };
    const current = activeRef.current ?? nodes[0].id;
    let next: number;
    if (event.key === "Home") next = nodes[0].id;
    else if (event.key === "End") next = nodes[nodes.length - 1].id;
    else if (event.key === "PageDown" || event.key === "PageUp") {
      const index = nodes.findIndex((node) => node.id === current);
      next =
        nodes[
          Math.max(
            0,
            Math.min(
              nodes.length - 1,
              index + (event.key === "PageDown" ? 1 : -1),
            ),
          )
        ].id;
    } else if (directions[event.key])
      next = navigateField(nodes, current, directions[event.key]);
    else return;
    event.preventDefault();
    focusNode(next, event.key === "Home" || event.key === "End");
  }
  function zoom(factor: number) {
    const current = cameraRef.current;
    moveCamera(
      zoomAt(current, clampZoom(current.zoom * factor), { x: 0, y: 0 }),
    );
  }

  return (
    <section className="vs-field" aria-label="Ranked artwork field">
      <div className="vs-field-toolbar">
        <p id={captionId}>
          {busy
            ? "Ranking in progress. Positions stay fixed until it finishes."
            : "Ranked in rings from the center. Arrow keys move between works; Page Up and Page Down follow rank."}
        </p>
        <div className="vs-field-controls" role="group" aria-label="Field view">
          <button
            type="button"
            className="vs-field-touch"
            aria-pressed={touchPan}
            onClick={() => setTouchPan((value) => !value)}
          >
            Move field
          </button>
          <button
            type="button"
            onClick={() => zoom(1 / 1.25)}
            disabled={camera.zoom <= FIELD_MIN_ZOOM}
            aria-label="Zoom out"
          >
            −
          </button>
          <output aria-label="Zoom level">
            {Math.round(camera.zoom * 100)}%
          </output>
          <button
            type="button"
            onClick={() => zoom(1.25)}
            disabled={camera.zoom >= FIELD_MAX_ZOOM}
            aria-label="Zoom in"
          >
            +
          </button>
          <button
            type="button"
            className="vs-field-reset"
            onClick={() => moveCamera(origin())}
          >
            Reset view
          </button>
        </div>
      </div>
      <div
        ref={viewportRef}
        className={`vs-field-viewport${touchPan ? " vs-field-touch-pan" : ""}${dragging ? " vs-field-dragging" : ""}${camera.zoom < 0.8 ? " vs-field-overview" : ""}`}
        role="group"
        aria-label="Explore artworks"
        aria-describedby={captionId}
        aria-busy={busy}
        tabIndex={nodes.length ? -1 : 0}
        onPointerDown={pointerDown}
        onPointerMove={pointerMove}
        onPointerUp={(event) => pointerEnd(event)}
        onPointerCancel={(event) => pointerEnd(event, true)}
        onLostPointerCapture={(event) => pointerEnd(event, true)}
        onKeyDown={keyDown}
        onDragStart={(event) => event.preventDefault()}
      >
        <div
          className="vs-field-plane"
          style={
            {
              transform: `translate3d(${viewport.width / 2 + camera.x}px, ${viewport.height / 2 + camera.y}px, 0) scale(${camera.zoom})`,
              "--vs-field-label-size": `${12 / Math.min(camera.zoom, 1)}px`,
              "--vs-field-outline": `${2 / camera.zoom}px`,
            } as CSSProperties
          }
        >
          {visible.map((node) => {
            const row = latestRows.get(node.id) ?? placedRows.get(node.id);
            if (!row) return null;
            const rank =
              row.rank == null
                ? "Unscored"
                : `Rank ${row.rank}${row.tied > 1 ? ", tied" : ""}`;
            return (
              <button
                key={node.id}
                type="button"
                data-artwork={node.id}
                ref={(element) => {
                  if (element) buttons.current.set(node.id, element);
                  else buttons.current.delete(node.id);
                }}
                className={`vs-field-card${activeId === node.id ? " vs-field-active" : ""}`}
                style={{
                  left: node.x,
                  top: node.y,
                  width: node.width,
                  height: node.height,
                }}
                tabIndex={activeId === node.id ? 0 : -1}
                aria-label={`${rank}. ${row.work.title} by ${row.work.artist}. Open artwork details.`}
                onFocus={() => {
                  activate(node.id);
                  if (!pointers.current.size) reveal(node);
                }}
                onClick={(event) => {
                  if (
                    event.detail !== 0 &&
                    performance.now() < suppressClickUntil.current
                  ) {
                    event.preventDefault();
                    return;
                  }
                  onOpen(row.work, event.currentTarget);
                }}
              >
                <span className="vs-field-card-image">
                  {renderImage(row.work)}
                </span>
                <span className="vs-field-card-copy" aria-hidden="true">
                  <span className="vs-field-rank">
                    {row.rank == null
                      ? "Unscored"
                      : `#${row.rank}${row.tied > 1 ? " · tied" : ""}`}
                  </span>
                  <span className="vs-field-title">{row.work.title}</span>
                </span>
              </button>
            );
          })}
        </div>
        {!nodes.length && (
          <p className="vs-field-empty">No artworks in this view.</p>
        )}
      </div>
      {activeRow && (
        <p className="vs-field-current">
          <span>
            {activeRow.rank == null ? "Unscored" : `#${activeRow.rank}`}
          </span>
          {activeRow.work.title}
          <span> · {activeRow.work.artist}</span>
        </p>
      )}
    </section>
  );
}
