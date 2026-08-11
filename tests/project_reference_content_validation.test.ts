import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateOfficeArchive } from '../server/project-references/extraction-worker.js';

const fixtures = {
  generic: 'UEsDBBQAAAAIAEFPC12DFtyMAwAAAAEAAAALAAAAcGF5bG9hZC50eHSrAABQSwECFAMUAAAACABBTwtdgxbcjAMAAAABAAAACwAAAAAAAAAAAAAAgAEAAAAAcGF5bG9hZC50eHRQSwUGAAAAAAEAAQA5AAAALAAAAAAA',
  docx: 'UEsDBBQAAAAIAEFPC13HHBc8CgAAAAgAAAATAAAAW0NvbnRlbnRfVHlwZXNdLnhtbLMJqSxILda3AwBQSwMEFAAAAAgAQU8LXYDA89sfAAAAKQAAABEAAAB3b3JkL2RvY3VtZW50LnhtbLMpt0rJTy7NTc0rsbMptyqwy0jNycm30QcxQSRcEgBQSwECFAMUAAAACABBTwtdxxwXPAoAAAAIAAAAEwAAAAAAAAAAAAAAgAEAAAAAW0NvbnRlbnRfVHlwZXNdLnhtbFBLAQIUAxQAAAAIAEFPC12AwPPbHwAAACkAAAARAAAAAAAAAAAAAACAATsAAAB3b3JkL2RvY3VtZW50LnhtbFBLBQYAAAAAAgACAIAAAACJAAAAAAA=',
  xlsx: 'UEsDBBQAAAAIAEFPC13HHBc8CgAAAAgAAAATAAAAW0NvbnRlbnRfVHlwZXNdLnhtbLMJqSxILda3AwBQSwMEFAAAAAgAQU8LXc6emBMNAAAACwAAAA8AAAB4bC93b3JrYm9vay54bWyzKc8vyk7Kz8/WtwMAUEsDBBQAAAAIAEFPC12vzkyyJQAAAC0AAAAYAAAAeGwvd29ya3NoZWV0cy9zaGVldDEueG1ssynPL8ouzkhNLbGzSVYoslVyNFSysymzM7TRL7Oz0U8GYoQKAFBLAQIUAxQAAAAIAEFPC13HHBc8CgAAAAgAAAATAAAAAAAAAAAAAACAAQAAAABbQ29udGVudF9UeXBlc10ueG1sUEsBAhQDFAAAAAgAQU8LXc6emBMNAAAACwAAAA8AAAAAAAAAAAAAAIABOwAAAHhsL3dvcmtib29rLnhtbFBLAQIUAxQAAAAIAEFPC12vzkyyJQAAAC0AAAAYAAAAAAAAAAAAAACAAXUAAAB4bC93b3Jrc2hlZXRzL3NoZWV0MS54bWxQSwUGAAAAAAMAAwDEAAAA0AAAAAAA',
} as const;

const root = await mkdtemp(join(tmpdir(), 'olympus-reference-packages-'));
try {
  const generic = join(root, 'generic.zip');
  const docx = join(root, 'valid.docx');
  const xlsx = join(root, 'valid.xlsx');
  await Promise.all([
    writeFile(generic, Buffer.from(fixtures.generic, 'base64')),
    writeFile(docx, Buffer.from(fixtures.docx, 'base64')),
    writeFile(xlsx, Buffer.from(fixtures.xlsx, 'base64')),
  ]);

  await assert.rejects(validateOfficeArchive(generic, '.docx'), /DOCX package is missing required entries/);
  await assert.rejects(validateOfficeArchive(generic, '.xlsx'), /XLSX package is missing required entries/);
  await validateOfficeArchive(docx, '.docx');
  await validateOfficeArchive(xlsx, '.xlsx');
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log('Project reference Office package validation tests passed');
