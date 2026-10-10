export type CapState = 'Supported' | 'Limited' | 'Unavailable';
export interface Capability { id: string; label: string; state: CapState; detail: string }

/** Pure detection against an environment object so it can be tested with fakes. */
export function detectCapabilities(env: Record<string, any> = globalThis as any): Capability[] {
  const has = (k: string) => typeof env[k] !== 'undefined';
  const wasm = has('WebAssembly') && typeof env.WebAssembly?.instantiate === 'function';
  const worker = has('Worker');
  const idb = has('indexedDB') && !!env.indexedDB;
  const canvas = has('document') || has('OffscreenCanvas');
  const lowMem = typeof env.navigator?.deviceMemory === 'number' && env.navigator.deviceMemory < 4;

  const caps: Capability[] = [
    { id: 'wasm', label: 'WebAssembly', state: wasm ? 'Supported' : 'Unavailable', detail: wasm ? 'Required for FFmpeg.' : 'Media converter cannot run.' },
    { id: 'workers', label: 'Web Workers', state: worker ? 'Supported' : 'Unavailable', detail: worker ? 'Heavy work runs off the main thread.' : 'PDF rendering and FFmpeg are unavailable.' },
    { id: 'idb', label: 'IndexedDB', state: idb ? 'Supported' : 'Limited', detail: idb ? 'Available for local storage.' : 'Drafts and activity use localStorage only (or are not saved).' },
    {
      id: 'folder-sync', label: 'Folder sync', state: 'Supported',
      detail: 'Prepares rsync commands from typed paths. Run them in your terminal; no browser folder access is needed.',
    },
    {
      id: 'pdfjs', label: 'PDF.js', state: worker && canvas ? 'Supported' : canvas ? 'Limited' : 'Unavailable',
      detail: worker && canvas ? 'Bundled locally with a worker.' : canvas ? 'No worker: rendering runs on the main thread.' : 'Canvas not available.',
    },
    {
      id: 'ffmpeg', label: 'FFmpeg WebAssembly', state: !wasm || !worker ? 'Unavailable' : lowMem ? 'Limited' : 'Supported',
      detail: !wasm || !worker ? 'Needs WebAssembly and Web Workers.' : lowMem ? 'Low device memory: use small files.' : 'Single-thread build, bundled locally.',
    },
  ];
  return caps;
}
