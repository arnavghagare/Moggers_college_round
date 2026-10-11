// Copies the MediaPipe WASM runtime out of node_modules and downloads the two
// landmark models into public/, so the extension ships everything locally and
// never fetches model code or weights at runtime.
import { copyFile, mkdir, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const wasmSrc = join(root, 'node_modules', '@mediapipe', 'tasks-vision', 'wasm');
const wasmDst = join(root, 'public', 'wasm');
const modelDst = join(root, 'public', 'models');

const WASM_FILES = [
  'vision_wasm_internal.js',
  'vision_wasm_internal.wasm',
  'vision_wasm_nosimd_internal.js',
  'vision_wasm_nosimd_internal.wasm',
];

const MODELS = [
  {
    file: 'face_landmarker.task',
    url: 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task',
    minBytes: 3_000_000,
  },
  {
    file: 'hand_landmarker.task',
    url: 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task',
    minBytes: 5_000_000,
  },
];

async function size(path) {
  try {
    return (await stat(path)).size;
  } catch {
    return -1;
  }
}

await mkdir(wasmDst, { recursive: true });
await mkdir(modelDst, { recursive: true });

for (const file of WASM_FILES) {
  const from = join(wasmSrc, file);
  const to = join(wasmDst, file);
  if ((await size(from)) !== (await size(to))) {
    await copyFile(from, to);
    console.log(`copied wasm/${file}`);
  }
}

for (const model of MODELS) {
  const to = join(modelDst, model.file);
  if ((await size(to)) >= model.minBytes) continue;
  console.log(`downloading ${model.file} ...`);
  const res = await fetch(model.url);
  if (!res.ok) {
    console.error(`Failed to download ${model.url}: HTTP ${res.status}`);
    process.exit(1);
  }
  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.length < model.minBytes) {
    console.error(`Downloaded ${model.file} is unexpectedly small (${bytes.length} bytes).`);
    process.exit(1);
  }
  await writeFile(to, bytes);
  console.log(`saved models/${model.file} (${bytes.length} bytes)`);
}
