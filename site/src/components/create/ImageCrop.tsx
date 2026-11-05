"use client";

/*
  The crop step on /create (the founder approved the mock 2026-10-25: review/2026-10-25-founder-issues/image-crop-mock, state 2).
  The chosen picture in a square frame with thirds lines; drag to move, pinch or the slider to zoom; "Use this crop"
  hands back the square drawn on a canvas (lib/bouncer/imageCrop.ts), "Choose another" goes back to the picker.
*/
import { useEffect, useRef, useState } from "react";
import { centred, clampCrop, clampZoom, cropRect, dragged, drawSquare, ZOOM_MAX, type Crop, type Picked } from "@/lib/bouncer/imageCrop";

export type { Picked };

export function ImageCrop({ picked, onUse, onCancel }: { picked: Picked; onUse: (url: string, side: number | null) => void; onCancel: () => void }) {
  const [crop, setCrop] = useState<Crop>(() => centred(picked.w, picked.h));
  const frame = useRef<HTMLDivElement | null>(null);
  const img = useRef<HTMLImageElement | null>(null);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const pinch = useRef<{ dist: number; zoom: number } | null>(null);
  const [size, setSize] = useState(0);

  useEffect(() => {
    const el = frame.current;
    if (!el) return;
    const measure = () => setSize(el.clientWidth);
    measure();
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(measure) : null;
    ro?.observe(el);
    return () => ro?.disconnect();
  }, []);

  const k = clampCrop(picked.w, picked.h, crop);
  const r = cropRect(picked.w, picked.h, k);
  const scale = size > 0 ? size / r.side : 0;

  const onDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      pinch.current = { dist: Math.hypot(a.x - b.x, a.y - b.y), zoom: k.zoom };
    }
  };
  const onMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const last = pointers.current.get(e.pointerId);
    if (!last || size === 0) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.current.size >= 2 && pinch.current) {
      const [a, b] = [...pointers.current.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      const p = pinch.current;
      if (p.dist > 0) setCrop((c) => clampCrop(picked.w, picked.h, { ...c, zoom: clampZoom((p.zoom * dist) / p.dist) }));
      return;
    }
    setCrop((c) => dragged(picked.w, picked.h, c, size, e.clientX - last.x, e.clientY - last.y));
  };
  const onUp = (e: React.PointerEvent<HTMLDivElement>) => {
    pointers.current.delete(e.pointerId);
    if (pointers.current.size < 2) pinch.current = null;
  };

  const use = () => {
    if (!img.current) return;
    const out = drawSquare(img.current, picked, k);
    onUse(out.url, out.side);
  };

  return (
    <div className="inset p-3 mt-2" data-crop>
      <div
        ref={frame}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
        style={{ position: "relative", margin: "0 auto", width: "100%", maxWidth: "22rem", aspectRatio: "1 / 1", overflow: "hidden", borderRadius: 12, background: "#0b0f14", touchAction: "none", userSelect: "none", cursor: "grab" }}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          ref={img}
          src={picked.url}
          alt=""
          draggable={false}
          style={{ position: "absolute", left: -r.sx * scale, top: -r.sy * scale, width: picked.w * scale, height: picked.h * scale, maxWidth: "none", pointerEvents: "none" }}
        />
        <div style={{ position: "absolute", inset: 0, boxShadow: "inset 0 0 0 2px rgba(255,255,255,0.85)", borderRadius: 12, pointerEvents: "none" }} />
        <div
          style={{
            position: "absolute",
            inset: 0,
            pointerEvents: "none",
            background:
              "linear-gradient(to right,transparent 33.2%,rgba(255,255,255,.25) 33.3%,transparent 33.5%,transparent 66.5%,rgba(255,255,255,.25) 66.6%,transparent 66.8%),linear-gradient(to bottom,transparent 33.2%,rgba(255,255,255,.25) 33.3%,transparent 33.5%,transparent 66.5%,rgba(255,255,255,.25) 66.6%,transparent 66.8%)",
          }}
        />
      </div>
      <p className="text-text-3 text-center mt-2">Drag to move. Pinch or slide to zoom.</p>
      <input
        type="range"
        className="cap-range mt-2"
        min={1}
        max={ZOOM_MAX}
        step={0.01}
        value={k.zoom}
        style={{ "--p": (k.zoom - 1) / (ZOOM_MAX - 1) } as React.CSSProperties}
        aria-label="Zoom"
        onChange={(e) => setCrop((c) => clampCrop(picked.w, picked.h, { ...c, zoom: clampZoom(Number(e.target.value)) }))}
      />
      <div className="grid grid-cols-2 gap-2 mt-3">
        <button type="button" className="btn btn-secondary w-full" onClick={onCancel}>
          Choose another
        </button>
        <button type="button" className="btn btn-primary w-full" onClick={use}>
          Use this crop
        </button>
      </div>
    </div>
  );
}
