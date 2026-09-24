import { postJson } from '../shared/delivery';
import { getSubmission, WorkflowState } from '../shared/submissions';
import type { SubmissionRecord } from '../shared/db';

const MOCK_API_URL = process.env.MOCK_API_URL!;

// Integration adapter: maps our submission to the target system's data model
// and sends it. Everything Salesforce-specific stays in this one file.
export const handler = async ({ submissionId, retryCount = 0 }: WorkflowState) => {
  const submission = await getSubmission(submissionId);

  const result = await postJson<{ id: string }>(`${MOCK_API_URL}/salesforce/cases`, toSalesforceCase(submission), {
    // Step Functions retries this step on failure. If the first attempt
    // actually reached Salesforce but the response got lost, the retry must
    // not create a second case. An idempotency key (or an upsert on an
    // external id field, in real Salesforce) makes retries safe.
    'Idempotency-Key': submissionId,
    // Test-only header: lets the mock fail a set number of attempts
    // (#flaky-salesforce). A real integration would not send this.
    'X-Mock-Retry-Count': String(retryCount),
  });

  console.log('Delivered to Salesforce', { submissionId, caseId: result.id, retryCount });
  return { caseId: result.id };
};

// Mapper: our field names -> Salesforce Case fields.
function toSalesforceCase(submission: SubmissionRecord) {
  return {
    Subject: `[${submission.data.category}] Web form submission`,
    Description: submission.data.message,
    SuppliedName: submission.data.name,
    SuppliedEmail: submission.data.email,
    Type: submission.data.category,
    Origin: 'Web',
    External_Submission_Id__c: submission.submissionId,
  };
}
