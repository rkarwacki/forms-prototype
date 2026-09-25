import { SendEmailCommand, SESv2Client, SESv2ServiceException } from '@aws-sdk/client-sesv2';
import { DeliveryRejectedError, ServiceUnavailableError } from '../shared/delivery';
import { getSubmission, WorkflowState } from '../shared/submissions';

const SENDER_EMAIL = process.env.SENDER_EMAIL!;

const ses = new SESv2Client({});

// Integration adapter for the email provider (Amazon SES): sends the
// confirmation email.
//
// Unlike the Salesforce mock, SES has no idempotency key: if a retry follows
// a send that actually went through (e.g. the response was lost), the
// customer gets the email twice. Acceptable for a confirmation email.
export const handler = async ({ submissionId }: WorkflowState) => {
  const submission = await getSubmission(submissionId);

  let messageId: string | undefined;
  try {
    const result = await ses.send(
      new SendEmailCommand({
        FromEmailAddress: SENDER_EMAIL,
        Destination: { ToAddresses: [submission.data.email] },
        Content: {
          Simple: {
            Subject: { Data: 'We received your message' },
            Body: {
              Text: {
                Data: `Hello ${submission.data.name},\n\nthank you for contacting us. Your reference number is ${submissionId}.`,
              },
            },
          },
        },
      }),
    );
    messageId = result.MessageId;
  } catch (err) {
    throw toDeliveryError(err);
  }

  console.log('Confirmation email sent', { submissionId, messageId });
  return { messageId };
};

// Map SES errors onto the two error types the workflow retries on (or not).
// The SDK has already retried throttling and 5xx a few times by itself.
function toDeliveryError(err: unknown): Error {
  if (err instanceof SESv2ServiceException) {
    // Server faults and throttling are temporary.
    if (err.$fault === 'server' || err.name === 'TooManyRequestsException') {
      return new ServiceUnavailableError(`SES: ${err.name}: ${err.message}`);
    }
    // Everything else (unverified address in the SES sandbox, rejected
    // message, sending quota used up, ...) won't be fixed by retrying.
    return new DeliveryRejectedError(`SES: ${err.name}: ${err.message}`);
  }
  // Network errors and timeouts.
  return new ServiceUnavailableError(`SES request failed: ${(err as Error).message}`);
}
