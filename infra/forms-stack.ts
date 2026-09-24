import * as path from 'path';
import { CfnOutput, Duration, RemovalPolicy, Stack, StackProps } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { Runtime } from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
import { AttributeType, BillingMode, Table } from 'aws-cdk-lib/aws-dynamodb';
import { BlockPublicAccess, Bucket, BucketEncryption, HttpMethods } from 'aws-cdk-lib/aws-s3';
import { CorsHttpMethod, HttpApi, HttpMethod } from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import { SubmissionWorkflow } from './submission-workflow';

// A stack is one deployable unit: everything in it is created, updated
// and deleted together (`cdk deploy` / `cdk destroy`).
export class FormsStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    // --- Submission status table ------------------------------------------
    // DynamoDB is a key-value store: every item is looked up by its key
    // (submissionId). Pay-per-request means no capacity planning, and it
    // costs nothing while idle.
    const submissions = new Table(this, 'Submissions', {
      partitionKey: { name: 'submissionId', type: AttributeType.STRING },
      billingMode: BillingMode.PAY_PER_REQUEST,
      removalPolicy: RemovalPolicy.DESTROY, // prototype: delete data with the stack
    });

    // --- Attachment store -------------------------------------------------
    // Private bucket: nobody can read or write it except through IAM
    // permissions or a presigned URL/POST issued by our Lambda.
    const attachments = new Bucket(this, 'Attachments', {
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      encryption: BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      // The browser uploads directly to S3 from another origin, so S3 needs
      // its own CORS rules (API Gateway's CORS settings don't apply here).
      cors: [{ allowedOrigins: ['*'], allowedMethods: [HttpMethods.POST], allowedHeaders: ['*'] }],
      // Uploads never followed by a submit would pile up; clean them up.
      lifecycleRules: [{ prefix: 'uploads/', expiration: Duration.days(7) }],
      // Prototype: empty and delete the bucket on `cdk destroy`. CDK adds a
      // small helper Lambda (a "custom resource") that does the emptying.
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    // --- Submission evidence archive ------------------------------------------
    // Document of record, attachments and a manifest per submission.
    // Versioned, so an overwritten or deleted file can still be recovered.
    // The real platform adds S3 Object Lock (files can't be changed or deleted
    // until a retention date, not even by admins) and moves old data to
    // Glacier. Object Lock is left out here: it can't be switched off again,
    // and it would stop `cdk destroy` from deleting the bucket.
    const evidence = new Bucket(this, 'EvidenceArchive', {
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      encryption: BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      versioned: true,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    // --- Lambdas ----------------------------------------------------------
    // NodejsFunction bundles a TypeScript file with esbuild into a small zip.
    // Each function gets its own IAM role, and only the grants below.
    const createFunction = (name: string, file: string, extraEnvironment: Record<string, string> = {}) =>
      new NodejsFunction(this, name, {
        entry: path.join(__dirname, '../lambdas', file),
        handler: 'handler',
        runtime: Runtime.NODEJS_22_X,
        memorySize: 256,
        timeout: Duration.seconds(10),
        environment: {
          TABLE_NAME: submissions.tableName,
          ATTACHMENTS_BUCKET: attachments.bucketName,
          EVIDENCE_BUCKET: evidence.bucketName,
          ...extraEnvironment,
        },
        // Bundle the AWS SDK into the zip instead of relying on the copy in
        // the Lambda runtime: pinned versions, and packages the runtime
        // doesn't ship (like s3-presigned-post) just work.
        bundling: { externalModules: [] },
        // Where console.log output goes. Deleted together with the stack.
        logGroup: new LogGroup(this, `${name}Logs`, {
          retention: RetentionDays.ONE_WEEK,
          removalPolicy: RemovalPolicy.DESTROY,
        }),
      });

    const configFn = createFunction('ConfigFn', 'config.ts');
    const submitFn = createFunction('SubmitFn', 'submit.ts');
    const statusFn = createFunction('StatusFn', 'status.ts');
    const uploadUrlFn = createFunction('UploadUrlFn', 'upload-url.ts');

    // --- Mock external systems ----------------------------------------------
    // Its own API, so our code reaches it over HTTP like a real third party.
    const mockExternalFn = createFunction('MockExternalFn', 'mocks/external-systems.ts', {
      FAILURE_RATE: '0.5', // Salesforce mock fails 50% of calls
    });
    const mockApi = new HttpApi(this, 'MockExternalApi');
    mockApi.addRoutes({
      path: '/salesforce/cases',
      methods: [HttpMethod.POST],
      integration: new HttpLambdaIntegration('MockSalesforceIntegration', mockExternalFn),
    });
    mockApi.addRoutes({
      path: '/email/send',
      methods: [HttpMethod.POST],
      integration: new HttpLambdaIntegration('MockEmailIntegration', mockExternalFn),
    });

    // --- Workflow step Lambdas ------------------------------------------------
    const scanAttachmentsFn = createFunction('ScanAttachmentsFn', 'workflow/scan-attachments.ts');
    const generateDorFn = createFunction('GenerateDorFn', 'workflow/generate-dor.ts');
    const archiveEvidenceFn = createFunction('ArchiveEvidenceFn', 'workflow/archive-evidence.ts');
    const deliverSalesforceFn = createFunction('DeliverSalesforceFn', 'workflow/deliver-salesforce.ts', {
      MOCK_API_URL: mockApi.apiEndpoint,
    });
    const sendEmailFn = createFunction('SendEmailFn', 'workflow/send-email.ts', {
      MOCK_API_URL: mockApi.apiEndpoint,
    });

    const workflow = new SubmissionWorkflow(this, 'SubmissionWorkflow', {
      submissions,
      scanAttachmentsFn,
      generateDorFn,
      archiveEvidenceFn,
      deliverSalesforceFn,
      sendEmailFn,
    });
    submitFn.addEnvironment('STATE_MACHINE_ARN', workflow.stateMachine.stateMachineArn);

    // Least privilege: each function gets only what it needs.
    // Submit may only write submissions, status may only read them.
    submissions.grantWriteData(submitFn);
    submissions.grantReadData(statusFn);
    // A presigned POST is signed with the Lambda's own credentials, so the
    // Lambda must itself be allowed to do what the browser will do: PutObject.
    attachments.grantPut(uploadUrlFn);
    // Submit checks that the referenced upload exists (HeadObject),
    // then starts the workflow.
    attachments.grantRead(submitFn);
    workflow.stateMachine.grantStartExecution(submitFn);

    // Workflow steps: every step reads the submission; beyond that, only
    // what the step does. (The state machine's own permissions to invoke
    // these Lambdas and update the table are added by CDK automatically.)
    for (const fn of [scanAttachmentsFn, generateDorFn, archiveEvidenceFn, deliverSalesforceFn, sendEmailFn]) {
      submissions.grantReadData(fn);
    }
    attachments.grantRead(scanAttachmentsFn);
    evidence.grantPut(generateDorFn);
    attachments.grantRead(archiveEvidenceFn); // copy source
    evidence.grantPut(archiveEvidenceFn); // copy destination

    // --- API Gateway (HTTP API) -------------------------------------------
    // The HTTP API is the cheaper, simpler API Gateway flavour. It maps
    // routes (method + path) to integrations, here Lambdas.
    const api = new HttpApi(this, 'FormsApi', {
      corsPreflight: {
        allowOrigins: ['*'], // prototype only: the local web page runs on another origin
        allowMethods: [CorsHttpMethod.ANY],
        allowHeaders: ['content-type'],
      },
    });

    api.addRoutes({
      path: '/config',
      methods: [HttpMethod.GET],
      integration: new HttpLambdaIntegration('ConfigIntegration', configFn),
    });
    api.addRoutes({
      path: '/submit',
      methods: [HttpMethod.POST],
      integration: new HttpLambdaIntegration('SubmitIntegration', submitFn),
    });
    api.addRoutes({
      path: '/uploads',
      methods: [HttpMethod.POST],
      integration: new HttpLambdaIntegration('UploadUrlIntegration', uploadUrlFn),
    });
    api.addRoutes({
      path: '/status/{id}',
      methods: [HttpMethod.GET],
      integration: new HttpLambdaIntegration('StatusIntegration', statusFn),
    });

    // Printed after `cdk deploy`; `npm run deploy` also writes it to
    // web/cdk-outputs.json, which the web page reads to find the API.
    new CfnOutput(this, 'ApiUrl', { value: api.apiEndpoint });
    new CfnOutput(this, 'MockExternalApiUrl', { value: mockApi.apiEndpoint });
    new CfnOutput(this, 'WorkflowConsoleUrl', {
      value: `https://${this.region}.console.aws.amazon.com/states/home?region=${this.region}#/statemachines/view/${workflow.stateMachine.stateMachineArn}`,
    });
  }
}
