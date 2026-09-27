import assert from 'node:assert/strict';
import { parseProjectSecretInput, validateProjectSecretEntries } from '../shared/project-secrets.js';

assert.deepEqual(parseProjectSecretInput('Please add a search box.'), { kind: 'none' });
assert.deepEqual(parseProjectSecretInput('Explain how API_KEY works'), { kind: 'none' });
for (const text of ['Store user passwords securely using bcrypt', 'Save the API keys settings screen', 'Remember to redact tokens from logs']) {
  assert.deepEqual(parseProjectSecretInput(text), { kind: 'none' });
}
assert.deepEqual(parseProjectSecretInput('Save this in the project’s secrets:\nOPENAI_API_KEY=fake-secret-for-tests'), {
  kind: 'secrets', entries: [{ name: 'OPENAI_API_KEY', value: 'fake-secret-for-tests' }],
});
assert.deepEqual(parseProjectSecretInput('/secrets\n```dotenv\n# Local testing\nexport DATABASE_URL="postgres://tester:fake-pass@localhost/test"\nAPI_TOKEN=\'literal-$HOME-$(echo never)\'\n```'), {
  kind: 'secrets', entries: [{ name: 'DATABASE_URL', value: 'postgres://tester:fake-pass@localhost/test' }, { name: 'API_TOKEN', value: 'literal-$HOME-$(echo never)' }],
});
assert.deepEqual(parseProjectSecretInput('API_TOKEN=abc123 # a comment'), { kind: 'secrets', entries: [{ name: 'API_TOKEN', value: 'abc123' }] });
for (const text of [
  '/secrets\nAPI_TOKEN=one\nAPI_TOKEN=two',
  'Save these secrets: not-a-valid-entry',
  'Here is my API_KEY=fake-value please save it',
  'Use these settings: SUPABASE_SERVICE_ROLE_KEY=fake-value',
  'DATABASE_URL="unterminated',
  'API_KEY=',
  'API_KEY=fake-value\nNow deploy everything',
  '```env\nAPI_KEY=fake\n',
  '/secrets\nPATH=/tmp/evil',
  'OPENAI_API_KEY=' + 'x'.repeat(17_000),
  'sk-proj-' + 'a'.repeat(45),
  'API_KEY="' + 'x\n'.repeat(16000) + 'x',
]) {
  const result = parseProjectSecretInput(text);
  assert.equal(result.kind, 'invalid', 'secret candidates must never fall through to chat');
  if (result.kind === 'invalid') assert.ok(!result.error.includes('fake-value'));
}
for (const name of ['PATH', 'HOME', 'LD_PRELOAD', 'DYLD_INSERT_LIBRARIES', 'NODE_OPTIONS', 'BASH_ENV', 'PYTHONPATH', 'HERMES_HOME', 'OLYMPUS_MAINTENANCE_TOKEN', 'GIT_CONFIG_COUNT']) {
  assert.throws(() => validateProjectSecretEntries([{ name, value: 'test-only' }]), /reserved/i);
}
assert.throws(() => validateProjectSecretEntries([{ name: '__proto__', value: 'bad' }]), /reserved/i);
assert.throws(() => validateProjectSecretEntries([{ name: 'API_KEY', value: 'a\0b' }]), /value/i);
console.log('Project secret parsing, literal values and fail-closed candidate tests passed');
