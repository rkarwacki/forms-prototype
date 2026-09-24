import { createHash } from 'crypto';
import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { json } from '../shared/http';

const FAILURE_RATE = Number(process.env.FAILURE_RATE ?? '0');

// MOCK of the external systems (Salesforce, email provider). Deployed behind
// its own API, separate from the forms API, so it behaves like a third-party
// service: our workflow reaches it over HTTP just as it would the real thing.
//
// Salesforce is deliberately unreliable, to show Step Functions retries:
// - fails randomly with 503 at FAILURE_RATE
// - always fails if the message contains "#fail-salesforce"
// - fails the first 2 attempts, then succeeds, if the message contains
//   "#flaky-salesforce" (reads the attempt from a test-only header)
const FLAKY_FAILED_ATTEMPTS = 2;

export const handler = async (event: APIGatewayProxyEventV2) => {
  const body = JSON.parse(event.body ?? '{}');
  const idempotencyKey = event.headers['idempotency-key'] ?? '';

  // Pretend to be a slow remote system.
  await new Promise((resolve) => setTimeout(resolve, 300 + Math.random() * 1200));

  switch (event.routeKey) {
    case 'POST /salesforce/cases': {
      const description = String(body.Description);
      const retryCount = Number(event.headers['x-mock-retry-count'] ?? '0');

      if (description.includes('#flaky-salesforce')) {
        // Deterministic: skips the random failures entirely.
        if (retryCount < FLAKY_FAILED_ATTEMPTS) {
          console.log('Salesforce mock: simulating flaky outage', { idempotencyKey, retryCount });
          return json(503, { error: 'Service temporarily unavailable' });
        }
      } else if (description.includes('#fail-salesforce') || Math.random() < FAILURE_RATE) {
        console.log('Salesforce mock: simulating outage', { idempotencyKey, retryCount });
        return json(503, { error: 'Service temporarily unavailable' });
      }
      // Same idempotency key -> same case id, so retries don't create
      // duplicates. (A real service would store the key.)
      const caseId = '500' + hash(idempotencyKey).slice(0, 12).toUpperCase();
      console.log('Salesforce mock: case created', { caseId, case: body });
      return json(201, { id: caseId, success: true });
    }

    case 'POST /email/send': {
      const messageId = `msg-${hash(idempotencyKey).slice(0, 16)}`;
      console.log('Email mock: email accepted', { messageId, email: body });
      return json(202, { messageId });
    }

    default:
      return json(404, { error: `No mock for ${event.routeKey}` });
  }
};

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
