import assert from 'node:assert/strict';
import { requestsCodingVerification } from '../server/verification-request.js';

for (const question of [
  'hi', 'Is the latest version of the repo downloaded?',
  'Please check whether the repository is up to date.',
  'Verify that the repo is downloaded', 'Check GitHub for updates',
  'Explain what the build command does', 'Show me the test results',
  'Did you change any code?', 'Update me on progress',
  'Do not run tests or change anything. Just report the current version.',
  'What does this command do?\n```sh\nnpm run build\n```',
  'Explain these README steps without running them:\nRun the tests.\nRun the build.',
  'Explain these README steps:\nRun the tests.\nRun the build.',
  'What does this instruction mean?\n> Run the tests',
]) assert.equal(requestsCodingVerification(question), false, question);

for (const request of [
  'Run the tests', 'Verify', 'Fix the bug in source', 'Can you refactor this function?',
  'Please run all checks.', 'Could you please run the unit tests?',
  'Run npm test', 'npm run build', 'Run the typecheck',
  'Verify the changes', 'Validate the implementation',
  'Please verify the build', 'Please test the project', 'Run the existing tests',
  'I want you to run the tests', 'Run pytest',
  'The implementation is ready. Please run the tests.',
  'Explain the changes. Run the tests.',
]) assert.equal(requestsCodingVerification(request), true, request);

console.log('Verification request classification tests passed');
