import { GetCommand } from '@aws-sdk/lib-dynamodb';
import { db, TABLE_NAME, SubmissionRecord } from './db';

// Workflow steps receive only the submission id and load the data themselves.
// This keeps personal data out of the Step Functions execution history,
// which anyone with console access to the workflow can read.
export async function getSubmission(submissionId: string): Promise<SubmissionRecord> {
  const result = await db.send(new GetCommand({ TableName: TABLE_NAME, Key: { submissionId } }));
  if (!result.Item) throw new Error(`Submission ${submissionId} not found`);
  return result.Item as SubmissionRecord;
}

// Input every workflow Lambda receives: the workflow state so far.
export interface WorkflowState {
  submissionId: string;
  retryCount?: number;
  documentOfRecord?: { key: string; sha256: string };
}
