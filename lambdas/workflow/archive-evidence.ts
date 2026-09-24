import { CopyObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSubmission, WorkflowState } from '../shared/submissions';

const s3 = new S3Client({});
const ATTACHMENTS_BUCKET = process.env.ATTACHMENTS_BUCKET!;
const EVIDENCE_BUCKET = process.env.EVIDENCE_BUCKET!;

// Collects everything that proves what was submitted into one folder of the
// evidence bucket: the attachments, the document of record (already written
// by the previous step) and a canonical JSON manifest with checksums.
export const handler = async ({ submissionId, documentOfRecord }: WorkflowState) => {
  const submission = await getSubmission(submissionId);
  const prefix = `submissions/${submissionId}`;

  const attachments = [];
  for (const attachment of submission.attachments ?? []) {
    const archivedKey = `${prefix}/attachments/${attachment.fileName}`;
    // Server-side copy: S3 copies bucket to bucket, the file never passes
    // through this Lambda. S3 also computes the checksum while copying.
    const copy = await s3.send(
      new CopyObjectCommand({
        CopySource: `${ATTACHMENTS_BUCKET}/${encodeURI(attachment.key)}`,
        Bucket: EVIDENCE_BUCKET,
        Key: archivedKey,
        ChecksumAlgorithm: 'SHA256',
      }),
    );
    attachments.push({ ...attachment, archivedKey, sha256: copy.CopyObjectResult!.ChecksumSHA256 });
  }

  const manifest = {
    submissionId,
    formId: submission.formId,
    receivedAt: submission.createdAt,
    archivedAt: new Date().toISOString(),
    data: submission.data,
    attachments,
    documentOfRecord,
  };

  await s3.send(
    new PutObjectCommand({
      Bucket: EVIDENCE_BUCKET,
      Key: `${prefix}/submission.json`,
      Body: JSON.stringify(manifest, null, 2),
      ContentType: 'application/json',
      ChecksumAlgorithm: 'SHA256',
    }),
  );

  console.log('Evidence archived', { submissionId, prefix, attachments: attachments.length });
  return { prefix };
};
