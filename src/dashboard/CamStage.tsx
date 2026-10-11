import { useEffect, useRef, useState } from 'react';
import { gestureName } from '../core/gestures/registry';
import type { DiagFrame, EngineStatus } from '../shared/types';
import { Chip, qualityText, qualityTone } from './components';
import { useEngine } from './engine';

/** One colour per finger, so each joint is easy to tell apart. */
const FINGER_COLORS = ['#ff8a00', '#ccff00', '#35e0ff', '#ff4fa3', '#b388ff'];
const FINGER_CHAINS = [
  [0, 1, 2, 3, 4],
  [0, 5, 6, 7, 8],
  [9, 10, 11, 12],
  [13, 14, 15, 16],
  [0, 17, 18, 19, 20],
];
const KNUCKLES = [5, 9, 13, 17];
const PALM = [0, 1, 5, 9, 13, 17];
const FACE_KEY_POINTS = [1, 10, 152, 234, 454, 33, 263, 61, 291];

const fingerOf = (i: number): number => (i === 0 ? -1 : Math.floor((i - 1) / 4));

export interface StageOverlay {
  /** The part of the camera view that maps to the whole screen in hand mode. */
  handArea?: { cx: number; cy: number; size: number };
}

interface Labels {
  status: EngineStatus | null;
}

function drawCornerBrackets(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, len: number, color: string, dpr: number): void {
  ctx.strokeStyle = color;
  ctx.lineWidth = 2 * dpr;
  ctx.beginPath();
  // Top-left
  ctx.moveTo(x, y + len); ctx.lineTo(x, y); ctx.lineTo(x + len, y);
  // Top-right
  ctx.moveTo(x + w - len, y); ctx.lineTo(x + w, y); ctx.lineTo(x + w, y + len);
  // Bottom-left
  ctx.moveTo(x, y + h - len); ctx.lineTo(x, y + h); ctx.lineTo(x + len, y + h);
  // Bottom-right
  ctx.moveTo(x + w - len, y + h); ctx.lineTo(x + w, y + h); ctx.lineTo(x + w, y + h - len);
  ctx.stroke();
}

function tag(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, color: string, dpr: number): void {
  ctx.font = `600 ${11 * dpr}px "Space Grotesk", monospace`;
  const textW = ctx.measureText(text).width;
  const pad = 8 * dpr;
  const h = 22 * dpr;
  const w = textW + pad * 2 + 12 * dpr;

  // Glass pill background
  ctx.save();
  ctx.fillStyle = 'rgba(8, 10, 16, 0.85)';
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.15)';
  ctx.lineWidth = 1 * dpr;
  ctx.beginPath();
  ctx.roundRect(x, y - h, w, h, 6 * dpr);
  ctx.fill();
  ctx.stroke();

  // Glowing indicator dot
  ctx.fillStyle = color;
  ctx.shadowColor = color;
  ctx.shadowBlur = 6 * dpr;
  ctx.beginPath();
  ctx.arc(x + 10 * dpr, y - h / 2, 3.5 * dpr, 0, Math.PI * 2);
  ctx.fill();

  // Text
  ctx.shadowBlur = 0;
  ctx.fillStyle = '#ffffff';
  ctx.fillText(text, x + 18 * dpr, y - 7 * dpr);
  ctx.restore();
}

function draw(canvas: HTMLCanvasElement, frame: DiagFrame | null, show: { face: boolean; hands: boolean }, overlay: StageOverlay, labels: Labels): void {
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const w = Math.round(rect.width * dpr);
  const h = Math.round(rect.height * dpr);
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.clearRect(0, 0, w, h);
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';

  if (overlay.handArea) {
    const a = overlay.handArea;
    const bx = (a.cx - a.size / 2) * w;
    const by = (a.cy - a.size / 2) * h;
    const bw = a.size * w;
    const bh = a.size * h;

    // Glowing screen active area
    ctx.save();
    ctx.strokeStyle = 'rgba(251, 146, 60, 0.4)';
    ctx.lineWidth = 1.5 * dpr;
    ctx.setLineDash([8 * dpr, 6 * dpr]);
    ctx.strokeRect(bx, by, bw, bh);
    ctx.setLineDash([]);
    drawCornerBrackets(ctx, bx, by, bw, bh, 14 * dpr, '#fb923c', dpr);
    tag(ctx, 'ACTIVE SCREEN AREA', bx, by - 6 * dpr, '#fb923c', dpr);
    ctx.restore();
  }

  if (!frame) return;

  if (show.face && frame.face) {
    ctx.save();
    // Fine biometric facial grid points with soft cyan glow
    ctx.fillStyle = 'rgba(56, 189, 248, 0.65)';
    for (let i = 0; i < frame.face.length; i += 2) {
      const [x, y] = frame.face[i];
      ctx.fillRect(x * w - dpr, y * h - dpr, 2 * dpr, 2 * dpr);
    }

    // Key anatomical facial anchors
    ctx.fillStyle = '#fb923c';
    ctx.shadowColor = '#fb923c';
    ctx.shadowBlur = 8 * dpr;
    for (const i of FACE_KEY_POINTS) {
      const p = frame.face[i];
      if (!p) continue;
      ctx.beginPath();
      ctx.arc(p[0] * w, p[1] * h, 3.5 * dpr, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.shadowBlur = 0;

    // Precision reticle on nose anchor
    const nose = frame.face[1];
    const face = labels.status?.face;
    if (nose) {
      const nx = nose[0] * w;
      const ny = nose[1] * h;
      ctx.strokeStyle = '#38bdf8';
      ctx.shadowColor = 'rgba(56, 189, 248, 0.8)';
      ctx.shadowBlur = 10 * dpr;
      ctx.lineWidth = 2 * dpr;

      // Circular reticle
      ctx.beginPath();
      ctx.arc(nx, ny, 12 * dpr, 0, Math.PI * 2);
      ctx.stroke();

      // Precision crosshairs
      ctx.beginPath();
      ctx.moveTo(nx - 20 * dpr, ny); ctx.lineTo(nx - 14 * dpr, ny);
      ctx.moveTo(nx + 14 * dpr, ny); ctx.lineTo(nx + 20 * dpr, ny);
      ctx.moveTo(nx, ny - 20 * dpr); ctx.lineTo(nx, ny - 14 * dpr);
      ctx.moveTo(nx, ny + 14 * dpr); ctx.lineTo(nx, ny + 20 * dpr);
      ctx.stroke();

      // Head pose directional ray
      if (face?.present) {
        const k = 4.5 * dpr;
        ctx.strokeStyle = '#f43f5e';
        ctx.shadowColor = '#f43f5e';
        ctx.lineWidth = 3.5 * dpr;
        ctx.beginPath();
        ctx.moveTo(nx, ny);
        ctx.lineTo(nx + face.yaw * k, ny - face.pitch * k);
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  if (show.hands) {
    for (const hand of frame.hands) {
      const pts = hand.points.map(([x, y]) => [x * w, y * h] as const);
      if (pts.length < 21) continue;
      const color = hand.handedness === 'Left' ? '#38bdf8' : '#10b981';

      ctx.save();
      // Frosted holographic palm mesh
      ctx.beginPath();
      PALM.forEach((i, n) => (n === 0 ? ctx.moveTo(pts[i][0], pts[i][1]) : ctx.lineTo(pts[i][0], pts[i][1])));
      ctx.closePath();
      ctx.fillStyle = hand.handedness === 'Left' ? 'rgba(56, 189, 248, 0.12)' : 'rgba(16, 185, 129, 0.12)';
      ctx.fill();

      // Glowing laser bones
      ctx.strokeStyle = color;
      ctx.shadowColor = color;
      ctx.shadowBlur = 8 * dpr;
      ctx.lineWidth = 2.5 * dpr;
      ctx.beginPath();
      for (const chain of FINGER_CHAINS) {
        chain.forEach((i, n) => (n === 0 ? ctx.moveTo(pts[i][0], pts[i][1]) : ctx.lineTo(pts[i][0], pts[i][1])));
      }
      KNUCKLES.forEach((i, n) => (n === 0 ? ctx.moveTo(pts[i][0], pts[i][1]) : ctx.lineTo(pts[i][0], pts[i][1])));
      ctx.stroke();
      ctx.shadowBlur = 0;

      // Holographic joint points
      pts.forEach(([x, y], i) => {
        const finger = fingerOf(i);
        const jointColor = finger < 0 ? '#ffffff' : FINGER_COLORS[finger];
        ctx.beginPath();
        ctx.arc(x, y, (i % 4 === 0 && i > 0 ? 5.5 : 4) * dpr, 0, Math.PI * 2);
        ctx.fillStyle = jointColor;
        ctx.shadowColor = jointColor;
        ctx.shadowBlur = 6 * dpr;
        ctx.fill();
        ctx.shadowBlur = 0;
        ctx.lineWidth = 1.2 * dpr;
        ctx.strokeStyle = '#05070c';
        ctx.stroke();
      });

      // Spatial HUD corner brackets bounding the hand
      const xs = pts.map((p) => p[0]);
      const ys = pts.map((p) => p[1]);
      const pad = 24 * dpr;
      const x0 = Math.max(4 * dpr, Math.min(...xs) - pad);
      const y0 = Math.max(26 * dpr, Math.min(...ys) - pad);
      const x1 = Math.min(w - 4 * dpr, Math.max(...xs) + pad);
      const y1 = Math.min(h - 4 * dpr, Math.max(...ys) + pad);
      const bw = x1 - x0;
      const bh = y1 - y0;

      // Corner brackets & subtle bounding line
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.1)';
      ctx.lineWidth = 1 * dpr;
      ctx.strokeRect(x0, y0, bw, bh);
      drawCornerBrackets(ctx, x0, y0, bw, bh, 14 * dpr, color, dpr);

      const info = labels.status?.hands.find((s) => s.handedness === hand.handedness);
      const pose = info?.pose ? ` // ${gestureName(info.pose).toUpperCase()} ${Math.round(info.poseConfidence * 100)}%` : '';
      tag(ctx, `${hand.handedness.toUpperCase()}${pose}`, x0, y0 - 6 * dpr, color, dpr);
      ctx.restore();
    }
  }
}

/**
 * Your camera, with what Handsfree sees drawn on top. A live view only:
 * nothing shown here is recorded or stored.
 */
export function CamStage(props: {
  face?: boolean;
  hands?: boolean;
  overlay?: StageOverlay;
  title?: string;
  mono?: boolean;
}) {
  const engine = useEngine();
  const { status, settings, enabled, onFrame } = engine;
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const cameraOn = status?.camera.state === 'on';

  // Latest values for the paint loop, without re-subscribing on every status update.
  const live = useRef({ status, overlay: props.overlay ?? {}, face: props.face ?? false, hands: props.hands ?? false });
  live.current = { status, overlay: props.overlay ?? {}, face: props.face ?? false, hands: props.hands ?? false };

  useEffect(() => {
    if (!enabled) return;
    let latest: DiagFrame | null = null;
    let raf = 0;
    const paint = (): void => {
      raf = 0;
      const c = live.current;
      if (canvasRef.current) draw(canvasRef.current, latest, { face: c.face, hands: c.hands }, c.overlay, { status: c.status });
    };
    const off = onFrame((frame) => {
      latest = frame;
      if (!raf) raf = requestAnimationFrame(paint);
    });
    return () => {
      off();
      if (raf) cancelAnimationFrame(raf);
    };
  }, [enabled, onFrame]);

  // A second, local view of the same camera, open only while this is on screen.
  useEffect(() => {
    if (!cameraOn) return;
    let stream: MediaStream | null = null;
    let alive = true;
    const video = videoRef.current;
    setPreviewError(null);
    navigator.mediaDevices
      .getUserMedia({
        audio: false,
        video: { ...(settings.camera.deviceId ? { deviceId: { exact: settings.camera.deviceId } } : {}), width: { ideal: 640 }, height: { ideal: 480 } },
      })
      .then((s) => {
        if (!alive) {
          s.getTracks().forEach((t) => t.stop());
          return;
        }
        stream = s;
        if (video) video.srcObject = s;
      })
      .catch((err: unknown) => setPreviewError(err instanceof Error ? err.message : String(err)));
    return () => {
      alive = false;
      stream?.getTracks().forEach((t) => t.stop());
      if (video) video.srcObject = null;
    };
  }, [cameraOn, settings.camera.deviceId]);

  const placeholder = !enabled
    ? 'Handsfree is off. Turn it on to see yourself here.'
    : settings.controlMode === 'voice' && !settings.features.handGestures && !settings.features.faceGestures
      ? 'Voice mode does not use the camera.'
      : (status?.error?.message ?? 'Waking up the camera...');

  return (
    <div
      className={`stage${props.mono ? ' mono' : ''}`}
      aria-label="Your camera with tracking drawn on top"
      // Match the camera's shape so the drawing lines up with the picture.
      style={status && cameraOn && status.camera.height > 0 ? { aspectRatio: `${status.camera.width} / ${status.camera.height}` } : undefined}
    >
      <video ref={videoRef} autoPlay muted playsInline />
      <canvas ref={canvasRef} />
      <div className="badge">
        <Chip tone={cameraOn ? 'live' : ''}>{cameraOn ? 'Cam on' : 'Cam off'}</Chip>
        {props.face && status && <Chip tone={qualityTone(status.face.quality)}>Face {qualityText(status.face.quality)}</Chip>}
        {props.hands && status && status.models.hand !== 'off' && (
          <Chip tone={status.hands.length ? qualityTone(status.handQuality) : ''}>
            {status.hands.length} hand{status.hands.length === 1 ? '' : 's'}
          </Chip>
        )}
      </div>
      {!cameraOn && <div className="placeholder">{placeholder}</div>}
      <div className="titlebar">
        <span>{props.title ?? 'Live view'}</span>
        <span>{previewError ? 'preview unavailable' : status && cameraOn ? `${status.perf.fps.toFixed(0)} fps · not recorded` : 'not recorded'}</span>
      </div>
    </div>
  );
}
