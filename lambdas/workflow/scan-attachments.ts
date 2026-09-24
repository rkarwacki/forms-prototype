import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSubmission, WorkflowState } from '../shared/submissions';

const s3 = new S3Client({});
const ATTACHMENTS_BUCKET = process.env.ATTACHMENTS_BUCKET!;

// First bytes ("magic numbers") every file of the declared type starts with.
const SIGNATURES: Record<string, number[]> = {
  'application/pdf': [0x25, 0x50, 0x44, 0x46], // %PDF
  'image/png': [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
  'image/jpeg': [0xff, 0xd8, 0xff],
};

// MOCK of malware scanning. The real platform uses GuardDuty Malware
// Protection for S3, which scans each upload and tags the object with the
// result. Here we do two cheap checks instead:
// - the file content matches its declared type (a renamed .exe fails this)
// - a file name containing "eicar" counts as infected, to test the reject path
export const handler = async ({ submissionId }: WorkflowState) => {
  const submission = await getSubmission(submissionId);

  for (const attachment of submission.attachments ?? []) {
    if (attachment.fileName.toLowerCase().includes('eicar')) {
      return { clean: false, reason: `${attachment.fileName} contains malware (simulated)` };
    }

    // Fetch only the first 8 bytes, not the whole file.
    const object = await s3.send(
      new GetObjectCommand({ Bucket: ATTACHMENTS_BUCKET, Key: attachment.key, Range: 'bytes=0-7' }),
    );
    const head = await object.Body!.transformToByteArray();
    const signature = SIGNATURES[attachment.contentType] ?? [];
    if (!signature.every((byte, i) => head[i] === byte)) {
      return { clean: false, reason: `${attachment.fileName} content does not match ${attachment.contentType}` };
    }
  }

  console.log('Attachments clean', { submissionId, count: submission.attachments?.length ?? 0 });
  return { clean: true };
};
