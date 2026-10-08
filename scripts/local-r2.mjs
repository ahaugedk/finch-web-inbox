import { mkdir, readFile, writeFile, unlink } from 'node:fs/promises';
import path from 'node:path';

// Local-only R2 adapter; files survive preview server restarts.
export function localR2(root) {
  const filename = (key) => { if (!/^[a-f0-9-]+\/[a-f0-9-]+$/.test(key)) throw new Error('Invalid object key'); return path.join(root, key); };
  return {
    async put(key, bytes) { const target = filename(key); await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, Buffer.from(bytes)); return { key }; },
    async get(key) {
      try { const bytes = await readFile(filename(key)); return { size: bytes.length, body: new Blob([bytes]).stream(), arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) }; }
      catch (e) { if (e.code === 'ENOENT') return null; throw e; }
    },
    async delete(key) { try { await unlink(filename(key)); } catch (e) { if (e.code !== 'ENOENT') throw e; } },
  };
}
