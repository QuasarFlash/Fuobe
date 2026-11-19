/**
 * Mirror mode's camera and face tracker (browser only). The MediaPipe face landmarker (Apache-2.0) loads from the same
 * pinned CDN build as src/lib/fix-faces/face-frame.ts, runs on the frames of the person's own camera, and gives the
 * expression scores and the pose matrix. No frame leaves the page.
 */

const TASKS_VERSION = "0.10.21";
const TASKS_BASE = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${TASKS_VERSION}`;
const MODEL = "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task";

export type FaceRead = { scores: Record<string, number>; matrix: ArrayLike<number> | null };

// The slice of the task library this file uses.
type Landmarker = {
  detectForVideo(video: HTMLVideoElement, timestamp: number): {
    faceBlendshapes?: { categories: { categoryName: string; score: number }[] }[];
    facialTransformationMatrixes?: { data: ArrayLike<number> }[];
  };
  close(): void;
};
type Tasks = {
  FilesetResolver: { forVisionTasks(base: string): Promise<unknown> };
  FaceLandmarker: { createFromOptions(fileset: unknown, options: Record<string, unknown>): Promise<Landmarker> };
};

export type FaceReader = { read(video: HTMLVideoElement, at: number): FaceRead | null; close(): void };

export async function createFaceReader(): Promise<FaceReader> {
  const tasks = (await import(/* webpackIgnore: true */ /* turbopackIgnore: true */ `${TASKS_BASE}/vision_bundle.mjs`)) as Tasks;
  const fileset = await tasks.FilesetResolver.forVisionTasks(`${TASKS_BASE}/wasm`);
  const make = (delegate: "GPU" | "CPU") =>
    tasks.FaceLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: MODEL, delegate },
      runningMode: "VIDEO",
      numFaces: 1,
      outputFaceBlendshapes: true,
      outputFacialTransformationMatrixes: true,
    });
  let lm: Landmarker;
  try {
    lm = await make("GPU");
  } catch {
    lm = await make("CPU");
  }
  let last = -1;
  return {
    read(video, at) {
      if (video.readyState < 2 || !video.videoWidth) return null;
      // The task wants timestamps that only go up.
      const t = Math.max(last + 1, Math.round(at));
      last = t;
      const res = lm.detectForVideo(video, t);
      const cats = res.faceBlendshapes?.[0]?.categories;
      if (!cats?.length) return null;
      const scores: Record<string, number> = {};
      for (const c of cats) scores[c.categoryName] = c.score;
      return { scores, matrix: res.facialTransformationMatrixes?.[0]?.data ?? null };
    },
    close() {
      lm.close();
    },
  };
}

/** Why the camera or the tracker didn't start, in terms the page can explain. */
export type CameraProblem = "blocked" | "none" | "busy" | "browser" | "load";

export function cameraProblemOf(e: unknown): CameraProblem {
  const name = e && typeof e === "object" && "name" in e ? String((e as { name: unknown }).name) : "";
  if (name === "NotAllowedError" || name === "SecurityError" || name === "PermissionDeniedError") return "blocked";
  if (name === "NotFoundError" || name === "OverconstrainedError" || name === "DevicesNotFoundError") return "none";
  if (name === "NotReadableError" || name === "AbortError" || name === "TrackStartError") return "busy";
  if (name === "BrowserError") return "browser";
  return "load";
}

/** The person's front camera, small (the tracker needs little). */
export async function openCamera(): Promise<MediaStream> {
  if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) throw Object.assign(new Error("No camera access here"), { name: "BrowserError" });
  return navigator.mediaDevices.getUserMedia({ video: { facingMode: "user", width: { ideal: 640 }, height: { ideal: 480 } }, audio: false });
}
