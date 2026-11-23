import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { createUploadStorage } from '../src/forms/upload-storage.mjs';

const root = await mkdtemp(join(tmpdir(), 'schedora-scanner-check-'));
try {
  const storage = createUploadStorage({
    formUploadDirectory: root,
    formUploadScanner: process.env.FORM_UPLOAD_SCANNER || '/usr/bin/clamscan',
    formUploadWorkspaceBytes: 10 * 1024 * 1024,
    formUploadStorageBytes: 100 * 1024 * 1024,
    frontendDir: '/app/frontend', production: false
  });
  const clean = Buffer.from('%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\n%%EOF\n');
  const standardTest = Buffer.from('WDVPIVAlQEFQWzRcUFpYNTQoUF4pN0NDKTd9JEVJQ0FSLVNUQU5EQVJELUFOVElWSVJVUy1URVNULUZJTEUhJEgrSCo=', 'base64');
  const rejected = Buffer.concat([Buffer.from('%PDF-1.4\n'), standardTest, Buffer.from('\n%%EOF\n')]);
  const receive = (id, bytes) => {
    const request = Readable.from([bytes]);
    request.headers = { 'content-length': String(bytes.length) };
    return storage.receive(id, request, bytes.length);
  };
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R /Names << /EmbeddedFiles << /Names [(eicar.txt) 3 0 R] >> >> >>',
    '<< /Type /Pages /Count 0 /Kids [] >>',
    '<< /Type /Filespec /F (eicar.txt) /EF << /F 4 0 R >> >>',
    '<< /Type /EmbeddedFile /Length ' + standardTest.length + ' >>\nstream\n' + standardTest.toString() + '\nendstream'
  ];
  let document = '%PDF-1.4\n';
  const offsets = [];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(document));
    document += (index + 1) + ' 0 obj\n' + object + '\nendobj\n';
  });
  const xref = Buffer.byteLength(document);
  document += 'xref\n0 5\n0000000000 65535 f \n' +
    offsets.map(offset => String(offset).padStart(10, '0') + ' 00000 n \n').join('') +
    'trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n' + xref + '\n%%EOF\n';
  const testPdf = Buffer.from(document);
  const cleanId = '1'.repeat(32);
  assert.equal((await receive(cleanId, clean)).mime, 'application/pdf');
  assert.equal(storage.present(cleanId, clean.length), true);
  await assert.rejects(receive('2'.repeat(32), testPdf), error => error.code === 'file_rejected');
  await storage.remove(cleanId);
  await storage.remove('2'.repeat(32));
  assert.equal(storage.present(cleanId, clean.length), false);
  console.log('Real ClamAV accepted a clean PDF, rejected the standard antivirus test PDF, and removed both files.');
} finally {
  await rm(root, { recursive: true, force: true });
}
