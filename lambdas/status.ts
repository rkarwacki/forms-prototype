import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { GetCommand } from '@aws-sdk/lib-dynamodb';
import { json } from './shared/http';
import { db, TABLE_NAME, SubmissionRecord } from './shared/db';

// GET /status/{id} — processing status for the browser to poll.
export const handler = async (event: APIGatewayProxyEventV2) => {
  const submissionId = event.pathParameters?.id;
  if (!submissionId) return json(400, { error: 'Missing submission id' });

  const result = await db.send(new GetCommand({ TableName: TABLE_NAME, Key: { submissionId } }));
  const record = result.Item as SubmissionRecord | undefined;
  if (!record) return json(404, { error: 'Submission not found' });

  // Return status info only, not the submitted data.
  return json(200, {
    submissionId: record.submissionId,
    status: record.status,
    updatedAt: record.updatedAt,
    history: record.history,
  });
};
