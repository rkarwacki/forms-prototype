import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { contactForm } from '../shared/form-definition';
import { getSubmission, WorkflowState } from '../shared/submissions';

const s3 = new S3Client({});
const EVIDENCE_BUCKET = process.env.EVIDENCE_BUCKET!;

// MOCK of Adobe Document Services. The real platform sends the data to Adobe
// and gets back a PDF "Document of Record": a human-readable copy of exactly
// what the user submitted. Here we render simple HTML instead.
export const handler = async ({ submissionId }: WorkflowState) => {
  const submission = await getSubmission(submissionId);

  const rows = contactForm.fields
    .filter((f) => f.type !== 'file')
    .map((f) => `<tr><th>${escapeHtml(f.label)}</th><td>${escapeHtml(submission.data[f.name] ?? '')}</td></tr>`);
  const files = (submission.attachments ?? []).map(
    (a) => `<li>${escapeHtml(a.fileName)} (${a.contentType}, ${a.size} bytes)</li>`,
  );

  const html = `<!doctype html>
<html><head><meta charset="utf-8"><title>Document of Record ${submissionId}</title></head>
<body>
  <h1>${escapeHtml(contactForm.title)} - Document of Record</h1>
  <p>Submission ${submissionId}, received ${submission.createdAt}</p>
  <table>${rows.join('')}</table>
  <h2>Attachments</h2>
  <ul>${files.join('') || '<li>None</li>'}</ul>
</body></html>`;

  const key = `submissions/${submissionId}/document-of-record.html`;
  // S3 computes a SHA-256 checksum on upload. The hash goes into the evidence
  // manifest, so any later change to the document can be detected.
  const result = await s3.send(
    new PutObjectCommand({
      Bucket: EVIDENCE_BUCKET,
      Key: key,
      Body: html,
      ContentType: 'text/html; charset=utf-8',
      ChecksumAlgorithm: 'SHA256',
    }),
  );

  console.log('Document of record generated', { submissionId, key });
  return { key, sha256: result.ChecksumSHA256! };
};

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}
