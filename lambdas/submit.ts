import { randomUUID } from 'crypto';
import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { PutCommand } from '@aws-sdk/lib-dynamodb';
import { HeadObjectCommand, NotFound, S3Client } from '@aws-sdk/client-s3';
import { SFNClient, StartExecutionCommand } from '@aws-sdk/client-sfn';
import { contactForm, validate } from './shared/form-definition';
import { json } from './shared/http';
import { db, TABLE_NAME, AttachmentRef, SubmissionRecord } from './shared/db';

const s3 = new S3Client({});
const BUCKET_NAME = process.env.ATTACHMENTS_BUCKET!;
const sfn = new SFNClient({});
const STATE_MACHINE_ARN = process.env.STATE_MACHINE_ARN!;

// POST /submit — validate, store, start the processing workflow, acknowledge.
// The workflow runs asynchronously, so the user gets a fast response with an
// id they can use to poll /status/{id}.
export const handler = async (event: APIGatewayProxyEventV2) => {
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(event.body ?? '{}');
  } catch {
    return json(400, { error: 'Body must be valid JSON' });
  }

  // Never trust the browser: validate again on the server.
  const errors = validate(contactForm, data);

  // File fields carry the S3 key of an earlier upload. Check the object
  // really exists, and read its size and type from S3 rather than the browser.
  const attachments: AttachmentRef[] = [];
  for (const field of contactForm.fields.filter((f) => f.type === 'file')) {
    const key = typeof data[field.name] === 'string' ? (data[field.name] as string).trim() : '';
    if (!key || errors[field.name]) continue;

    try {
      const head = await s3.send(new HeadObjectCommand({ Bucket: BUCKET_NAME, Key: key }));
      attachments.push({
        field: field.name,
        key,
        fileName: key.split('/').pop()!,
        contentType: head.ContentType ?? 'application/octet-stream',
        size: head.ContentLength ?? 0,
      });
    } catch (err) {
      if (!(err instanceof NotFound)) throw err;
      errors[field.name] = 'Uploaded file not found, please upload it again';
    }
  }

  if (Object.keys(errors).length > 0) {
    console.log('Validation failed', { fields: Object.keys(errors) });
    return json(400, { error: 'Validation failed', fields: errors });
  }

  const now = new Date().toISOString();
  const record: SubmissionRecord = {
    submissionId: randomUUID(),
    formId: contactForm.id,
    status: 'RECEIVED',
    createdAt: now,
    updatedAt: now,
    data: Object.fromEntries(
      contactForm.fields
        .filter((f) => f.type !== 'file')
        .map((f) => [f.name, typeof data[f.name] === 'string' ? (data[f.name] as string).trim() : '']),
    ),
    attachments,
    history: [{ status: 'RECEIVED', at: now }],
  };

  await db.send(new PutCommand({ TableName: TABLE_NAME, Item: record }));

  // Only the id goes into the workflow; each step loads the data itself.
  // The execution name must be unique, so using the submission id also
  // guarantees one workflow per submission.
  await sfn.send(
    new StartExecutionCommand({
      stateMachineArn: STATE_MACHINE_ARN,
      name: record.submissionId,
      input: JSON.stringify({ submissionId: record.submissionId }),
    }),
  );

  // Log the id only, never the form payload (personal data).
  console.log('Submission stored', { submissionId: record.submissionId, attachments: attachments.length });

  return json(202, { submissionId: record.submissionId, status: record.status });
};
