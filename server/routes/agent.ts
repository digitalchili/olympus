import type { OpenAIAuthRequest, OpenAIAuthResponse, OpenAIAuthScope } from '../../shared/openai-auth.js';
import type { ProviderSetupRequest, ProviderSetupResponse } from '../../shared/provider-settings.js';
import { Router, type Request, type Response } from 'express';
import type { ProviderUsageResponse } from '../../shared/provider-usage.js';
import { getTask } from '../db/queries.js';
import { isRecord, toErrorMessage } from '../errors.js';
import { taskRunSettings } from '../agent-settings.js';
import { REASONING_EFFORTS, DEFAULT_PROFILE_NAME } from '../../shared/types.js';
import { profileRequestGate, requestProfile, requireTaskForProfile } from '../profile-context.js';
import { LocalProfileError } from '../local-profiles.js';
import type { AgentDefaults, Task, TaskAgentSettings, ReasoningEffort } from '../../shared/types.js';

interface AgentSettingsAdapter {
  manageOpenAIAuth?(input: OpenAIAuthRequest, profileId?: string, scope?: OpenAIAuthScope): Promise<OpenAIAuthResponse>;
  manageProviders?(input: ProviderSetupRequest, profileId?: string | null): Promise<ProviderSetupResponse>;
  getUsage?(profileId?: string | null, refresh?: boolean): Promise<ProviderUsageResponse>;
  getDefaults(profileId?: string | null): Promise<AgentDefaults>;
  setDefaults(updates: { provider?: string | null; model?: string | null; reasoningEffort?: string | null }, profileId?: string | null): Promise<AgentDefaults>;
  getModels(profileId?: string | null): Promise<unknown>;
}

const FALLBACK_DEFAULTS: AgentDefaults = {
  provider: null,
  model: null,
  baseUrl: null,
  apiMode: null,
  reasoningEffort: 'medium',
  showReasoning: true,
};

async function defaultsForSettings(adapter: AgentSettingsAdapter, profileId: string): Promise<AgentDefaults> {
  try {
    return await adapter.getDefaults(profileId);
  } catch {
    return FALLBACK_DEFAULTS;
  }
}

function buildTaskSettings(task: Task, defaults: AgentDefaults): TaskAgentSettings {
  const overrides = taskRunSettings(task);
  return {
    task: {
      model: overrides.model ?? null,
      provider: overrides.provider ?? null,
      reasoningEffort: overrides.reasoningEffort ?? null,
    },
    defaults,
    effective: {
      model: overrides.model ?? defaults.model,
      provider: overrides.provider ?? defaults.provider,
      reasoningEffort: overrides.reasoningEffort ?? defaults.reasoningEffort,
    },
  };
}

export function createAgentRouter(adapter: AgentSettingsAdapter): Router {
  const router = Router();

  const authResponse = async (req: Request, res: Response, input: OpenAIAuthRequest, scope: OpenAIAuthScope) => {
    try {
      if (!adapter.manageOpenAIAuth) throw Object.assign(new Error(), { code: 'auth_unsupported' });
      res.json(await adapter.manageOpenAIAuth(input, requestProfile(req).id, scope));
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? error.code : null;
      const status = code === 'auth_session_invalid' ? 404 : code === 'auth_busy' ? 409 : 503;
      res.status(status).json({ code: status === 404 ? 'auth_session_invalid' : status === 409 ? 'auth_busy' : 'openai_auth_unavailable',
        error: status === 404 ? 'This sign-in attempt is no longer available.' : status === 409 ? 'OpenAI sign-in is being saved. Try again shortly.' : 'OpenAI sign-in is unavailable right now. Try again.' });
    }
  };
  router.get('/openai-auth', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const scope = req.query.scope ?? 'shared';
    if (scope !== 'shared' && scope !== 'profile') return res.status(400).json({ error: 'Select shared or profile sign-in.' });
    await authResponse(req, res, { action: 'status' }, scope);
  });
  for (const action of ['check', 'start', 'poll', 'cancel'] as const) {
    router.post(`/openai-auth/${action}`, profileRequestGate(), async (req, res) => {
      res.set('Cache-Control', 'no-store');
      const body = req.body;
      const sessionAction = action === 'poll' || action === 'cancel';
      if (!isRecord(body) || Object.keys(body).some(key => !['scope', ...(sessionAction ? ['sessionId'] : [])].includes(key))) {
        return res.status(400).json({ error: 'Invalid sign-in request.' });
      }
      const scope = body.scope ?? 'shared';
      if (scope !== 'shared' && scope !== 'profile') return res.status(400).json({ error: 'Select shared or profile sign-in.' });
      if (sessionAction && (typeof body.sessionId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(body.sessionId))) {
        return res.status(400).json({ error: 'Select a valid sign-in attempt.' });
      }
      const input: OpenAIAuthRequest = sessionAction ? { action, sessionId: body.sessionId as string } : { action };
      await authResponse(req, res, input, scope);
    });
  }

  router.post('/providers', profileRequestGate(), async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const body = req.body;
    if (!isRecord(body) || !['list', 'discover', 'save', 'remove'].includes(String(body.action))) {
      return res.status(400).json({ error: 'Select a provider action.' });
    }
    const input: ProviderSetupRequest = { action: body.action as ProviderSetupRequest['action'] };
    for (const key of ['id', 'revision', 'name', 'baseUrl', 'apiKey'] as const) {
      if (key in body) {
        if (typeof body[key] !== 'string' || body[key].length > 4096) return res.status(400).json({ error: 'Provider details are invalid.' });
        input[key] = body[key];
      }
    }
    if ('models' in body) {
      if (!Array.isArray(body.models) || body.models.some(m => typeof m !== 'string' || m.length > 512)) return res.status(400).json({ error: 'Select valid model IDs.' });
      input.models = body.models;
    }
    try {
      if (!adapter.manageProviders) throw new Error('Unavailable');
      res.json(await adapter.manageProviders(input, requestProfile(req).id));
    } catch (error) {
      // Only this worker operation's fixed, sanitized errors may reach the browser.
      const safe = error instanceof Error && 'code' in error && error.code === 'provider_setup_failed';
      res.status(safe ? 400 : 503).json({ error: safe ? error.message.replace(/^\[provider_setup_failed\] /, '') : 'Provider setup is unavailable. Check the profile connection and try again.' });
    }
  });

  router.get('/usage', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
      if (!adapter.getUsage) throw new Error('Usage unavailable');
      res.json(await adapter.getUsage(requestProfile(req).id, req.query.refresh === 'true'));
    } catch {
      res.status(503).json({ error: 'Account usage is unavailable. Check this profile’s provider connection and try again.' });
    }
  });

  router.get('/defaults', async (req, res) => {
    try {
      res.json(await adapter.getDefaults(requestProfile(req).id));
    } catch (error) {
      if (error instanceof LocalProfileError) return res.status(error.status).json({ error: error.message, code: error.code });
      res.status(503).json({ error: toErrorMessage(error, 'Hermes worker unavailable') });
    }
  });

  router.patch('/defaults', profileRequestGate(), async (req, res) => {
    if (!isRecord(req.body)) {
      return res.status(400).json({ error: 'Request body is required' });
    }

    const updates: { provider?: string | null; model?: string | null; reasoningEffort?: string | null } = {};

    if ('provider' in req.body) {
      const provider = req.body.provider;
      if (provider !== null && typeof provider !== 'string') {
        return res.status(400).json({ error: 'provider must be a string or null' });
      }
      updates.provider = typeof provider === 'string' ? provider.trim() || null : null;
    }

    if ('model' in req.body) {
      const model = req.body.model;
      if (model !== null && typeof model !== 'string') {
        return res.status(400).json({ error: 'model must be a string or null' });
      }
      updates.model = typeof model === 'string' ? model.trim() || null : null;
    }

    if ('reasoningEffort' in req.body) {
      const effort = req.body.reasoningEffort;
      if (effort !== null && (typeof effort !== 'string' || !(REASONING_EFFORTS as readonly string[]).includes(effort))) {
        return res.status(400).json({ error: `reasoningEffort must be one of: ${REASONING_EFFORTS.join(', ')}` });
      }
      updates.reasoningEffort = effort as ReasoningEffort | null;
    }

    try {
      const defaults = await adapter.setDefaults(updates, requestProfile(req).id);
      res.json(defaults);
    } catch (error) {
      if (error instanceof LocalProfileError) return res.status(error.status).json({ error: error.message, code: error.code });
      res.status(503).json({ error: toErrorMessage(error, 'Failed to update defaults') });
    }
  });

  router.get('/models', async (req, res) => {
    try {
      res.json(await adapter.getModels(requestProfile(req).id));
    } catch (error) {
      if (error instanceof LocalProfileError) return res.status(error.status).json({ error: error.message, code: error.code });
      res.status(503).json({ error: toErrorMessage(error, 'Hermes worker unavailable') });
    }
  });

  return router;
}

export function createTaskAgentSettingsRouter(adapter: AgentSettingsAdapter): Router {
  const router = Router();
  const requireTask = requireTaskForProfile(getTask);

  router.get('/:id/agent-settings', requireTask, async (_req, res) => {
    const task = res.locals.task as Task;

    const defaults = await defaultsForSettings(adapter, task.profile_name ?? DEFAULT_PROFILE_NAME);
    res.json(buildTaskSettings(task, defaults));
  });

  return router;
}
