import { randomUUID } from 'crypto';
import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { S3Client } from '@aws-sdk/client-s3';
import { createPresignedPost } from '@aws-sdk/s3-presigned-post';
import { contactForm, findField } from './shared/form-definition';
import { json } from './shared/http';

const s3 = new S3Client({});
const BUCKET_NAME = process.env.ATTACHMENTS_BUCKET!;
const URL_TTL_SECONDS = 300;

// POST /uploads — body: { field, fileName, contentType, size }
//
// Returns a presigned POST: a URL plus form fields signed with this Lambda's
// credentials. The browser sends the file straight to S3 with them, so the
// file never passes through API Gateway or Lambda (which have payload limits
// and would cost time and money). The signed policy makes S3 itself enforce
// the key, content type and maximum size, whatever the browser claims here.
export const handler = async (event: APIGatewayProxyEventV2) => {
  let request: { field?: string; fileName?: string; contentType?: string; size?: number };
  try {
    request = JSON.parse(event.body ?? '{}');
  } catch {
    return json(400, { error: 'Body must be valid JSON' });
  }

  const field = findField(contactForm, request.field ?? '');
  if (!field || field.type !== 'file') return json(400, { error: 'Unknown file field' });

  const { fileName, contentType, size } = request;
  if (!fileName || !contentType || typeof size !== 'number') {
    return json(400, { error: 'fileName, contentType and size are required' });
  }
  if (!field.accept!.includes(contentType)) {
    return json(400, { error: `File type ${contentType} is not allowed` });
  }
  if (size <= 0 || size > field.maxSizeBytes!) {
    return json(400, { error: `File must be at most ${field.maxSizeBytes! / 1024 / 1024} MB` });
  }

  // Never use the browser's file name as-is in the key: strip anything
  // that isn't a safe character and prefix a random id to avoid collisions.
  const safeName = fileName.replace(/[^A-Za-z0-9._-]/g, '_').slice(-100);
  const key = `uploads/${randomUUID()}/${safeName}`;

  const { url, fields } = await createPresignedPost(s3, {
    Bucket: BUCKET_NAME,
    Key: key,
    Expires: URL_TTL_SECONDS,
    Fields: { 'Content-Type': contentType },
    Conditions: [
      ['content-length-range', 1, field.maxSizeBytes!],
      ['eq', '$Content-Type', contentType],
    ],
  });

  console.log('Issued upload URL', { key, contentType, size });
  return json(200, { key, url, fields });
};
