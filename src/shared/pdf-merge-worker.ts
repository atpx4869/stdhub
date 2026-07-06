// PDF synthesis worker (worker_threads entry).
//
// pdf-lib's embedJpg / addPage / drawImage / save are CPU-bound JS that block
// the main event loop for ~0.5-3s on bigger standards. With multiple users
// hitting the in-process server, those blocks cascade into latency on every
// other API. Offloading to a worker thread keeps the main loop responsive.
//
// Protocol: host posts { id, jpegBuffers: ArrayBuffer[], outputPath }.
// Worker streams { id, type: 'progress', current, total } and finishes with
// either { id, type: 'done' } or { id, type: 'error', message }.
// Workers stay alive and process jobs sequentially — pooling is the host's job.

import { parentPort } from 'node:worker_threads';
import { writeFile } from 'node:fs/promises';

if (!parentPort) {
  throw new Error('pdf-merge-worker must be loaded as a worker_threads entry');
}

interface JobMessage {
  id: string;
  jpegBuffers: ArrayBuffer[];
  outputPath: string;
}

parentPort.on('message', async (msg: JobMessage) => {
  const { id, jpegBuffers, outputPath } = msg;
  try {
    const { PDFDocument } = await import('pdf-lib');
    const pdfDoc = await PDFDocument.create();

    const buffers = jpegBuffers.map((ab) => new Uint8Array(ab));
    const images = await Promise.all(buffers.map((b) => pdfDoc.embedJpg(b)));

    const total = images.length;
    for (let idx = 0; idx < total; idx += 1) {
      const image = images[idx];
      const page = pdfDoc.addPage([image.width, image.height]);
      page.drawImage(image, { x: 0, y: 0, width: image.width, height: image.height });
      parentPort!.postMessage({ id, type: 'progress', current: idx + 1, total });
    }

    const bytes = await pdfDoc.save();
    await writeFile(outputPath, bytes);
    parentPort!.postMessage({ id, type: 'done', totalPages: total });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    parentPort!.postMessage({ id, type: 'error', message });
  }
});
