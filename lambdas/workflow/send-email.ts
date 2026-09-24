import { postJson } from '../shared/delivery';
import { getSubmission, WorkflowState } from '../shared/submissions';

const MOCK_API_URL = process.env.MOCK_API_URL!;

// Integration adapter for the email provider: sends the confirmation email.
export const handler = async ({ submissionId }: WorkflowState) => {
  const submission = await getSubmission(submissionId);

  const result = await postJson<{ messageId: string }>(
    `${MOCK_API_URL}/email/send`,
    {
      to: submission.data.email,
      subject: 'We received your message',
      text: `Hello ${submission.data.name},\n\nthank you for contacting us. Your reference number is ${submissionId}.`,
    },
    { 'Idempotency-Key': submissionId },
  );

  console.log('Confirmation email sent', { submissionId, messageId: result.messageId });
  return { messageId: result.messageId };
};
