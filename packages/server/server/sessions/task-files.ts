/**
 * task-files.ts — the BYTES of a task's files. The book holds only the index.
 *
 * Split from the store for two reasons. The book is read on every list and must stay a small JSON;
 * and a write that fails must leave NO row claiming the file exists, which is only expressible if
 * the bytes land first and the record second.
 *
 * Layout: `<data dir>/task-files/<taskId>/<fileId>`. The name the user gave is kept in the record,
 * never on disk — a name from a browser upload is attacker-controlled, and building a path out of
 * one is how `../../.ssh/authorized_keys` gets written. The id is minted here and is the only thing
 * that ever reaches the filesystem.
 */

import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { AGENTISTICS_DATA_DIR } from '../config'

const ROOT = join(AGENTISTICS_DATA_DIR, 'task-files')

/**
 * A file bigger than this is refused rather than stored.
 *
 * The board is for specs, plans and notes — text an assistant wrote. A cap says so out loud, and a
 * store with no cap is one a single mistaken upload fills the disk with.
 */
export const MAX_FILE_BYTES = 8 * 1024 * 1024

/** Ids are minted (`newFileId`) and are the only component that reaches a path. */
function pathFor(taskId: string, fileId: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(taskId) || !/^[A-Za-z0-9_-]+$/.test(fileId)) {
    throw new Error('unsafe id')
  }
  return join(ROOT, taskId, fileId)
}

export async function writeTaskFile(
  taskId: string,
  fileId: string,
  bytes: Uint8Array,
): Promise<number> {
  if (bytes.byteLength > MAX_FILE_BYTES) throw new Error('too_large')
  const target = pathFor(taskId, fileId)
  await mkdir(join(ROOT, taskId), { recursive: true })
  await writeFile(target, bytes)
  const s = await stat(target)
  // The size is READ BACK rather than taken from the buffer: the record must describe what is on
  // disk, or a listing reports a file that is not the one stored.
  return s.size
}

/** Null when the bytes are gone — a record whose file vanished is a fact, not an error. */
export async function readTaskFile(taskId: string, fileId: string): Promise<Uint8Array | null> {
  try {
    return new Uint8Array(await readFile(pathFor(taskId, fileId)))
  } catch {
    return null
  }
}

/** Never throws: a delete whose bytes are already gone has achieved its purpose. */
export async function deleteTaskFile(taskId: string, fileId: string): Promise<void> {
  await rm(pathFor(taskId, fileId), { force: true }).catch(() => undefined)
}

export async function deleteTaskFiles(taskId: string): Promise<void> {
  if (!/^[A-Za-z0-9_-]+$/.test(taskId)) return
  await rm(join(ROOT, taskId), { recursive: true, force: true }).catch(() => undefined)
}
