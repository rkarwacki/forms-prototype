# Forms Prototype

A learning prototype of the AWS core of a forms platform: a form UI that
submits to API Gateway + Lambda, with direct-to-S3 attachment uploads and an
asynchronous Step Functions workflow that scans, archives and delivers each
submission to (mocked) external systems.

AEM, CloudFront/WAF, analytics and Adobe cloud services are intentionally out
of scope; Adobe Document Services, GuardDuty malware scanning, Salesforce and
the email provider are replaced by mocks.

## Architecture

```
Browser (web/)                          AWS (infra/, one CDK stack)
  GET  /config       ─────────────────► ConfigFn      form definition + dropdowns
  POST /uploads      ─────────────────► UploadUrlFn   presigned S3 POST
  POST <S3>          ─────────────────► Attachments bucket
  POST /submit       ─────────────────► SubmitFn      validate, store, start workflow
  GET  /status/{id}  ─────────────────► StatusFn      poll processing status
                                              │
                                              ▼
                          Step Functions: SubmissionWorkflow
                          scan attachments ─► generate document of record
                          ─► archive evidence ─► deliver in parallel
                             (Salesforce, email, with retries) ─► completed
                                              │ HTTP
                                              ▼
                          Mock external API (separate API Gateway)
```

| Path | Contents |
|---|---|
| `infra/` | CDK app: `forms-stack.ts` (all resources), `submission-workflow.ts` (state machine) |
| `lambdas/` | API handlers |
| `lambdas/workflow/` | Workflow steps and integration adapters |
| `lambdas/mocks/` | Mock Salesforce and email provider |
| `lambdas/shared/` | Form definition and validation, DynamoDB and HTTP helpers |
| `web/` | Plain HTML/JS form, no build step |

## Prerequisites

- Node.js 22+ (20 works for now, with an AWS SDK deprecation warning)
- AWS CLI v2, signed in to an account (`aws login` or `aws sso login`)
- One-time per account and region: `npx cdk bootstrap`

## Usage

```bash
npm install
npm run deploy     # deploys to eu-central-1, writes web/cdk-outputs.json
npm run web        # serves the form on http://localhost:8080
npm run destroy    # removes everything, including stored data
```

`npm run typecheck` checks the TypeScript; `npx cdk diff` shows what a deploy
would change, including IAM changes.

## Testing failure paths

| Input | Result |
|---|---|
| `#fail-salesforce` in the message | Salesforce always returns 503; retries exhausted, status FAILED |
| `#flaky-salesforce` in the message | Salesforce fails twice, succeeds on the third attempt |
| Attachment name containing `eicar` | Simulated malware, submission rejected |
| Non-PDF file renamed to `.pdf` | Content doesn't match type, submission rejected |

Besides these, the Salesforce mock fails at random at the rate set by
`FAILURE_RATE` in `infra/forms-stack.ts`.

## Prototype shortcuts

Not production-ready by design: CORS allows any origin, APIs have no auth or
WAF, buckets and the table are deleted with the stack, and the evidence
bucket has no Object Lock.
