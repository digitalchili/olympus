import { Router } from 'express';
import { getTask } from '../db/queries.js';
import { isRecord, toErrorMessage } from '../errors.js';
import { taskRunSettings } from '../agent-settings.js';
import { REASONING_EFFORTS, DEFAULT_PROFILE_NAME } from '../../shared/types.js';
import { profileRequestGate, requestProfile, requireTaskForProfile } from '../profile-context.js';
import { LocalProfileError } from '../local-profiles.js';
import type { AgentDefaults, Task, TaskAgentSettings, ReasoningEffort } from '../../shared/types.js';

interface AgentSettingsAdapter {
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
