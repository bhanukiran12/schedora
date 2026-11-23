// Private files live on an explicitly configured persistent volume, outside the web root.
// An unfinished upload is never readable through the response download route.
import { createWriteStream, statSync, mkdirSync, realpathSync } from 'node:fs';
import { readFile, rename, unlink } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { execFile, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { fail } from '../http.mjs';
import { inspectImage, ImageError } from './images.mjs';

const execute = promisify(execFile);
export const UPLOAD_MAX_BYTES = 2 * 1024 * 1024;
const EXTENSIONS = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'application/pdf': 'pdf' };
const inside = (root, path) => { const part = relative(root, path); return part === '' || (!part.startsWith('..' + sep) && part !== '..' && !isAbsolute(part)); };

export function createUploadStorage(config, { scan } = {}) {
  const { formUploadDirectory: root, formUploadScanner: scanner, formUploadWorkspaceBytes: workspaceBytes, formUploadStorageBytes: serviceBytes } = config;
  if (!root && !scanner) return null;
  if (!root || !scanner || !isAbsolute(root) || !isAbsolute(scanner)) throw new Error('Form uploads need absolute FORM_UPLOAD_DIRECTORY and FORM_UPLOAD_SCANNER paths.');
  if (config.production && !config.persistentStorageConfirmed) throw new Error('Form uploads need a persistent private volume and PERSISTENT_STORAGE_CONFIRMED=true.');
  if (![workspaceBytes, serviceBytes].every(value => Number.isSafeInteger(value) && value >= UPLOAD_MAX_BYTES) || serviceBytes < workspaceBytes) throw new Error('Set valid form upload workspace and service storage budgets.');
  if (!statSync(scanner).isFile()) throw new Error('FORM_UPLOAD_SCANNER must point to the ClamAV clamscan executable.');
  if (!scan) {
    const version = spawnSync(scanner, ['--version'], { timeout: 5000, maxBuffer: 16384, encoding: 'utf8', windowsHide: true });
    if (version.status !== 0 || !/^ClamAV \d/.test(version.stdout || '')) throw new Error('FORM_UPLOAD_SCANNER must be a working ClamAV clamscan executable.');
  }
  const web = realpathSync(config.frontendDir);
  // Check ancestors before creating a directory, then resolve symlinks and check again.
  const planned = resolve(root);
  if (inside(web, planned) || inside(planned, web)) throw new Error('Form uploads must be outside the frontend directory.');
  mkdirSync(planned, { recursive: true, mode: 0o700 });
  const directory = realpathSync(planned);
  if (inside(web, directory) || inside(directory, web)) throw new Error('Form upload path resolves into the frontend directory.');
  const path = (id, pending = false) => {
    if (!/^[a-f0-9]{32}$/.test(id)) throw new Error('Invalid attachment object key.');
    return join(directory, id + (pending ? '.pending' : '.file'));
  };
  return {
    async receive(id, request, expectedBytes) {
      const declared = request.headers['content-length'];
      if (declared != null && Number(declared) !== expectedBytes) fail(400, 'upload_size', 'The file size changed. Choose the file again.');
      let bytes = 0;
      const bounded = new Transform({
        transform(chunk, encoding, done) {
          bytes += chunk.length;
          done(bytes > expectedBytes || bytes > UPLOAD_MAX_BYTES ? Object.assign(new Error('File too large.'), { code: 'UPLOAD_SIZE' }) : null, chunk);
        }
      });
      const interrupted = () => bounded.destroy(Object.assign(new Error('Upload interrupted.'), { code: 'UPLOAD_SIZE' }));
      request.once('aborted', interrupted);
      try {
        // Do not destroy the HTTP socket on a size failure: the caller still needs its error response.
        request.pipe(bounded);
        await pipeline(bounded, createWriteStream(path(id, true), { flags: 'wx', mode: 0o600 }));
      } finally { request.removeListener('aborted', interrupted); request.unpipe(bounded); request.resume(); }
      if (bytes !== expectedBytes) fail(400, 'upload_size', 'The file was incomplete. Choose it again.');
      let data = await readFile(path(id, true));
      let mime;
      if (/^%PDF-(?:1\.[0-7]|2\.0)/.test(data.toString('latin1', 0, 9))) {
        if (!/%%EOF\s*$/.test(data.toString('latin1', Math.max(0, data.length - 1024)))) fail(400, 'invalid_file', 'This PDF is incomplete.');
        mime = 'application/pdf';
      } else {
        try { ({ data, mime } = inspectImage(data)); }
        catch (error) { if (error instanceof ImageError) fail(400, 'invalid_file', 'Choose a valid JPEG, PNG, WebP or PDF file.'); throw error; }
      }
      // Exit 0 means ClamAV actually scanned the file; infected, unavailable and timed-out scans fail closed.
      try {
        if (scan) await scan(path(id, true));
        else await execute(scanner, ['--no-summary', '--fail-if-cvd-older-than=7', '--', path(id, true)], { timeout: 20000, maxBuffer: 16384, windowsHide: true });
      }
      catch (error) {
        if (error.code === 1) fail(400, 'file_rejected', 'This file did not pass the security scan. Choose another file.');
        fail(503, 'file_scan_unavailable', 'File scanning is unavailable. Your answers are still here; try again later.');
      }
      // Image inspection removes metadata. Write the inspected bytes after scanning the original.
      const { writeFile } = await import('node:fs/promises');
      await writeFile(path(id, true), data, { mode: 0o600 });
      await rename(path(id, true), path(id));
      return { mime, bytes: data.length };
    },
    present(id, bytes) {
      try { return statSync(path(id)).size === Number(bytes); } catch { return false; }
    },
    async read(id) { return readFile(path(id)); },
    async remove(id) {
      for (const pending of [true, false]) {
        try { await unlink(path(id, pending)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
    }
  };
}

export function attachmentFilename(name, mime = null) {
  const safe = String(name || 'attachment').normalize('NFKC').replace(/[\x00-\x1f\x7f/\\<>:"|?*]/g, '_').replace(/^\.+/, '').trim().slice(0, 100) || 'attachment';
  if (!mime) return safe;
  return safe.replace(/\.[^.]*$/, '') + '.' + EXTENSIONS[mime];
}
