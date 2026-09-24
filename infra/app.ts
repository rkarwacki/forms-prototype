// Entry point for the CDK app. `cdk deploy` runs this file, which builds a
// CloudFormation template from the stack below and deploys it.
import { App } from 'aws-cdk-lib';
import { FormsStack } from './forms-stack';

const app = new App();

new FormsStack(app, 'FormsPrototype', {
  env: { region: 'eu-central-1' },
});
