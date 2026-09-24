// HTTP helper for calling external systems from workflow steps.
//
// Errors are split into two kinds, identified by `name`. Step Functions sees
// the name as the error type and decides from it whether to retry:
// - ServiceUnavailableError: temporary (5xx, 429, timeout), retried with backoff
// - DeliveryRejectedError: the target refused the data (4xx), retrying won't help

export class ServiceUnavailableError extends Error {
  name = 'ServiceUnavailableError';
}

export class DeliveryRejectedError extends Error {
  name = 'DeliveryRejectedError';
}

export async function postJson<T>(url: string, body: unknown, headers: Record<string, string> = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    });
  } catch (err) {
    throw new ServiceUnavailableError(`Request to ${url} failed: ${(err as Error).message}`);
  }

  if (response.status >= 500 || response.status === 429) {
    throw new ServiceUnavailableError(`${url} responded ${response.status}`);
  }
  if (!response.ok) {
    throw new DeliveryRejectedError(`${url} responded ${response.status}: ${await response.text()}`);
  }
  return (await response.json()) as T;
}
