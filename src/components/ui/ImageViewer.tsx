'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

export interface ViewerImage {
  url: string;
  alt: string;
  caption?: string;
}

interface Props {
  images: ViewerImage[];
  /** Which image to show first. */
  index?: number;
  onClose(): void;
}

const MIN = 1;
const MAX = 6;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * Full-screen image viewer. Zoom with the wheel, a pinch, a double click/tap,
 * the +/- buttons or keys; drag to pan when zoomed in; arrows move between
 * images; Esc closes.
 */
export function ImageViewer({ images, index = 0, onClose }: Props) {
  const [current, setCurrent] = useState(clamp(index, 0, images.length - 1));
  const [view, setView] = useState({ scale: 1, x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const stage = useRef<HTMLDivElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<{ distance: number; scale: number } | null>(null);
  const moved = useRef(false);
  const picture = useRef<HTMLImageElement>(null);
  // latest values for listeners that are registered once
  const viewRef = useRef(view);
  viewRef.current = view;
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  /** Keeps the picture from being dragged out of sight. */
  const bounded = useCallback((scale: number, x: number, y: number) => {
    const rect = stage.current?.getBoundingClientRect();
    const maxX = rect ? ((scale - 1) * rect.width) / 2 : 0;
    const maxY = rect ? ((scale - 1) * rect.height) / 2 : 0;
    return { scale, x: clamp(x, -maxX, maxX), y: clamp(y, -maxY, maxY) };
  }, []);

  /** Zooms to `scale`, keeping the point under (clientX, clientY) fixed. */
  const zoomTo = useCallback(
    (scale: number, clientX?: number, clientY?: number) => {
      setView((v) => {
        const next = clamp(scale, MIN, MAX);
        const rect = stage.current?.getBoundingClientRect();
        if (!rect || next === v.scale) return v;
        const px = (clientX ?? rect.left + rect.width / 2) - (rect.left + rect.width / 2);
        const py = (clientY ?? rect.top + rect.height / 2) - (rect.top + rect.height / 2);
        const ratio = next / v.scale;
        return bounded(next, px - (px - v.x) * ratio, py - (py - v.y) * ratio);
      });
    },
    [bounded],
  );

  const reset = useCallback(() => setView({ scale: 1, x: 0, y: 0 }), []);
  const go = useCallback(
    (delta: number) => {
      setCurrent((c) => (c + delta + images.length) % images.length);
      reset();
    },
    [images.length, reset],
  );

  useEffect(() => {
    const previousFocus = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    root.current?.focus();

    const onKey = (e: KeyboardEvent) => {
      const actions: Record<string, () => void> = {
        Escape: () => closeRef.current(),
        '+': () => zoomTo(viewRef.current.scale * 1.5),
        '=': () => zoomTo(viewRef.current.scale * 1.5),
        '-': () => zoomTo(viewRef.current.scale / 1.5),
        '0': reset,
        ArrowLeft: () => images.length > 1 && go(-1),
        ArrowRight: () => images.length > 1 && go(1),
      };
      const action = actions[e.key];
      if (!action) return;
      // capture phase + stop: a dialog underneath must not also react to Esc
      e.stopPropagation();
      e.preventDefault();
      action();
    };
    document.addEventListener('keydown', onKey, true);

    // wheel must be non-passive so the page behind does not scroll or zoom
    const el = stage.current;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      zoomTo(viewRef.current.scale * Math.exp(-e.deltaY * 0.002), e.clientX, e.clientY);
    };
    el?.addEventListener('wheel', onWheel, { passive: false });

    return () => {
      document.removeEventListener('keydown', onKey, true);
      el?.removeEventListener('wheel', onWheel);
      document.body.style.overflow = previousOverflow;
      previousFocus?.focus?.();
    };
  }, [zoomTo, reset, go, images.length]);

  function onPointerDown(e: React.PointerEvent) {
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    moved.current = false;
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      gesture.current = { distance: Math.hypot(a.x - b.x, a.y - b.y), scale: view.scale };
    }
    setDragging(true);
  }

  function onPointerMove(e: React.PointerEvent) {
    const last = pointers.current.get(e.pointerId);
    if (!last) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (pointers.current.size === 2 && gesture.current) {
      const [a, b] = [...pointers.current.values()];
      const distance = Math.hypot(a.x - b.x, a.y - b.y);
      if (gesture.current.distance > 0)
        zoomTo((gesture.current.scale * distance) / gesture.current.distance, (a.x + b.x) / 2, (a.y + b.y) / 2);
      moved.current = true;
      return;
    }
    const dx = e.clientX - last.x;
    const dy = e.clientY - last.y;
    if (Math.abs(dx) + Math.abs(dy) > 2) moved.current = true;
    setView((v) => (v.scale > 1 ? bounded(v.scale, v.x + dx, v.y + dy) : v));
  }

  function onPointerUp(e: React.PointerEvent) {
    pointers.current.delete(e.pointerId);
    if (pointers.current.size < 2) gesture.current = null;
    if (pointers.current.size === 0) setDragging(false);
  }

  function onDoubleClick(e: React.MouseEvent) {
    if (view.scale > 1) reset();
    else zoomTo(2.5, e.clientX, e.clientY);
  }

  const image = images[current];
  if (!image) return null;
  const zoomed = view.scale > 1;
  const control = 'rounded-lg px-3 py-2 text-sm font-medium text-onaccent hover:bg-onaccent/15 disabled:opacity-40 disabled:hover:bg-transparent';

  return createPortal(
    <div
      ref={root}
      role="dialog"
      aria-modal="true"
      aria-label={`Image viewer: ${image.alt}`}
      tabIndex={-1}
      className="fixed inset-0 z-[60] flex flex-col bg-black outline-none"
    >
      <div className="flex items-center gap-1 px-2 py-2 text-onaccent">
        <p className="min-w-0 flex-1 truncate px-2 text-sm">
          {image.caption ?? image.alt}
          {images.length > 1 && (
            <span className="text-onaccent/60">
              {' '}
              · {current + 1} of {images.length}
            </span>
          )}
        </p>
        <button type="button" className={control} onClick={() => zoomTo(view.scale / 1.5)} disabled={view.scale <= MIN} aria-label="Zoom out">
          −
        </button>
        <button type="button" className={`${control} w-16 tabular-nums`} onClick={reset} disabled={!zoomed} aria-label="Reset zoom" title="Reset zoom">
          {Math.round(view.scale * 100)}%
        </button>
        <button type="button" className={control} onClick={() => zoomTo(view.scale * 1.5)} disabled={view.scale >= MAX} aria-label="Zoom in">
          +
        </button>
        <button type="button" className={control} onClick={onClose} aria-label="Close image viewer">
          ✕
        </button>
      </div>

      <div
        ref={stage}
        className={`relative flex-1 touch-none select-none overflow-hidden ${zoomed ? (dragging ? 'cursor-grabbing' : 'cursor-grab') : 'cursor-zoom-in'}`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onDoubleClick={onDoubleClick}
        onClick={(e) => {
          // A plain click beside the picture (not a drag) closes. While the
          // picture is still loading it has no size, so nothing counts as "beside".
          const r = picture.current?.getBoundingClientRect();
          if (!r || r.width === 0 || moved.current || zoomed || e.target !== e.currentTarget) return;
          const onPicture = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
          if (!onPicture) onClose();
        }}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          key={image.url}
          ref={picture}
          src={image.url}
          alt={image.alt}
          draggable={false}
          className="pointer-events-none absolute inset-0 m-auto max-h-full max-w-full object-contain"
          style={{
            transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})`,
            transition: dragging ? 'none' : 'transform 120ms ease-out',
          }}
        />
        {images.length > 1 && (
          <>
            <button
              type="button"
              onClick={() => go(-1)}
              onPointerDown={(e) => e.stopPropagation()}
              onDoubleClick={(e) => e.stopPropagation()}
              aria-label="Previous image"
              className="absolute left-2 top-1/2 -translate-y-1/2 rounded-full bg-black/50 px-3 py-2 text-xl text-onaccent hover:bg-black/70"
            >
              ‹
            </button>
            <button
              type="button"
              onClick={() => go(1)}
              onPointerDown={(e) => e.stopPropagation()}
              onDoubleClick={(e) => e.stopPropagation()}
              aria-label="Next image"
              className="absolute right-2 top-1/2 -translate-y-1/2 rounded-full bg-black/50 px-3 py-2 text-xl text-onaccent hover:bg-black/70"
            >
              ›
            </button>
          </>
        )}
      </div>
      <p className="truncate px-3 py-2 text-center text-xs text-onaccent/60">
        <span className="sm:hidden">Pinch or double-tap to zoom · drag to move</span>
        <span className="hidden sm:inline">Scroll or double-click to zoom · drag to move · Esc to close</span>
      </p>
    </div>,
    document.body,
  );
}

/** An image that opens the viewer when clicked. */
export function ZoomableImage({
  image,
  gallery,
  className = '',
}: {
  image: ViewerImage;
  /** Other images to page through; defaults to just this one. */
  gallery?: ViewerImage[];
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const images = gallery?.length ? gallery : [image];
  const index = Math.max(0, images.findIndex((i) => i.url === image.url));
  const close = useCallback(() => setOpen(false), []);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)} aria-label={`Open ${image.alt} full screen`} className="block w-full cursor-zoom-in">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={image.url} alt={image.alt} className={className} />
      </button>
      {open && <ImageViewer images={images} index={index} onClose={close} />}
    </>
  );
}
