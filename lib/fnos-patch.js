/**
 * fnOS compatibility patch for a shipped DSH package.
 *
 * `@deepseek-ai/dsh-attachment-local` makes an attachment durable by fsyncing
 * every ancestor directory of its staging directory up to `/`. On fnOS the
 * `/vol1` and `/vol2` mount roots are mode 000 with trimacl ACLs: the app can
 * read its own descendants but cannot `open()` those roots at all, so the first
 * image save dies with `EACCES ... open '/vol2'`. The browser only sees
 * `prompt rejected (session/agent-busy)` because the session controller folds
 * every non-Remote error into that code — text messages keep working, images
 * never do.
 *
 * The patch wraps that directory fsync so an unreadable ancestor is skipped
 * (durability is crash hardening, not correctness). It is idempotent, marked in
 * the file, and reapplied after every core update because a core install
 * replaces the package wholesale.
 */

import { readFile, rename, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'

const MARKER = 'fnOS patch: attachment-local'

const ORIGINAL = `async function syncDirectory(path) {
	/* v8 ignore next -- Windows cannot open directory handles; NTFS metadata journaling owns entry durability there. */
	if (process.platform === "win32") return;
	/* v8 ignore start -- Windows cannot exercise directory fsync; POSIX behavior tests enforce this peer. */
	const handle = await open(path, constants.O_RDONLY);
	try {
		await handle.sync();
	} finally {
		await handle.close();
	}
	/* v8 ignore stop */
}`

const PATCHED = `async function syncDirectory(path) {
	/* v8 ignore next -- Windows cannot open directory handles; NTFS metadata journaling owns entry durability there. */
	if (process.platform === "win32") return;
	/* ${MARKER}: /vol1 and /vol2 are mode 000 with trimacl ACLs, so an ancestor
	 * directory can be unopenable while every descendant is writable. Directory
	 * fsync is crash-durability hardening, not correctness: skip levels this
	 * process may not read instead of failing the whole attachment save. */
	let handle;
	try {
		handle = await open(path, constants.O_RDONLY);
	} catch (error) {
		if (error?.code === "EACCES" || error?.code === "EPERM" || error?.code === "EBADF" || error?.code === "ENOENT") return;
		throw error;
	}
	try {
		await handle.sync();
	} catch (error) {
		if (!["EACCES", "EPERM", "EBADF", "EINVAL", "ENOTSUP", "EOPNOTSUPP"].includes(error?.code)) throw error;
	} finally {
		await handle.close().catch(() => {});
	}
}`

/** Candidate paths of the shipped attachment-local entry, most specific first. */
function candidateFiles() {
  const prefix = process.env.NPM_CONFIG_PREFIX
  const home = process.env.DSH_HOME
  const roots = []
  if (typeof prefix === 'string' && prefix !== '') {
    roots.push(join(prefix, 'lib', 'node_modules', '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai'))
    roots.push(join(prefix, 'lib', 'node_modules', '@deepseek-ai'))
  }
  if (typeof home === 'string' && home !== '') {
    roots.push(join(home, '.npm-global', 'lib', 'node_modules', '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai'))
  }
  return roots.map((root) => join(root, 'dsh-attachment-local', 'lib', 'index.js'))
}

/**
 * Apply the attachment durability patch to the installed core package.
 * @returns {{ status: 'patched'|'already'|'missing'|'unexpected', file?: string, error?: string }}
 */
export async function ensureAttachmentPatch() {
  let found = null
  for (const file of candidateFiles()) {
    if (existsSync(file)) { found = file; break }
  }
  if (found === null) return { status: 'missing', error: 'dsh-attachment-local not found next to the running dsh install' }
  try {
    const source = await readFile(found, 'utf8')
    if (source.includes(MARKER)) return { status: 'already', file: found }
    if (!source.includes(ORIGINAL)) return { status: 'unexpected', file: found, error: 'syncDirectory body changed — re-check the patch' }
    const temporary = `${found}.fnos-${process.pid}.tmp`
    await writeFile(temporary, source.replace(ORIGINAL, PATCHED), 'utf8')
    await rename(temporary, found)
    return { status: 'patched', file: found }
  } catch (error) {
    return { status: 'unexpected', file: found, error: error instanceof Error ? error.message : String(error) }
  }
}

/** Directory the patch touches; exposed for diagnostics. */
export function attachmentPackageDir(file) {
  return file === undefined ? null : dirname(dirname(file))
}
