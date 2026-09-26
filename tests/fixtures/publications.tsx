import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router';
import { ProfileProvider } from '../../client/src/contexts/ProfileContext';
import { ProjectDetailPage } from '../../client/src/components/ProjectDetailPage';
import { TaskCommitPushModal } from '../../client/src/components/TaskCommitPushModal';
import type { ProjectRepositoryLink } from '../../shared/types';
import '../../client/src/styles/globals.css';

// Browser-only gateway. No Olympus server, credentials, Git command or network request.
const key = 'olympus-publication-fixture';
const initial = () => ({ outcome: 'unconfirmed', pending: false, published: false, commitRequests: 0, retryRequests: 0 });
let state = JSON.parse(localStorage.getItem(key) ?? 'null') ?? initial();
const save = () => localStorage.setItem(key, JSON.stringify(state));
const sha = 'a'.repeat(40);
const link = { fullName: 'fixture/repository', defaultBranch: 'main', installationId: 1, providerRepositoryId: 2, htmlUrl: 'https://github.com/fixture/repository' } as ProjectRepositoryLink;
const editor = { id: 'lease-1', taskId: 'task-1', projectId: 'project-1', branchName: 'olympus/task-1', status: 'ready', profileId: 'default' };
const version = { id: 'version-1', projectId: 'project-1', taskId: 'task-1', branchName: 'olympus/task-1', commitSha: sha, commitMessage: 'Fixture change', action: 'commit_push', changedFiles: ['draft.txt'], pushedAt: 1 };
const pending = { id: 'publication-1', action: 'commit_push', commitSha: sha, targetBranches: ['olympus/task-1', 'main'], state: 'pending' };
const json = (body: unknown, status = 200) => Response.json(body, { status });
window.fetch = async (input, init) => {
  const path = new URL(String(input), location.origin).pathname;
  const body = JSON.parse(String(init?.body ?? '{}'));
  if (path === '/api/profiles') return json({ profiles: [{ id: 'default', displayName: 'Default', isDefault: true, active: true }] });
  if (path === '/api/studio/github/status') return json({ configured: true, installations: [] });
  if (path.endsWith('/grants')) return json({ grants: [] });
  if (path.endsWith('/references')) return json({ references: [] });
  if (path.endsWith('/tasks')) return json({ tasks: [{ id: 'task-1', title: 'Publication fixture task', status: 'in_review', handling_profile_id: 'default' }] });
  if (path.endsWith('/editors')) return json({ editors: [editor] });
  if (path.endsWith('/versions')) return json({ versions: state.published ? [version] : [] });
  if (path.endsWith('/editor/prepare')) return json({ editor });
  if (path.endsWith('/editor/status')) return json({ status: {
    clean: state.published || state.pending, changedFiles: state.published || state.pending ? [] : ['draft.txt'],
    summary: state.pending ? 'Saved commit; publication unconfirmed' : state.published ? 'Working tree is clean' : 'One changed file',
    diff: 'A local draft retained throughout publication', pendingPublication: state.pending ? pending : null,
  } });
  if (path.endsWith('/sync')) return json({ lastSync: null, blocker: null });
  if (path.endsWith('/commit-push')) {
    state.commitRequests++; state.pending = true; save();
    if (state.outcome !== 'success') return json({ error: 'GitHub publication could not be confirmed.', code: 'PROJECT_PUBLICATION_UNCONFIRMED' }, 503);
    state.pending = false; state.published = true; save(); return json({ version, versions: [version] });
  }
  if (path.endsWith('/publications/publication-1/retry')) {
    if (Object.keys(body).join() !== 'taskId') throw new Error('Retry changed saved intent');
    state.retryRequests++; save();
    if (state.outcome === 'conflict') return json({ error: 'GitHub branch changed. Resolve the conflict before resuming.', code: 'PROJECT_PUBLICATION_CONFLICT' }, 409);
    state.pending = false; state.published = true; save(); return json({ version, versions: [version] });
  }
  if (path.endsWith('/publications/publication-1/abandon')) {
    state.pending = false; state.published = false; save(); return json({ abandoned: true });
  }
  if (path === '/api/projects/project-1') return json({ project: { id: 'project-1', name: 'Publication fixture', purpose: 'Disposable browser test', managerProfileId: 'default', manager: { displayName: 'Default' }, repositoryLink: link }, managerHistory: [] });
  throw new Error(`Unexpected fixture request ${path}`);
};
window.EventSource = class { close() {} } as unknown as typeof EventSource;

function Fixture() {
  const [modal, setModal] = useState(false);
  const [outcome, setOutcome] = useState(state.outcome);
  return <>
    <div className="flex items-center gap-4 border-b bg-zinc-100 p-3 text-sm">
      <strong>Disposable publication fixture</strong>
      <label>Gateway outcome <select aria-label="Gateway outcome" value={outcome} onChange={event => { state.outcome = event.target.value; save(); setOutcome(event.target.value); }}><option value="success">Success</option><option value="unconfirmed">Unconfirmed</option><option value="conflict">Conflict on resume</option></select></label>
      <button onClick={() => setModal(true)}>Open task publication</button>
      <button onClick={() => { state = initial(); save(); location.reload(); }}>Reset fixture</button>
    </div>
    <MemoryRouter initialEntries={['/projects/project-1?tab=code&profile=default']}><ProfileProvider><Routes><Route path="/projects/:projectId" element={<ProjectDetailPage />} /></Routes></ProfileProvider></MemoryRouter>
    <TaskCommitPushModal open={modal} onClose={() => setModal(false)} projectId="project-1" taskId="task-1" taskTitle="Fixture" repositoryLink={link} />
  </>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
