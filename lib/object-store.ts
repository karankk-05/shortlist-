import { InputError } from './records';

const CHUNK_SIZE = 512 * 1024;
const MAX_SIZE = 10 * 1024 * 1024;

/** Private small-file storage on D1. Objects are immutable and addressed by UUID. */
export function objectStore(db: D1Database) {
  return {
    async put(key: string, value: string | ArrayBuffer, _options?: unknown) {
      const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : new Uint8Array(value);
      if (bytes.length > MAX_SIZE) throw new InputError('Stored files must be at most 10 MB.', 413);
      const chunks = Math.ceil(bytes.length / CHUNK_SIZE);
      const statements = [db.prepare('INSERT INTO objects (key, size, chunks) VALUES (?, ?, ?)').bind(key, bytes.length, chunks)];
      for (let index = 0; index < chunks; index++) {
        statements.push(db.prepare('INSERT INTO object_chunks (object_key, chunk_index, bytes) VALUES (?, ?, ?)')
          .bind(key, index, bytes.slice(index * CHUNK_SIZE, (index + 1) * CHUNK_SIZE).buffer));
      }
      await db.batch(statements);
    },
    async get(key: string) {
      const metadata = await db.prepare('SELECT size, chunks FROM objects WHERE key = ?').bind(key).first<{ size: number; chunks: number }>();
      if (!metadata) return null;
      let index = 0;
      const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
          if (index === metadata.chunks) { controller.close(); return; }
          try {
            // Stream one chunk at a time, avoiding a large array-of-numbers allocation.
            const chunk = await db.prepare('SELECT bytes FROM object_chunks WHERE object_key = ? AND chunk_index = ?')
              .bind(key, index++).first<{ bytes: number[] | ArrayBuffer }>();
            if (!chunk) throw new Error('Stored object is incomplete');
            controller.enqueue(new Uint8Array(chunk.bytes));
          } catch (error) { controller.error(error); }
        },
      });
      return { body, json: <T>() => new Response(body).json<T>() };
    },
    async delete(key: string) {
      await db.prepare('DELETE FROM objects WHERE key = ?').bind(key).run();
    },
  };
}
