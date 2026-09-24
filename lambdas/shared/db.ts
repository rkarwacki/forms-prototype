import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

// Created once per Lambda container, outside the handler, so warm
// invocations reuse the connection instead of creating a new client.
export const db = DynamoDBDocumentClient.from(new DynamoDBClient({}));

// Injected by CDK as an environment variable (see forms-stack.ts).
export const TABLE_NAME = process.env.TABLE_NAME!;

export type SubmissionStatus = 'RECEIVED' | 'PROCESSING' | 'COMPLETED' | 'FAILED';

export interface AttachmentRef {
  field: string;
  key: string;
  fileName: string;
  contentType: string;
  size: number;
}

export interface SubmissionRecord {
  submissionId: string;
  formId: string;
  status: SubmissionStatus;
  createdAt: string;
  updatedAt: string;
  data: Record<string, string>;
  attachments: AttachmentRef[];
  history: { status: SubmissionStatus; at: string; note?: string }[];
}
