import { Duration } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { IFunction } from 'aws-cdk-lib/aws-lambda';
import { ITable } from 'aws-cdk-lib/aws-dynamodb';
import {
  Choice,
  Condition,
  DefinitionBody,
  Fail,
  IChainable,
  JsonPath,
  Parallel,
  StateMachine,
  StateMachineType,
  Succeed,
  TaskInput,
} from 'aws-cdk-lib/aws-stepfunctions';
import { DynamoAttributeValue, DynamoUpdateItem, LambdaInvoke } from 'aws-cdk-lib/aws-stepfunctions-tasks';

export interface SubmissionWorkflowProps {
  submissions: ITable;
  scanAttachmentsFn: IFunction;
  generateDorFn: IFunction;
  archiveEvidenceFn: IFunction;
  deliverSalesforceFn: IFunction;
  sendEmailFn: IFunction;
}

// The "Submission Processing Workflow" box from the diagram, as a Step
// Functions state machine. Roughly an AEM workflow model: each state is a
// step, and the service tracks progress, retries and failures for us.
// After deploying, open it in the Step Functions console to see the graph.
//
//   MarkProcessing -> ScanAttachments -> clean? --no--> MarkRejected -> Rejected
//     -> GenerateDocumentOfRecord -> ArchiveEvidence
//     -> Deliver (in parallel: Salesforce, Email) -> MarkCompleted
//   any step failing (after retries) -> MarkFailed -> ProcessingFailed
export class SubmissionWorkflow extends Construct {
  readonly stateMachine: StateMachine;

  constructor(scope: Construct, id: string, props: SubmissionWorkflowProps) {
    super(scope, id);

    // Status updates call DynamoDB directly from Step Functions, no Lambda
    // needed. Each one sets the status and appends an entry to the history
    // that the browser displays.
    const recordStatus = (stateId: string, status: string, note: string) =>
      new DynamoUpdateItem(this, stateId, {
        table: props.submissions,
        key: { submissionId: DynamoAttributeValue.fromString(JsonPath.stringAt('$.submissionId')) },
        // "status" is a DynamoDB reserved word, hence the #placeholders.
        updateExpression: 'SET #status = :status, updatedAt = :now, #history = list_append(#history, :entry)',
        expressionAttributeNames: { '#status': 'status', '#history': 'history' },
        expressionAttributeValues: {
          ':status': DynamoAttributeValue.fromString(status),
          ':now': DynamoAttributeValue.fromString(JsonPath.stringAt('$$.State.EnteredTime')),
          ':entry': DynamoAttributeValue.fromList([
            DynamoAttributeValue.fromMap({
              status: DynamoAttributeValue.fromString(status),
              at: DynamoAttributeValue.fromString(JsonPath.stringAt('$$.State.EnteredTime')),
              note: DynamoAttributeValue.fromString(note),
            }),
          ]),
        },
        // Keep the workflow state as it was; we don't need DynamoDB's response.
        resultPath: JsonPath.DISCARD,
      });

    // Calls a Lambda and stores its return value in the state under
    // `resultPath` for later steps. The input is the whole workflow state,
    // unless a custom payload is given.
    const invoke = (stateId: string, fn: IFunction, resultPath: string, payload?: TaskInput) =>
      new LambdaInvoke(this, stateId, { lambdaFunction: fn, payloadResponseOnly: true, resultPath, payload });

    // --- Failure handling -------------------------------------------------
    const markFailed = recordStatus(
      'MarkFailed',
      'FAILED',
      JsonPath.format('Processing failed: {}', JsonPath.stringAt('$.error.Error')),
    ).next(new Fail(this, 'ProcessingFailed'));

    const catchErrors = <T extends LambdaInvoke | Parallel>(state: T): T =>
      state.addCatch(markFailed, { resultPath: '$.error' }) as T;

    // --- Steps ----------------------------------------------------------------
    const scanAttachments = catchErrors(invoke('ScanAttachments', props.scanAttachmentsFn, '$.scan'));
    const generateDor = catchErrors(invoke('GenerateDocumentOfRecord', props.generateDorFn, '$.documentOfRecord'));
    const archiveEvidence = catchErrors(invoke('ArchiveEvidence', props.archiveEvidenceFn, '$.archive'));

    // Temporary errors from external systems are retried with exponential
    // backoff: wait 2s, 4s, 8s, then 10s for each further retry (maxDelay),
    // 6 retries in total, about 44s at most. Only then does the Catch above
    // take over. Without maxDelay the waits would keep doubling up to 64s.
    const retryTemporaryErrors = {
      errors: ['ServiceUnavailableError'],
      interval: Duration.seconds(2),
      backoffRate: 2,
      maxDelay: Duration.seconds(10),
      maxAttempts: 6,
    };

    // $$ is the context object: data about the execution itself rather than
    // the workflow state. $$.State.RetryCount is 0 on the first attempt,
    // 1 on the first retry, and so on. Passed on for the #flaky-salesforce test.
    const deliverSalesforce = invoke(
      'DeliverToSalesforce',
      props.deliverSalesforceFn,
      '$.salesforce',
      TaskInput.fromObject({
        submissionId: JsonPath.stringAt('$.submissionId'),
        retryCount: JsonPath.numberAt('$$.State.RetryCount'),
      }),
    );
    deliverSalesforce.addRetry(retryTemporaryErrors);
    const sendEmail = invoke('SendConfirmationEmail', props.sendEmailFn, '$.email');
    sendEmail.addRetry(retryTemporaryErrors);

    // Both deliveries run at the same time. The Parallel state finishes when
    // both branches have finished, and fails if either one fails.
    const deliver = catchErrors(
      new Parallel(this, 'Deliver', { resultPath: JsonPath.DISCARD })
        .branch(
          deliverSalesforce.next(
            recordStatus(
              'MarkSalesforceDelivered',
              'PROCESSING',
              JsonPath.format('Delivered to Salesforce (case {})', JsonPath.stringAt('$.salesforce.caseId')),
            ),
          ),
        )
        .branch(
          sendEmail.next(
            recordStatus(
              'MarkEmailSent',
              'PROCESSING',
              JsonPath.format('Confirmation email sent ({})', JsonPath.stringAt('$.email.messageId')),
            ),
          ),
        ),
    );

    const rejected = recordStatus(
      'MarkRejected',
      'FAILED',
      JsonPath.format('Rejected: {}', JsonPath.stringAt('$.scan.reason')),
    ).next(new Fail(this, 'Rejected'));

    // --- The flow ---------------------------------------------------------
    const definition: IChainable = recordStatus('MarkProcessing', 'PROCESSING', 'Processing started')
      .next(scanAttachments)
      .next(
        new Choice(this, 'AttachmentsClean')
          .when(Condition.booleanEquals('$.scan.clean', false), rejected)
          .otherwise(
            recordStatus('MarkScanned', 'PROCESSING', 'Attachments scanned: clean')
              .next(generateDor)
              .next(recordStatus('MarkDorGenerated', 'PROCESSING', 'Document of record generated'))
              .next(archiveEvidence)
              .next(recordStatus('MarkArchived', 'PROCESSING', 'Evidence archived'))
              .next(deliver)
              .next(recordStatus('MarkCompleted', 'COMPLETED', 'All deliveries done'))
              .next(new Succeed(this, 'Done')),
          ),
      );

    // STANDARD workflows keep a full, visual execution history for 90 days
    // and suit long-running business processes. (EXPRESS workflows are
    // cheaper for high-volume, short jobs, but keep far less history.)
    this.stateMachine = new StateMachine(this, 'StateMachine', {
      definitionBody: DefinitionBody.fromChainable(definition),
      stateMachineType: StateMachineType.STANDARD,
      timeout: Duration.minutes(5),
    });
  }
}
