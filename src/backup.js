/**
 * backup.js — the whole library in one file, and back again.
 *
 * The file is a small binary container rather than JSON, because the
 * PDFs are most of it and base64 would add a third to every one:
 *
 *   "MARGIN-BACKUP-1\n"     magic, 16 bytes
 *   uint32 (big-endian)     length of the header in bytes
 *   header                  UTF-8 JSON: { version, created, docs: [...] }
 *   payloads                each document's PDF bytes, then its thumbnail,
 *                           in header order
 *
 * Each docs[] entry is { meta, notes, bytes: length, thumb: length,
 * thumbType }. Both ends work on Blobs, so nothing is ever held in
 * memory twice: packing concatenates by reference, and unpacking
 * slices the file and reads one document at a time.
 */

const MAGIC = 'MARGIN-BACKUP-1\n';
export const BACKUP_TYPE = 'application/x-margin-backup';
export const BACKUP_EXT = '.marginbackup';

/** entries: [{ meta, notes, bytes: ArrayBuffer, thumb: Blob | null }] -> Blob */
export function packBackup(entries, created = Date.now()) {
  const header = {
    version: 1,
    created,
    docs: entries.map((e) => ({
      meta: e.meta,
      notes: e.notes ?? {},
      bytes: e.bytes?.byteLength ?? 0,
      thumb: e.thumb?.size ?? 0,
      thumbType: e.thumb?.type ?? '',
    })),
  };
  const head = new TextEncoder().encode(JSON.stringify(header));
  const len = new DataView(new ArrayBuffer(4));
  len.setUint32(0, head.byteLength);

  const parts = [MAGIC, len.buffer, head];
  for (const e of entries) {
    if (e.bytes?.byteLength) parts.push(e.bytes);
    if (e.thumb?.size) parts.push(e.thumb);
  }
  return new Blob(parts, { type: BACKUP_TYPE });
}

/**
 * Open a backup. Resolves to { created, docs }, where each doc is
 * { meta, notes, bytes(), thumb() } and the two functions read that
 * document's payload on demand. Rejects if the file is not a backup.
 */
export async function readBackup(blob) {
  const start = MAGIC.length + 4;
  const lead = new Uint8Array(await blob.slice(0, start).arrayBuffer());
  if (lead.length < start || new TextDecoder().decode(lead.subarray(0, MAGIC.length)) !== MAGIC) {
    throw new Error('not a Margin backup');
  }
  const headLen = new DataView(lead.buffer).getUint32(MAGIC.length);
  if (start + headLen > blob.size) throw new Error('backup is cut short');

  let header;
  try {
    header = JSON.parse(new TextDecoder().decode(await blob.slice(start, start + headLen).arrayBuffer()));
  } catch {
    throw new Error('backup header is unreadable');
  }
  if (header.version !== 1 || !Array.isArray(header.docs)) throw new Error('backup is from a newer version');

  let at = start + headLen;
  const docs = header.docs.map((d) => {
    const b0 = at, t0 = at + d.bytes;
    at = t0 + d.thumb;
    return {
      meta: d.meta,
      notes: d.notes,
      bytes: () => blob.slice(b0, t0).arrayBuffer(),
      thumb: () => (d.thumb ? blob.slice(t0, t0 + d.thumb, d.thumbType) : null),
    };
  });
  if (at !== blob.size) throw new Error('backup is cut short');
  return { created: header.created, docs };
}
