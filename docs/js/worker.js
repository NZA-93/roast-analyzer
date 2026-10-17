import { analyzeImage } from './analyzer.js';
self.onmessage = (e) => {
  const { id, width, height, buffer, opts } = e.data;
  try {
    const r = analyzeImage({ width, height, data: new Uint8ClampedArray(buffer) }, opts || {});
    self.postMessage({ id, ok: true, result: r }, [r.labelMap.buffer]);
  } catch (err) { self.postMessage({ id, ok: false, error: String(err.message || err) }); }
};
