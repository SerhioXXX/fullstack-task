import { useEffect, useRef } from 'react';
import { frameLoop, pool, store } from '../app.ts';
import { MapRenderer } from '../render/mapRenderer.ts';
import { ConnectionLostBanner } from './ConnectionBadge.tsx';
import { DiagnosticsOverlay } from './DiagnosticsOverlay.tsx';

export function MapView() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const renderer = new MapRenderer(canvasRef.current!, store, pool, frameLoop);
    return () => renderer.destroy();
  }, []);

  return (
    <div className="map">
      <canvas ref={canvasRef} className="map-canvas" />
      <ConnectionLostBanner />
      <DiagnosticsOverlay />
    </div>
  );
}
