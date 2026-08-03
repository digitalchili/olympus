import assert from 'node:assert/strict';
import { RemoteHermesAdapter } from '../server/adapters/remote-hermes.js';

const originalFetch = globalThis.fetch;

function streamResponse(chunks: string[]): Response {
  return new Response(new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

async function collect(adapter: RemoteHermesAdapter, sessionId = 'task-123') {
  const events = [];
  for await (const event of adapter.chatStream(sessionId, 'Hi', {
    task: { id: 'task-123', title: 'Task title' },
    settings: { model: null, provider: null, reasoningEffort: 'medium' },
  })) {
    events.push(event);
  }
  return events;
}

try {
  {
    let sawChat = false;
    globalThis.fetch = (async (url, init) => {
      const headers = init?.headers as Record<string, string>;
      if (String(url).endsWith('/health')) {
        assert.equal(headers.Authorization, 'Bearer test-key');
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }

      sawChat = true;
      assert.equal(String(url), 'https://gateway.example.test/p/som-spirithouse-wine/v1/chat/completions');
      assert.equal(headers.Authorization, 'Bearer test-key');
      assert.equal(headers['X-Hermes-Session-Id'], 'task-123');
      assert.equal(headers['Content-Type'], 'application/json');
      assert.equal(headers.Accept, 'text/event-stream');

      const parsed = JSON.parse(String(init?.body));
      assert.equal(parsed.model, 'hermes-agent');
      assert.equal(parsed.stream, true);
      assert.deepEqual(parsed.messages, [{ role: 'user', content: 'Hi' }]);
      assert.deepEqual(parsed.model_options, { reasoning_effort: 'medium' });
      assert.equal('session_id' in parsed, false);
      assert.equal('profile' in parsed, false);
      assert.equal('task_id' in parsed, false);
      assert.equal('cwd' in parsed, false);
      assert.equal(JSON.stringify(parsed).includes('test-key'), false);

      return streamResponse([
        'data: {"choices":[{"delta":{"content":"Hello"},"finish_reason":null}]}\r\n\r\n',
        'event: hermes.tool.progress\r\n',
        'data: {"tool":"shell","status":"running","label":"Running shell"}\r\n\r\n',
        'data: {"choices":[{"delta":{"content":" world"},"finish_reason":null}]}\r\n\r\n',
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\r\n\r\n',
        'data: [DONE]\r\n\r\n',
      ]);
    }) as typeof fetch;

    const adapter = new RemoteHermesAdapter({
      id: 'som',
      label: 'Som',
      baseUrl: 'https://gateway.example.test/p/som-spirithouse-wine',
      apiKey: 'test-key',
      remoteProfile: 'som-spirithouse-wine',
      timeoutMs: 5_000,
    });

    assert.equal(await adapter.healthCheck(), true);
    assert.deepEqual(await collect(adapter), [
      { type: 'text_delta', content: 'Hello' },
      { type: 'tool_progress', tool: 'shell', status: 'running', label: 'Running shell' },
      { type: 'text_delta', content: ' world' },
      { type: 'done', sessionId: 'task-123' },
    ]);
    assert.equal(sawChat, true);
  }

  {
    globalThis.fetch = (async () => streamResponse([
      'data: {"choices":[{"delta":{"content":"partial"},"finish_reason":null}]}\n\n',
    ])) as typeof fetch;

    const adapter = new RemoteHermesAdapter({
      id: 'somboon',
      label: 'Somboon',
      baseUrl: 'https://gateway.example.test',
      apiKey: 'test-key',
      remoteProfile: 'default',
      timeoutMs: 5_000,
    });

    await assert.rejects(
      async () => collect(adapter),
      /Remote Hermes gateway stream ended before completion/,
    );
  }

  {
    globalThis.fetch = (async () => new Response(JSON.stringify({
      error: { message: 'bad secret test-key leaked by upstream' },
    }), { status: 502 })) as typeof fetch;

    const adapter = new RemoteHermesAdapter({
      id: 'somboon',
      label: 'Somboon',
      baseUrl: 'https://gateway.example.test',
      apiKey: 'test-key',
      remoteProfile: 'default',
      timeoutMs: 5_000,
    });

    await assert.rejects(
      async () => collect(adapter),
      (error) => error instanceof Error
        && error.message === 'Remote Hermes gateway request failed with HTTP 502'
      && !error.message.includes('test-key'),
    );
  }

  {
    globalThis.fetch = (async (_url, init) => {
      const parsed = JSON.parse(String(init?.body));
      assert.equal(parsed.model, 'custom-hermes-route');
      return streamResponse([
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
        'data: [DONE]\n\n',
      ]);
    }) as typeof fetch;

    const adapter = new RemoteHermesAdapter({
      id: 'somboon',
      label: 'Somboon',
      baseUrl: 'https://gateway.example.test',
      apiKey: 'test-key',
      remoteProfile: 'default',
      timeoutMs: 5_000,
    });

    const events = [];
    for await (const event of adapter.chatStream('task-123', 'Hi', {
      settings: { model: 'custom-hermes-route', provider: null, reasoningEffort: null },
    })) {
      events.push(event);
    }
    assert.deepEqual(events, [{ type: 'done', sessionId: 'task-123' }]);
  }

  {
    const seenUrls: string[] = [];
    globalThis.fetch = (async (url, init) => {
      seenUrls.push(String(url));
      const headers = init?.headers as Record<string, string>;
      assert.equal(headers.Authorization, 'Bearer test-key');
      assert.equal(init?.method, 'GET');

      if (String(url).endsWith('/messages')) {
        return new Response(JSON.stringify({
          object: 'list',
          session_id: 'task/slash id',
          data: [
            {
              id: 'm1',
              session_id: 'task/slash id',
              role: 'user',
              content: 'Hello',
              timestamp: 1_700_000_000,
            },
            {
              id: 'm2',
              session_id: 'task/slash id',
              role: 'assistant',
              content: ['part A', { text: 'part B' }],
              timestamp: 1_700_000_001_000,
              reasoning_content: { summary: 'thought' },
            },
            {
              role: 'system',
              content: null,
              timestamp: 'bad',
              reasoning: 'system thought',
            },
            {
              id: 'tool-only',
              role: 'tool',
              content: 'hidden',
              timestamp: 1_700_000_002_000,
            },
          ],
        }), { status: 200 });
      }

      return new Response(JSON.stringify({
        object: 'session',
        session: {
          id: 'task/slash id',
          input_tokens: '10',
          output_tokens: 5,
          cache_read_tokens: null,
          cache_write_tokens: 2,
          reasoning_tokens: '3',
          estimated_cost_usd: '0.12',
          model: 'gpt-test',
        },
      }), { status: 200 });
    }) as typeof fetch;

    const adapter = new RemoteHermesAdapter({
      id: 'som',
      label: 'Som',
      baseUrl: 'https://gateway.example.test/p/som-spirithouse-wine',
      apiKey: 'test-key',
      remoteProfile: 'som-spirithouse-wine',
      timeoutMs: 5_000,
    });

    const messages = await adapter.getMessages('task/slash id', 'olympus-task');
    assert.deepEqual(seenUrls[0], 'https://gateway.example.test/p/som-spirithouse-wine/api/sessions/task%2Fslash%20id/messages');
    assert.deepEqual(messages, [
      {
        id: 'm1',
        task_id: 'olympus-task',
        role: 'user',
        content: 'Hello',
        created_at: 1_700_000_000_000,
      },
      {
        id: 'm2',
        task_id: 'olympus-task',
        role: 'assistant',
        content: 'part A\npart B',
        thinking: '{"summary":"thought"}',
        created_at: 1_700_000_001_000,
      },
      {
        id: 'remote:task/slash id:2',
        task_id: 'olympus-task',
        role: 'system',
        content: '',
        thinking: 'system thought',
        created_at: 0,
      },
    ]);

    const session = await adapter.getSessionMetadata('task/slash id');
    assert.deepEqual(seenUrls[1], 'https://gateway.example.test/p/som-spirithouse-wine/api/sessions/task%2Fslash%20id');
    assert.deepEqual(session, {
      id: 'task/slash id',
      input_tokens: 10,
      output_tokens: 5,
      cache_read_tokens: 0,
      cache_write_tokens: 2,
      reasoning_tokens: 3,
      estimated_cost_usd: 0.12,
      cost_status: null,
      model: 'gpt-test',
    });
  }

  {
    globalThis.fetch = (async () => new Response('', { status: 404 })) as typeof fetch;
    const adapter = new RemoteHermesAdapter({
      id: 'somboon',
      label: 'Somboon',
      baseUrl: 'https://gateway.example.test',
      apiKey: 'test-key',
      remoteProfile: 'default',
      timeoutMs: 5_000,
    });

    assert.deepEqual(await adapter.getMessages('missing-session', 'task-123'), []);
    assert.equal(await adapter.getSessionMetadata('missing-session'), null);
  }

  {
    globalThis.fetch = (async () => new Response(JSON.stringify({
      error: { message: 'secret upstream body leaked test-key' },
    }), { status: 503 })) as typeof fetch;
    const adapter = new RemoteHermesAdapter({
      id: 'somboon',
      label: 'Somboon',
      baseUrl: 'https://gateway.example.test',
      apiKey: 'test-key',
      remoteProfile: 'default',
      timeoutMs: 5_000,
    });

    await assert.rejects(
      async () => adapter.getMessages('task-123', 'task-123'),
      (error) => error instanceof Error
        && error.message === 'Remote Hermes gateway request failed with HTTP 503'
      && !error.message.includes('test-key')
      && !error.message.includes('secret upstream body'),
    );
    await assert.rejects(
      async () => adapter.getSessionMetadata('task-123'),
      (error) => error instanceof Error
        && error.message === 'Remote Hermes gateway request failed with HTTP 503'
      && !error.message.includes('test-key')
      && !error.message.includes('secret upstream body'),
    );
  }

  {
    globalThis.fetch = (async () => streamResponse([
      'data: {"choices":[{"delta":{},"finish_reason":"length"}],"error":{"message":"secret upstream finish test-key"}}\n\n',
      'data: [DONE]\n\n',
    ])) as typeof fetch;

    const adapter = new RemoteHermesAdapter({
      id: 'somboon',
      label: 'Somboon',
      baseUrl: 'https://gateway.example.test',
      apiKey: 'test-key',
      remoteProfile: 'default',
      timeoutMs: 5_000,
    });

    const events = await collect(adapter);
    assert.deepEqual(events, [{ type: 'error', error: 'Remote Hermes gateway stream failed' }]);
    assert.equal(JSON.stringify(events).includes('test-key'), false);
    assert.equal(JSON.stringify(events).includes('secret upstream finish'), false);
  }

  {
    const adapter = new RemoteHermesAdapter({
      id: 'somboon',
      label: 'Somboon',
      baseUrl: 'https://gateway.example.test',
      apiKey: 'test-key',
      remoteProfile: 'default',
      timeoutMs: 5_000,
    });

    // The gateway API has no active-run steer endpoint. Returning false keeps
    // the message queued so Olympus sends it as a guaranteed next turn.
    assert.equal(await adapter.steerChat('task-123', 'Follow-up'), false);
  }
} finally {
  globalThis.fetch = originalFetch;
}

console.log('Remote Hermes adapter tests passed');
