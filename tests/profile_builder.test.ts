import assert from 'node:assert/strict';
import {
  createProfilesRouter,
  parseProfileBuilderSuggestion,
  PROFILE_BUILDER_SYSTEM_MESSAGE,
} from '../server/routes/profiles.js';
import type { AgentRunOptions } from '../server/adapters/types.js';

const validDraft = {
  displayName: 'Evidence Guide',
  description: 'Checks primary sources and summarizes uncertainty.',
  soul: '# Identity\nBe careful, concise, and explicit about uncertainty.',
  provider: null,
  model: null,
  reasoningEffort: 'high',
};

assert.deepEqual(
  parseProfileBuilderSuggestion(`\`\`\`json\n${JSON.stringify(validDraft)}\n\`\`\``),
  validDraft,
  'safe parsing should accept a single JSON code fence',
);
assert.throws(
  () => parseProfileBuilderSuggestion(JSON.stringify({ ...validDraft, reasoningEffort: 'unlimited' })),
  /reasoningEffort/,
);
assert.throws(
  () => parseProfileBuilderSuggestion('{not json}'),
  /Invalid profile draft/,
);

interface DraftCall {
  profileId: string;
  sessionId: string;
  message: string;
  options: AgentRunOptions;
}

async function invokeDraft(text: string | Error, body: unknown = { description: 'A careful source-checking research partner.' }) {
  const calls: DraftCall[] = [];
  const router = createProfilesRouter({
    async chatForProfile(profileId, sessionId, message, options) {
      calls.push({ profileId, sessionId, message, options });
      if (text instanceof Error) throw text;
      return { text, sessionId };
    },
  });
  const routeStack = router.stack.find((layer) => layer.route?.path === '/draft')?.route.stack;
  const handler = routeStack?.at(-1)?.handle as Function;
  assert.ok(handler, 'draft route should be registered');

  const result = { status: 200, body: undefined as unknown };
  const req = {
    body,
    query: {},
    activeHermesProfile: { id: 'writer' },
  };
  const res = {
    status(status: number) { result.status = status; return this; },
    json(responseBody: unknown) { result.body = responseBody; return this; },
  };
  await handler(req, res);
  return { ...result, calls };
}

const drafted = await invokeDraft(JSON.stringify(validDraft));
assert.equal(drafted.status, 200);
assert.deepEqual(drafted.body, { suggestion: validDraft });
assert.equal(drafted.calls.length, 1);
assert.equal(drafted.calls[0]?.profileId, 'writer');
assert.match(drafted.calls[0]?.sessionId ?? '', /^profile-builder-/);
assert.equal(drafted.calls[0]?.message, 'A careful source-checking research partner.');
assert.equal(drafted.calls[0]?.options.systemMessage, PROFILE_BUILDER_SYSTEM_MESSAGE);
assert.match(PROFILE_BUILDER_SYSTEM_MESSAGE, /Do not call tools/);

const invalid = await invokeDraft('{"displayName":"leaked-secret-value"}');
assert.equal(invalid.status, 502);
assert.deepEqual(invalid.body, {
  error: 'Hermes returned an invalid profile draft. Please try again.',
  code: 'INVALID_PROFILE_DRAFT',
});
assert.doesNotMatch(JSON.stringify(invalid.body), /leaked-secret-value/);

const unavailable = await invokeDraft(new Error('provider-key-secret'));
assert.equal(unavailable.status, 503);
assert.doesNotMatch(JSON.stringify(unavailable.body), /provider-key-secret/);

const badInput = await invokeDraft(JSON.stringify(validDraft), { description: '' });
assert.equal(badInput.status, 400);
assert.equal(badInput.calls.length, 0);

console.log('Profile builder route and parser tests passed');
