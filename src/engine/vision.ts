import { FaceLandmarker, FilesetResolver, HandLandmarker } from '@mediapipe/tasks-vision';
import type { FaceObservation } from '../core/face/pose';
import type { HandObservation } from '../core/hand/features';
import type { Handedness } from '../shared/types';

export type ModelState = 'off' | 'loading' | 'ready' | 'error';
export type FrameImage = VideoFrame | HTMLVideoElement | ImageBitmap;

type Fileset = Awaited<ReturnType<typeof FilesetResolver.forVisionTasks>>;

/**
 * MediaPipe Face Landmarker and Hand Landmarker, loaded from files packaged
 * with the extension. Nothing is downloaded at runtime and no frame leaves
 * this document.
 *
 * The camera image is not mirrored, but everything downstream works in a
 * mirror view (move right -> things move right), so x is flipped here and the
 * model's handedness label, which assumes a mirrored image, is swapped.
 */
export class Vision {
  private fileset: Fileset | null = null;
  private face: FaceLandmarker | null = null;
  private hand: HandLandmarker | null = null;
  private delegateInUse: 'GPU' | 'CPU' = 'GPU';
  faceState: ModelState = 'off';
  handState: ModelState = 'off';
  lastError = '';

  get delegate(): string {
    return this.face || this.hand ? this.delegateInUse : '-';
  }

  get hasFace(): boolean {
    return this.face !== null;
  }

  get hasHand(): boolean {
    return this.hand !== null;
  }

  private async files(): Promise<Fileset> {
    this.fileset ??= await FilesetResolver.forVisionTasks(chrome.runtime.getURL('wasm'));
    return this.fileset;
  }

  /** Load or unload models so that exactly the requested ones are in memory. */
  async configure(want: { face: boolean; hand: boolean; delegate: 'GPU' | 'CPU' }): Promise<void> {
    if (want.delegate !== this.delegateInUse && (this.face || this.hand)) this.dispose();
    this.delegateInUse = want.delegate;

    if (!want.face && this.face) {
      this.face.close();
      this.face = null;
    }
    if (!want.hand && this.hand) {
      this.hand.close();
      this.hand = null;
    }
    if (!want.face) this.faceState = 'off';
    if (!want.hand) this.handState = 'off';

    if (want.face && !this.face) {
      this.faceState = 'loading';
      try {
        this.face = await this.withFallback((delegate) => this.createFace(delegate));
        this.faceState = 'ready';
      } catch (err) {
        this.faceState = 'error';
        this.lastError = `Face model failed to load: ${describe(err)}`;
        throw err;
      }
    }
    if (want.hand && !this.hand) {
      this.handState = 'loading';
      try {
        this.hand = await this.withFallback((delegate) => this.createHand(delegate));
        this.handState = 'ready';
      } catch (err) {
        this.handState = 'error';
        this.lastError = `Hand model failed to load: ${describe(err)}`;
        throw err;
      }
    }
  }

  /** Try the configured delegate; if the GPU path is unavailable, fall back to CPU. */
  private async withFallback<T>(create: (delegate: 'GPU' | 'CPU') => Promise<T>): Promise<T> {
    try {
      return await create(this.delegateInUse);
    } catch (err) {
      if (this.delegateInUse === 'CPU') throw err;
      console.warn('[handsfree] GPU delegate failed, using CPU', err);
      this.delegateInUse = 'CPU';
      return create('CPU');
    }
  }

  private async createFace(delegate: 'GPU' | 'CPU'): Promise<FaceLandmarker> {
    return FaceLandmarker.createFromOptions(await this.files(), {
      baseOptions: { modelAssetPath: chrome.runtime.getURL('models/face_landmarker.task'), delegate },
      runningMode: 'VIDEO',
      numFaces: 1,
      outputFaceBlendshapes: true,
      outputFacialTransformationMatrixes: true,
      minFaceDetectionConfidence: 0.5,
      minFacePresenceConfidence: 0.5,
      minTrackingConfidence: 0.5,
    });
  }

  private async createHand(delegate: 'GPU' | 'CPU'): Promise<HandLandmarker> {
    return HandLandmarker.createFromOptions(await this.files(), {
      baseOptions: { modelAssetPath: chrome.runtime.getURL('models/hand_landmarker.task'), delegate },
      runningMode: 'VIDEO',
      numHands: 2,
      minHandDetectionConfidence: 0.5,
      minHandPresenceConfidence: 0.5,
      minTrackingConfidence: 0.5,
    });
  }

  detectFace(image: FrameImage, timestampMs: number): FaceObservation | null {
    if (!this.face) return null;
    const result = this.face.detectForVideo(image, timestampMs);
    const landmarks = result.faceLandmarks?.[0];
    if (!landmarks || landmarks.length === 0) return null;

    let blendshapes: Record<string, number> | null = null;
    const categories = result.faceBlendshapes?.[0]?.categories;
    if (categories && categories.length > 0) {
      blendshapes = {};
      for (const c of categories) blendshapes[c.categoryName] = c.score;
    }
    const matrix = result.facialTransformationMatrixes?.[0]?.data;
    return {
      landmarks: landmarks.map((p) => ({ x: 1 - p.x, y: p.y, z: p.z })),
      blendshapes,
      matrix: matrix && matrix.length >= 16 ? Array.from(matrix) : null,
    };
  }

  detectHands(image: FrameImage, timestampMs: number): HandObservation[] {
    if (!this.hand) return [];
    const result = this.hand.detectForVideo(image, timestampMs);
    const out: HandObservation[] = [];
    for (let i = 0; i < result.landmarks.length; i++) {
      const landmarks = result.landmarks[i];
      if (!landmarks || landmarks.length !== 21) continue;
      const category = result.handedness?.[i]?.[0];
      const world = result.worldLandmarks?.[i];
      // The model labels hands as if the image were mirrored; ours is not.
      const handedness: Handedness = category?.categoryName === 'Left' ? 'Right' : 'Left';
      out.push({
        landmarks: landmarks.map((p) => ({ x: 1 - p.x, y: p.y, z: p.z })),
        world: world && world.length === 21 ? world.map((p) => ({ x: -p.x, y: p.y, z: p.z })) : null,
        handedness,
        score: category?.score ?? 0,
      });
    }
    return out;
  }

  dispose(): void {
    this.face?.close();
    this.hand?.close();
    this.face = null;
    this.hand = null;
    this.faceState = 'off';
    this.handState = 'off';
  }
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
