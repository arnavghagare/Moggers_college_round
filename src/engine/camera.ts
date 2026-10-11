import type { FrameImage } from './vision';

export type CameraState = 'off' | 'starting' | 'on' | 'denied' | 'notfound' | 'error';

/** Not yet in the TypeScript DOM library. */
interface TrackProcessor {
  readable: ReadableStream<VideoFrame>;
}
declare const MediaStreamTrackProcessor:
  | (new (init: { track: MediaStreamTrack; maxBufferSize?: number }) => TrackProcessor)
  | undefined;

export interface CameraError {
  state: Exclude<CameraState, 'off' | 'starting' | 'on'>;
  message: string;
  recovery: string;
}

export function explainCameraError(err: unknown): CameraError {
  const name = err instanceof DOMException ? err.name : '';
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return {
      state: 'denied',
      message: 'Camera access was denied.',
      recovery: 'Open the Handsfree dashboard, allow the camera when asked, then switch Handsfree on again.',
    };
  }
  if (name === 'NotFoundError' || name === 'OverconstrainedError') {
    return {
      state: 'notfound',
      message: 'No camera was found.',
      recovery: 'Connect a webcam, or switch to voice-only mode.',
    };
  }
  if (name === 'NotReadableError' || name === 'AbortError') {
    return {
      state: 'error',
      message: 'The camera could not be started. Another application may be using it.',
      recovery: 'Close other apps that use the camera, then switch Handsfree on again.',
    };
  }
  return {
    state: 'error',
    message: `The camera failed: ${err instanceof Error ? err.message : String(err)}`,
    recovery: 'Check the camera connection, then switch Handsfree on again.',
  };
}

export type FrameHandler = (image: FrameImage, width: number, height: number) => void;

/**
 * Webcam capture. Frames are handed to the handler one at a time and never
 * stored. Uses MediaStreamTrackProcessor where available, because it keeps
 * delivering frames in a document that is not visible (the offscreen
 * document), which requestAnimationFrame does not.
 */
export class Camera {
  private stream: MediaStream | null = null;
  private video: HTMLVideoElement | null = null;
  private reader: ReadableStreamDefaultReader<VideoFrame> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private generation = 0;
  state: CameraState = 'off';
  label = '';
  width = 0;
  height = 0;
  deviceId: string | null = null;

  async start(
    deviceId: string | null,
    maxFps: number,
    onFrame: FrameHandler,
    onEnded: (error: CameraError) => void,
  ): Promise<void> {
    this.stop();
    const generation = ++this.generation;
    this.state = 'starting';

    const constraints = (id: string | null): MediaStreamConstraints => ({
      audio: false,
      video: {
        ...(id ? { deviceId: { exact: id } } : { facingMode: 'user' }),
        width: { ideal: 640 },
        height: { ideal: 480 },
        frameRate: { ideal: Math.min(30, maxFps), max: 60 },
      },
    });

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia(constraints(deviceId));
    } catch (err) {
      // A remembered device that has been unplugged should not block the default camera.
      if (deviceId && err instanceof DOMException && (err.name === 'OverconstrainedError' || err.name === 'NotFoundError')) {
        stream = await navigator.mediaDevices.getUserMedia(constraints(null));
      } else {
        this.state = explainCameraError(err).state;
        throw err;
      }
    }
    if (generation !== this.generation) {
      stream.getTracks().forEach((t) => t.stop());
      return;
    }

    const track = stream.getVideoTracks()[0];
    const settings = track.getSettings();
    this.stream = stream;
    this.label = track.label;
    this.width = settings.width ?? 640;
    this.height = settings.height ?? 480;
    this.deviceId = settings.deviceId ?? null;
    this.state = 'on';

    track.addEventListener('ended', () => {
      if (generation !== this.generation) return;
      this.stop();
      this.state = 'error';
      onEnded({
        state: 'error',
        message: 'The camera was disconnected.',
        recovery: 'Reconnect the camera, then switch Handsfree on again.',
      });
    });

    const minInterval = 1000 / maxFps - 4;
    let last = 0;
    const due = (): boolean => {
      const now = performance.now();
      if (now - last < minInterval) return false;
      last = now;
      return true;
    };

    if (typeof MediaStreamTrackProcessor === 'function') {
      const processor = new MediaStreamTrackProcessor({ track, maxBufferSize: 1 });
      const reader = processor.readable.getReader();
      this.reader = reader;
      void (async () => {
        try {
          while (generation === this.generation) {
            const { value: frame, done } = await reader.read();
            if (done || !frame) break;
            try {
              if (generation === this.generation && due()) onFrame(frame, frame.displayWidth, frame.displayHeight);
            } finally {
              frame.close();
            }
          }
        } catch (err) {
          if (generation === this.generation) console.warn('[handsfree] frame reader stopped', err);
        }
      })();
      return;
    }

    // Fallback: a <video> element polled on a timer.
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.srcObject = stream;
    this.video = video;
    await video.play();
    let lastTime = -1;
    this.timer = setInterval(() => {
      if (generation !== this.generation || video.readyState < 2 || video.currentTime === lastTime) return;
      lastTime = video.currentTime;
      if (due()) onFrame(video, video.videoWidth, video.videoHeight);
    }, 1000 / 60);
  }

  /** Stop capturing and release the camera (the indicator light goes off). */
  stop(): void {
    this.generation += 1;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    void this.reader?.cancel().catch(() => undefined);
    this.reader = null;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    if (this.video) {
      this.video.srcObject = null;
      this.video = null;
    }
    this.state = 'off';
    this.label = '';
  }
}

/**
 * Mean brightness and contrast of a frame, measured on a 32x24 thumbnail.
 * The thumbnail lives only for the duration of this call.
 */
export class LightMeter {
  private readonly canvas = new OffscreenCanvas(32, 24);
  private readonly ctx = this.canvas.getContext('2d', { willReadFrequently: true });

  measure(image: FrameImage): { luma: number; contrast: number } | null {
    if (!this.ctx) return null;
    try {
      this.ctx.drawImage(image, 0, 0, 32, 24);
      const { data } = this.ctx.getImageData(0, 0, 32, 24);
      let sum = 0;
      let sumSq = 0;
      const n = data.length / 4;
      for (let i = 0; i < data.length; i += 4) {
        const y = 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
        sum += y;
        sumSq += y * y;
      }
      const mean = sum / n;
      return { luma: mean, contrast: Math.sqrt(Math.max(0, sumSq / n - mean * mean)) };
    } catch {
      return null;
    }
  }
}
