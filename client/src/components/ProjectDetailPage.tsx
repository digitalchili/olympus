import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Check, ExternalLink, FileText, GitBranch, History, Loader2, Plus, RefreshCw, RotateCcw, Save, Shield, Sparkles, Trash2, UploadCloud } from 'lucide-react';
import { Link, useParams, useSearchParams } from 'react-router';
import type {
  ProjectAccessRole,
  PublicProjectEditorLease,
  ProjectManagerHistoryEntry,
  ProjectProfileGrant,
  ProjectReferenceListItem,
  ProjectReferenceSearchResult,
  ProjectSummary,
  ProjectVersion,
  StudioGitHubInstallation,
  StudioGitHubRepository,
  Task,
  TaskStatus,
} from '@shared/types';
import {
  acquireProjectEditor,
  commitPushProject,
  deleteTask,
  deleteProjectReference,
  fetchProject,
  fetchProjectEditor,
  fetchProjectEditorStatus,
  fetchProjectGrants,
  fetchProjectReferences,
  fetchProjectTasks,
  fetchProjectVersions,
  fetchStudioGitHubStatus,
  fetchStudioRepositories,
  generateProjectCommitMessage,
  moveTask,
  projectReferenceDownloadUrl,
  reassignProjectManager,
  reindexProjectReference,
  releaseProjectEditor,
  revokeProjectGrant,
  revertProjectVersion,
  searchProjectReferences,
  setProjectGrant,
  syncProjectFromGitHub,
  updateProject,
  uploadProjectReference,
} from '../lib/api';
import { useProfile } from '../contexts/ProfileContext';
import { toWithProfile } from '../lib/profileQuery';
import { toErrorMessage } from '../lib/format';
import { useProjectBoardEvents } from '../hooks/useProjectBoardEvents';
import { selectableStudioRepositories } from '../lib/studio-projects';
import { TaskKanban } from './Board';
import { usePageHeader } from './Header';

const accessRoles: ProjectAccessRole[] = ['view', 'contribute', 'manage'];
const projectTabs = ['board', 'code', 'references', 'activity', 'settings'] as const;
type ProjectTab = typeof projectTabs[number];

export function ProjectDetailPage() {
  const { projectId = '' } = useParams();
  const { profiles } = useProfile();
  const [searchParams, setSearchParams] = useSearchParams();
  const requestedTab = searchParams.get('tab');
  const activeTab: ProjectTab = projectTabs.includes(requestedTab as ProjectTab) ? requestedTab as ProjectTab : 'board';
  const [project, setProject] = useState<ProjectSummary | null>(null);
  const [history, setHistory] = useState<ProjectManagerHistoryEntry[]>([]);
  const [grants, setGrants] = useState<ProjectProfileGrant[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [editor, setEditor] = useState<PublicProjectEditorLease | null>(null);
  const [versions, setVersions] = useState<ProjectVersion[]>([]);
  const [editorTaskId, setEditorTaskId] = useState('');
  const [commitMessage, setCommitMessage] = useState('');
  const [codeStatus, setCodeStatus] = useState<{ clean: boolean; changedFiles: string[]; summary: string; diff: string } | null>(null);
  const [references, setReferences] = useState<ProjectReferenceListItem[]>([]);
  const [referenceSearch, setReferenceSearch] = useState('');
  const [referenceResults, setReferenceResults] = useState<ProjectReferenceSearchResult[]>([]);
  const [uploadingReference, setUploadingReference] = useState(false);
  const [referenceDragActive, setReferenceDragActive] = useState(false);
  const [referenceUploadStatus, setReferenceUploadStatus] = useState<string | null>(null);
  const [uploadState, setUploadState] = useState<{
    filename: string;
    index: number;
    total: number;
    phase: 'uploading' | 'indexing';
    percent: number;
  } | null>(null);
  const [reindexingId, setReindexingId] = useState<string | null>(null);
  const referenceUploadLock = useRef(false);
  const [nextManager, setNextManager] = useState('');
  const [previousManagerRole, setPreviousManagerRole] = useState<'view' | 'contribute' | 'none'>('none');

  const [draftName, setDraftName] = useState('');
  const [draftPurpose, setDraftPurpose] = useState('');
  const [grantProfileId, setGrantProfileId] = useState('');
  const [grantRole, setGrantRole] = useState<ProjectAccessRole>('view');
  const [installations, setInstallations] = useState<StudioGitHubInstallation[]>([]);
  const [repositories, setRepositories] = useState<StudioGitHubRepository[]>([]);
  const [repositoryInstallationId, setRepositoryInstallationId] = useState<number | null>(null);
  const [repositoryId, setRepositoryId] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const pageHeader = useMemo(() => ({
    crumbs: [
      { label: 'Projects', to: '/projects' },
      { label: project?.name ?? 'Project' },
    ],
  }), [project?.name]);
  usePageHeader(pageHeader);

  const selectTab = (tab: ProjectTab) => {
    const next = new URLSearchParams(searchParams);
    if (tab === 'board') next.delete('tab');
    else next.set('tab', tab);
    setSearchParams(next, { replace: true });
  };


  const load = useCallback(async () => {
    try {
      setLoadError(null);
      const [detail, taskResult, grantResult, referenceResult, editorResult, versionResult] = await Promise.all([
        fetchProject(projectId),
        fetchProjectTasks(projectId),
        fetchProjectGrants(projectId),
        fetchProjectReferences(projectId),
        fetchProjectEditor(projectId),
        fetchProjectVersions(projectId),
      ]);
      setProject(detail.project);
      setHistory(detail.managerHistory);
      setTasks(taskResult.tasks);
      setGrants(grantResult.grants);
      setReferences(referenceResult.references);
      setEditor(editorResult.editor);
      setVersions(versionResult.versions);
      setEditorTaskId((current) => editorResult.editor?.taskId ?? current ?? '');
      setNextManager(detail.project.managerProfileId);
      setDraftName(detail.project.name);
      setDraftPurpose(detail.project.purpose);
      setRepositoryInstallationId(detail.project.repositoryLink?.installationId ?? null);
      setRepositoryId(detail.project.repositoryLink?.providerRepositoryId ?? null);
    } catch (cause) {
      setLoadError(toErrorMessage(cause, 'Could not load Project'));
    }
  }, [projectId]);

  useEffect(() => { void load(); }, [load]);
  const taskRuns = useProjectBoardEvents(projectId, setTasks, load);


  useEffect(() => {
    fetchStudioGitHubStatus()
      .then(({ installations: next }) => setInstallations(next.filter((installation) => installation.permissionMode === 'read_write')))
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!repositoryInstallationId) {
      setRepositories([]);
      if (!project?.repositoryLink) setRepositoryId(null);
      return;
    }
    let cancelled = false;
    fetchStudioRepositories(repositoryInstallationId)
      .then(({ repositories: next }) => { if (!cancelled) setRepositories(next); })
      .catch(() => { if (!cancelled) setRepositories([]); });
    return () => { cancelled = true; };
  }, [repositoryInstallationId, project?.repositoryLink]);

  const selectableRepositories = selectableStudioRepositories(
    repositories,
    [],
  );

  const eligibleGrantProfiles = useMemo(
    () => profiles.filter((profile) => profile.active && profile.id !== project?.managerProfileId),
    [profiles, project?.managerProfileId],
  );

  const profileName = (profileId: string) => (
    profiles.find((profile) => profile.id === profileId)?.displayName ?? profileId
  );

  const saveProject = async () => {
    if (!project || !draftName.trim() || !draftPurpose.trim()) return;
    setBusy(true);
    setActionError(null);
    try {
      const repositoryLink = repositoryInstallationId && repositoryId ? { installationId: repositoryInstallationId, repositoryId } : null;
      const result = await updateProject(project.id, { name: draftName, purpose: draftPurpose, repositoryLink });
      setProject(result.project);
      setDraftName(result.project.name);
      setDraftPurpose(result.project.purpose);

    } catch (cause) {
      setActionError(toErrorMessage(cause, 'Could not update Project'));
    } finally {
      setBusy(false);
    }
  };

  const changeManager = async () => {
    if (!project || !nextManager || nextManager === project.managerProfileId) return;
    setBusy(true);
    setActionError(null);
    try {
      await reassignProjectManager(
        project.id,
        nextManager,
        previousManagerRole === 'none' ? null : previousManagerRole,
      );
      setPreviousManagerRole('none');
      setGrantProfileId('');
      await load();
    } catch (cause) {
      setActionError(toErrorMessage(cause, 'Could not change manager'));
    } finally {
      setBusy(false);
    }
  };

  const saveGrant = async () => {
    if (!project || !grantProfileId) return;
    setBusy(true);
    setActionError(null);
    try {
      await setProjectGrant(project.id, grantProfileId, grantRole);
      const result = await fetchProjectGrants(project.id);
      setGrants(result.grants);
      setGrantProfileId('');
      setGrantRole('view');
    } catch (cause) {
      setActionError(toErrorMessage(cause, 'Could not update Project access'));
    } finally {
      setBusy(false);
    }
  };

  const removeGrant = async (profileId: string) => {
    if (!project) return;
    setBusy(true);
    setActionError(null);
    try {
      await revokeProjectGrant(project.id, profileId);
      setGrants((current) => current.filter((grant) => grant.profileId !== profileId));
    } catch (cause) {
      setActionError(toErrorMessage(cause, 'Could not revoke Project access'));
    } finally {
      setBusy(false);
    }
  };

  const uploadReferences = async (files: FileList | null) => {
    const pendingFiles = Array.from(files ?? []);
    if (!project || pendingFiles.length === 0) return;
    if (referenceUploadLock.current) {
      setReferenceUploadStatus('Wait for the current upload to finish before adding more files');
      return;
    }
    referenceUploadLock.current = true;
    setUploadingReference(true);
    setActionError(null);
    let currentFilename = '';
    try {
      for (const [index, file] of pendingFiles.entries()) {
        currentFilename = file.name;
        setUploadState({
          filename: file.name,
          index: index + 1,
          total: pendingFiles.length,
          phase: 'uploading',
          percent: 0,
        });
        setReferenceUploadStatus(`Uploading ${file.name} (0%)…`);
        const result = await uploadProjectReference(
          project.id,
          file,
          undefined,
          (progress) => {
            setUploadState({
              filename: file.name,
              index: index + 1,
              total: pendingFiles.length,
              phase: progress.phase,
              percent: progress.percent,
            });
            if (progress.phase === 'indexing') {
              setReferenceUploadStatus(`Indexing & analyzing ${file.name}…`);
            } else {
              setReferenceUploadStatus(`Uploading ${file.name} (${progress.percent}%)…`);
            }
          },
        );
        setReferences((current) => [result.reference, ...current.filter((item) => item.id !== result.reference.id)]);
      }
      setReferenceUploadStatus(`Uploaded ${pendingFiles.length} ${pendingFiles.length === 1 ? 'reference' : 'references'}`);
    } catch (cause) {
      setActionError(toErrorMessage(cause, `Could not upload ${currentFilename || 'Project reference'}`));
      setReferenceUploadStatus(`Upload stopped at ${currentFilename || 'Project reference'}`);
    } finally {
      referenceUploadLock.current = false;
      setUploadingReference(false);
      setUploadState(null);
    }
  };

  const runReferenceSearch = async () => {
    if (!project || !referenceSearch.trim()) {
      setReferenceResults([]);
      return;
    }
    setActionError(null);
    try {
      const result = await searchProjectReferences(project.id, referenceSearch);
      setReferenceResults(result.results);
    } catch (cause) {
      setActionError(toErrorMessage(cause, 'Could not search Project references'));
    }
  };

  const reindexReference = async (referenceId: string) => {
    if (!project) return;
    setBusy(true);
    setReindexingId(referenceId);
    setActionError(null);
    try {
      const result = await reindexProjectReference(project.id, referenceId);
      setReferences((current) => current.map((item) => item.id === referenceId ? result.reference : item));
    } catch (cause) {
      setActionError(toErrorMessage(cause, 'Could not reindex Project reference'));
    } finally {
      setBusy(false);
      setReindexingId(null);
    }
  };

  const removeReference = async (referenceId: string) => {
    if (!project) return;
    setBusy(true);
    setActionError(null);
    try {
      await deleteProjectReference(project.id, referenceId);
      setReferences((current) => current.filter((item) => item.id !== referenceId));
      setReferenceResults((current) => current.filter((item) => item.referenceId !== referenceId));
    } catch (cause) {
      setActionError(toErrorMessage(cause, 'Could not delete Project reference'));
    } finally {
      setBusy(false);
    }
  };

  const taskProfileId = (task: Task) => task.handling_profile_id ?? task.profile_name ?? project?.managerProfileId ?? 'default';

  useEffect(() => {
    if (editor?.taskId) {
      setEditorTaskId(editor.taskId);
      return;
    }
    if (!editorTaskId && tasks.length > 0) setEditorTaskId(tasks.find((task) => task.status === 'in_progress')?.id ?? tasks[0]!.id);
  }, [editor?.taskId, editorTaskId, tasks]);

  useEffect(() => {
    if (activeTab !== 'code' || !editor) {
      setCodeStatus(null);
      return;
    }
    fetchProjectEditorStatus(projectId, editor.taskId)
      .then(({ status }) => setCodeStatus(status))
      .catch((cause) => setActionError(toErrorMessage(cause, 'Could not inspect Project changes')));
  }, [activeTab, editor, projectId]);

  const refreshCode = async (taskId = editor?.taskId) => {
    const [editorResult, versionResult] = await Promise.all([
      fetchProjectEditor(projectId),
      fetchProjectVersions(projectId),
    ]);
    setEditor(editorResult.editor);
    setVersions(versionResult.versions);
    if (taskId && editorResult.editor?.taskId === taskId) {
      const { status } = await fetchProjectEditorStatus(projectId, taskId);
      setCodeStatus(status);
    } else {
      setCodeStatus(null);
    }
  };

  const beginEditing = async () => {
    if (!editorTaskId) return;
    setBusy(true);
    setActionError(null);
    try {
      const result = await acquireProjectEditor(projectId, editorTaskId);
      setEditor(result.editor);
      await refreshCode(result.editor.taskId);
    } catch (cause) {
      setActionError(toErrorMessage(cause, 'Could not prepare the Project editor'));
    } finally {
      setBusy(false);
    }
  };

  const stopEditing = async () => {
    if (!editor) return;
    setBusy(true);
    setActionError(null);
    try {
      await releaseProjectEditor(projectId, editor.taskId);
      await refreshCode();
    } catch (cause) {
      setActionError(toErrorMessage(cause, 'Could not release the Project editor'));
    } finally {
      setBusy(false);
    }
  };

  const [generatingMessage, setGeneratingMessage] = useState(false);

  const autoGenerateMessage = async () => {
    if (!editor) return;
    setGeneratingMessage(true);
    setActionError(null);
    try {
      const result = await generateProjectCommitMessage(projectId, editor.taskId);
      if (result.message) setCommitMessage(result.message);
    } catch (cause) {
      setActionError(toErrorMessage(cause, 'Could not generate commit message'));
    } finally {
      setGeneratingMessage(false);
    }
  };

  const [pushStatus, setPushStatus] = useState<'idle' | 'pushing' | 'success'>('idle');
  const [lastPushedSha, setLastPushedSha] = useState<string | null>(null);
  const [deployToDefault, setDeployToDefault] = useState(true);

  const commitAndPush = async () => {
    if (!editor || !codeStatus || codeStatus.clean || !commitMessage.trim()) return;
    const targetBranch = deployToDefault && project?.repositoryLink?.defaultBranch
      ? project.repositoryLink.defaultBranch
      : editor.branchName;
    const preview = codeStatus.changedFiles.slice(0, 12).join('\n');
    const confirmMsg = deployToDefault && project?.repositoryLink?.defaultBranch
      ? `Commit & Deploy directly to ${targetBranch} (triggers Dokploy build)?\n\n${preview}${codeStatus.changedFiles.length > 12 ? '\n…' : ''}`
      : `Commit & Push to ${targetBranch}?\n\n${preview}${codeStatus.changedFiles.length > 12 ? '\n…' : ''}`;
    if (!window.confirm(confirmMsg)) return;
    setBusy(true);
    setPushStatus('pushing');
    setActionError(null);
    try {
      const result = await commitPushProject(projectId, editor.taskId, commitMessage.trim(), deployToDefault);
      setVersions(result.versions);
      setCommitMessage('');
      setLastPushedSha(result.version?.commitSha ?? null);
      setPushStatus('success');
      setTimeout(() => setPushStatus('idle'), 6000);
      await refreshCode(editor.taskId);
    } catch (cause) {
      setPushStatus('idle');
      setActionError(toErrorMessage(cause, 'Commit & Push failed; your changes remain available to retry'));
    } finally {
      setBusy(false);
    }
  };

  const restoreVersion = async (version: ProjectVersion) => {
    if (!editor) return;
    if (!window.confirm(`Revert to this version?\n\n${version.commitMessage}\n\nOlympus will create and push a new restore checkpoint. Existing history will remain intact.`)) return;
    setBusy(true);
    setActionError(null);
    try {
      const result = await revertProjectVersion(projectId, editor.taskId, version.id);
      setVersions(result.versions);
      await refreshCode(editor.taskId);
    } catch (cause) {
      setActionError(toErrorMessage(cause, 'Could not restore this version'));
    } finally {
      setBusy(false);
    }
  };

  const [syncingGitHub, setSyncingGitHub] = useState(false);
  const [syncMessage, setSyncMessage] = useState<string | null>(null);

  const syncFromGitHub = async () => {
    if (!project?.repositoryLink) return;
    setSyncingGitHub(true);
    setSyncMessage(null);
    setActionError(null);
    try {
      const result = await syncProjectFromGitHub(projectId);
      setSyncMessage(result.message);
      setTimeout(() => setSyncMessage(null), 6000);
      if (editor?.taskId) {
        await refreshCode(editor.taskId);
      }
    } catch (cause) {
      setActionError(toErrorMessage(cause, 'Could not sync from GitHub'));
    } finally {
      setSyncingGitHub(false);
    }
  };

  const moveProjectTask = async (task: Task, status: TaskStatus): Promise<Task> => {
    const result = await moveTask(task.id, status, taskProfileId(task));
    setTasks((current) => current.map((item) => item.id === task.id ? result.task : item));
    return result.task;
  };

  const deleteProjectTask = async (task: Task) => {
    await deleteTask(task.id, taskProfileId(task));
    setTasks((current) => current.filter((item) => item.id !== task.id));
  };

  if (loadError) return <div className="p-7 text-sm text-red-600">{loadError}</div>;
  if (!project) return <div className="p-7 text-sm text-zinc-500">Loading Project…</div>;

  return (
    <div className="flex-1 overflow-y-auto p-5 sm:p-7">
      <div className="mx-auto max-w-[1600px]">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-zinc-400">Project</p>
            <h1 className="mt-1 text-2xl font-semibold text-zinc-900 dark:text-zinc-100">{project.name}</h1>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-zinc-500">{project.purpose}</p>
          </div>
          <div className="flex items-center gap-2">
            {project.repositoryLink && (
              <button
                type="button"
                disabled={syncingGitHub || busy}
                onClick={() => void syncFromGitHub()}
                className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 px-3 text-xs font-medium text-zinc-700 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-700 transition-colors disabled:opacity-50"
                title={`Pull latest commits from GitHub ${project.repositoryLink.defaultBranch}`}
              >
                <RefreshCw size={13} className={syncingGitHub ? 'animate-spin' : ''} />
                {syncingGitHub ? 'Syncing…' : 'Sync with GitHub'}
              </button>
            )}
            <Link to={toWithProfile({ pathname: '/tasks/new', search: `?project=${encodeURIComponent(project.id)}` }, project.managerProfileId)} className="inline-flex h-9 items-center gap-2 rounded-lg bg-zinc-900 px-3.5 text-sm font-medium text-white dark:bg-zinc-100 dark:text-zinc-900"><Plus size={16} /> New task</Link>
          </div>
        </div>

        <nav aria-label="Project sections" className="mt-5 flex gap-1 overflow-x-auto border-b border-zinc-200 dark:border-zinc-800">
          <button type="button" aria-current={activeTab === 'board' ? 'page' : undefined} onClick={() => selectTab('board')} className={`h-10 shrink-0 border-b-2 px-3 text-sm font-medium ${activeTab === 'board' ? 'border-zinc-900 text-zinc-900 dark:border-zinc-100 dark:text-zinc-100' : 'border-transparent text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100'}`}>Board</button>
          <button type="button" aria-current={activeTab === 'code' ? 'page' : undefined} onClick={() => selectTab('code')} className={`h-10 shrink-0 border-b-2 px-3 text-sm font-medium ${activeTab === 'code' ? 'border-zinc-900 text-zinc-900 dark:border-zinc-100 dark:text-zinc-100' : 'border-transparent text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100'}`}>Code</button>
          <button type="button" aria-current={activeTab === 'references' ? 'page' : undefined} onClick={() => selectTab('references')} className={`h-10 shrink-0 border-b-2 px-3 text-sm font-medium ${activeTab === 'references' ? 'border-zinc-900 text-zinc-900 dark:border-zinc-100 dark:text-zinc-100' : 'border-transparent text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100'}`}>References</button>
          <button type="button" aria-current={activeTab === 'activity' ? 'page' : undefined} onClick={() => selectTab('activity')} className={`h-10 shrink-0 border-b-2 px-3 text-sm font-medium ${activeTab === 'activity' ? 'border-zinc-900 text-zinc-900 dark:border-zinc-100 dark:text-zinc-100' : 'border-transparent text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100'}`}>Activity</button>
          <button type="button" aria-current={activeTab === 'settings' ? 'page' : undefined} onClick={() => selectTab('settings')} className={`h-10 shrink-0 border-b-2 px-3 text-sm font-medium ${activeTab === 'settings' ? 'border-zinc-900 text-zinc-900 dark:border-zinc-100 dark:text-zinc-100' : 'border-transparent text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100'}`}>Settings</button>
        </nav>

        {activeTab === 'settings' && (
          <section className="mt-5 rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
            <h2 className="mb-3 text-sm font-semibold">Edit Project</h2>
            <div className="grid gap-3 sm:grid-cols-[minmax(0,280px)_minmax(0,1fr)_auto] sm:items-end">
              <label className="text-xs font-medium text-zinc-500">Name<input value={draftName} onChange={(event) => setDraftName(event.target.value)} maxLength={120} className="mt-1 h-9 w-full rounded-lg border border-zinc-200 bg-transparent px-3 text-sm dark:border-zinc-700" /></label>
              <label className="text-xs font-medium text-zinc-500">Purpose<textarea value={draftPurpose} onChange={(event) => setDraftPurpose(event.target.value)} maxLength={2000} rows={2} className="mt-1 w-full rounded-lg border border-zinc-200 bg-transparent px-3 py-2 text-sm dark:border-zinc-700" /></label>

              {installations.length > 0 && (
                <>
                  <label className="text-xs font-medium text-zinc-500">GitHub connection<select value={repositoryInstallationId ?? ''} onChange={(event) => setRepositoryInstallationId(Number(event.target.value) || null)} className="mt-1 h-9 w-full rounded-lg border border-zinc-200 bg-transparent px-3 text-sm dark:border-zinc-700"><option value="">No repository</option>{installations.map((installation) => <option key={installation.id} value={installation.id}>{installation.label}</option>)}</select></label>
                  <label className="text-xs font-medium text-zinc-500">Repository<select value={repositoryId ?? ''} disabled={!repositoryInstallationId} onChange={(event) => setRepositoryId(Number(event.target.value) || null)} className="mt-1 h-9 w-full rounded-lg border border-zinc-200 bg-transparent px-3 text-sm disabled:opacity-50 dark:border-zinc-700"><option value="">No repository</option>{selectableRepositories.map((repository) => <option key={repository.id} value={repository.id}>{repository.fullName}</option>)}</select></label>
                </>
              )}
              <div className="flex gap-2">
                <button type="button" disabled={busy || !draftName.trim() || !draftPurpose.trim()} onClick={() => void saveProject()} className="inline-flex h-9 items-center gap-2 rounded-lg bg-zinc-900 px-3 text-sm font-medium text-white disabled:opacity-40 dark:bg-zinc-100 dark:text-zinc-900"><Save size={14} /> Save</button>
              </div>
            </div>
          </section>
        )}

        {actionError && <div className="mt-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900/50 dark:bg-red-950/30 dark:text-red-300">{actionError}</div>}
        {syncMessage && <div className="mt-4 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700 dark:border-emerald-900/50 dark:bg-emerald-950/30 dark:text-emerald-300 flex items-center gap-2"><Check size={16} />{syncMessage}</div>}

        <div className="mt-6">
          {activeTab === 'board' && (
            <main className="min-w-0">
              <div className="mb-3"><h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">Project tasks</h2><p className="mt-1 text-xs text-zinc-500">Only tasks belonging to {project.name} appear here.</p></div>
              <TaskKanban tasks={tasks} taskRuns={taskRuns} createTaskTo={toWithProfile({ pathname: '/tasks/new', search: `?project=${encodeURIComponent(project.id)}` }, project.managerProfileId)} onMoveTask={moveProjectTask} onDeleteTask={deleteProjectTask} projectById={new Map([[project.id, project]])} className="flex min-h-[420px] gap-4 overflow-x-auto rounded-xl border border-zinc-200 bg-white p-4 sm:gap-6 dark:border-zinc-800 dark:bg-zinc-900" />
            </main>
          )}

          {activeTab === 'code' && (
            <main className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_420px]">
              <section className="rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div><h2 className="flex items-center gap-2 text-sm font-semibold"><GitBranch size={15} /> Project editor</h2><p className="mt-1 text-xs leading-5 text-zinc-500">One task may change this Project at a time. Other tasks can still plan and review.</p></div>
                  <div className="flex items-center gap-2">
                    {project.repositoryLink && (
                      <button
                        type="button"
                        disabled={syncingGitHub || busy}
                        onClick={() => void syncFromGitHub()}
                        className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 px-2.5 text-xs font-medium text-zinc-700 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-700 transition-colors disabled:opacity-50"
                        title={`Pull latest commits from GitHub ${project.repositoryLink.defaultBranch}`}
                      >
                        <RefreshCw size={12} className={syncingGitHub ? 'animate-spin' : ''} />
                        {syncingGitHub ? 'Syncing…' : 'Pull from GitHub'}
                      </button>
                    )}
                    {editor ? <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-1 text-[11px] font-medium text-emerald-700 dark:bg-emerald-950/30 dark:text-emerald-300"><Check size={12} /> Active</span> : <span className="rounded-full bg-zinc-100 px-2 py-1 text-[11px] text-zinc-500 dark:bg-zinc-800">Not started</span>}
                  </div>
                </div>
                {!project.repositoryLink && <p className="mt-4 rounded-lg border border-dashed border-zinc-200 p-3 text-xs text-zinc-500 dark:border-zinc-700">Connect a write-enabled GitHub repository in Settings first.</p>}
                {project.repositoryLink && !editor && <div className="mt-4 flex flex-col gap-2 sm:flex-row"><select aria-label="Code-writing task" value={editorTaskId} onChange={(event) => setEditorTaskId(event.target.value)} className="h-9 min-w-0 flex-1 rounded-lg border border-zinc-200 bg-transparent px-3 text-sm dark:border-zinc-700"><option value="">Choose the code-writing task</option>{tasks.map((task) => <option key={task.id} value={task.id}>{task.title}</option>)}</select><button type="button" disabled={busy || !editorTaskId} onClick={() => void beginEditing()} className="h-9 rounded-lg bg-zinc-900 px-3 text-sm font-medium text-white disabled:opacity-40 dark:bg-zinc-100 dark:text-zinc-900">Prepare editor</button></div>}
                {editor && <div className="mt-4 space-y-4">
                  <div className="rounded-lg bg-zinc-50 p-3 text-xs dark:bg-zinc-950/40"><p className="font-medium text-zinc-800 dark:text-zinc-200">{tasks.find((task) => task.id === editor.taskId)?.title ?? 'Assigned task'}</p><p className="mt-1 text-zinc-500">{codeStatus?.summary ?? 'Inspecting changes…'}</p></div>
                  {codeStatus && !codeStatus.clean && <><div><h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-400">Changed files</h3><ul className="mt-2 max-h-40 space-y-1 overflow-auto rounded-lg border border-zinc-200 p-2 font-mono text-xs dark:border-zinc-700">{codeStatus.changedFiles.map((file) => <li key={file} className="truncate">{file}</li>)}</ul></div><details className="rounded-lg border border-zinc-200 p-3 dark:border-zinc-700"><summary className="cursor-pointer text-xs font-medium">Review change preview</summary><pre className="mt-3 max-h-80 overflow-auto whitespace-pre-wrap break-words text-[11px] leading-5 text-zinc-600 dark:text-zinc-300">{codeStatus.diff || 'Binary or untracked files changed; review the file list above.'}</pre></details></>}
                  <div>
                    <div className="flex items-center justify-between mb-1">
                      <label className="block text-xs font-medium text-zinc-500">Checkpoint message</label>
                      <button
                        type="button"
                        disabled={busy || generatingMessage || !editor || !codeStatus || codeStatus.clean}
                        onClick={() => void autoGenerateMessage()}
                        className="inline-flex items-center gap-1 text-xs font-medium text-zinc-600 hover:text-zinc-900 disabled:opacity-40 dark:text-zinc-400 dark:hover:text-zinc-200"
                      >
                        <Sparkles size={12} className={generatingMessage ? 'animate-spin' : ''} />
                        {generatingMessage ? 'Generating…' : 'Auto-generate'}
                      </button>
                    </div>
                    <input
                      value={commitMessage}
                      onChange={(event) => setCommitMessage(event.target.value)}
                      maxLength={200}
                      placeholder="Describe what changed"
                      className="h-9 w-full rounded-lg border border-zinc-200 bg-transparent px-3 text-sm dark:border-zinc-700"
                    />
                    {project?.repositoryLink?.defaultBranch && (
                      <label className="flex items-center gap-2 pt-1 text-xs text-zinc-600 dark:text-zinc-400 cursor-pointer select-none">
                        <input
                          type="checkbox"
                          checked={deployToDefault}
                          onChange={(e) => setDeployToDefault(e.target.checked)}
                          className="rounded border-zinc-300 text-zinc-900 focus:ring-zinc-900 dark:border-zinc-700 dark:bg-zinc-800"
                        />
                        <span>
                          Deploy directly to <span className="font-semibold text-zinc-900 dark:text-zinc-100">{project.repositoryLink.defaultBranch}</span> (triggers Dokploy build)
                        </span>
                      </label>
                    )}
                  </div>
                  {pushStatus === 'pushing' && (
                    <div className="space-y-1.5 rounded-lg border border-zinc-200 bg-zinc-50/50 p-2.5 dark:border-zinc-800 dark:bg-zinc-950/30">
                      <div className="flex items-center justify-between text-xs text-zinc-600 dark:text-zinc-300">
                        <span className="inline-flex items-center gap-1.5 font-medium">
                          <Loader2 size={13} className="animate-spin text-zinc-900 dark:text-zinc-100" />
                          {deployToDefault && project?.repositoryLink?.defaultBranch ? 'Deploying to GitHub…' : 'Pushing to GitHub…'}
                        </span>
                        <span className="text-[11px] text-zinc-400">Uploading changes</span>
                      </div>
                      <div className="h-1.5 w-full overflow-hidden rounded-full bg-zinc-200/70 dark:bg-zinc-800">
                        <div className="h-full bg-zinc-900 dark:bg-zinc-100 rounded-full animate-pulse w-3/4" />
                      </div>
                    </div>
                  )}

                  {pushStatus === 'success' && (
                    <div className="flex items-center gap-2 rounded-lg border border-emerald-200/60 bg-emerald-50/70 p-2.5 text-xs font-medium text-emerald-800 dark:border-emerald-800/40 dark:bg-emerald-950/30 dark:text-emerald-300">
                      <Check size={14} className="shrink-0 text-emerald-600 dark:text-emerald-400" />
                      <span>
                        {deployToDefault && project?.repositoryLink?.defaultBranch
                          ? `Successfully committed and deployed to ${project.repositoryLink.defaultBranch}!${lastPushedSha ? ` (${lastPushedSha.slice(0, 7)})` : ''}`
                          : `Successfully committed and pushed to GitHub!${lastPushedSha ? ` (${lastPushedSha.slice(0, 7)})` : ''}`}
                      </span>
                    </div>
                  )}

                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      disabled={busy || !codeStatus || codeStatus.clean || !commitMessage.trim()}
                      onClick={() => void commitAndPush()}
                      className="inline-flex items-center gap-1.5 h-9 rounded-lg bg-zinc-900 px-3 text-sm font-medium text-white disabled:opacity-40 dark:bg-zinc-100 dark:text-zinc-900"
                    >
                      {pushStatus === 'pushing' ? (
                        <>
                          <Loader2 size={13} className="animate-spin" /> {deployToDefault && project?.repositoryLink?.defaultBranch ? 'Deploying…' : 'Pushing…'}
                        </>
                      ) : pushStatus === 'success' ? (
                        <>
                          <Check size={13} /> {deployToDefault && project?.repositoryLink?.defaultBranch ? 'Deployed!' : 'Pushed!'}
                        </>
                      ) : (
                        deployToDefault && project?.repositoryLink?.defaultBranch
                          ? `Commit & Deploy (${project.repositoryLink.defaultBranch})`
                          : 'Commit & Push'
                      )}
                    </button>
                    <button
                      type="button"
                      disabled={busy || !codeStatus?.clean}
                      onClick={() => void stopEditing()}
                      className="h-9 rounded-lg border border-zinc-200 px-3 text-sm font-medium disabled:opacity-40 dark:border-zinc-700"
                    >
                      Release editor
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void refreshCode(editor.taskId)}
                      className="h-9 rounded-lg border border-zinc-200 px-3 text-sm font-medium dark:border-zinc-700"
                    >
                      Refresh
                    </button>
                  </div>
                  <p className="text-[11px] leading-4 text-zinc-400">
                    {deployToDefault && project?.repositoryLink?.defaultBranch
                      ? `Commit & Deploy pushes directly to ${project.repositoryLink.defaultBranch} to trigger your deployment webhook.`
                      : 'Commit & Push updates only this Project’s protected working branch. It does not merge or deploy.'}
                  </p>
                </div>}
              </section>
              <section className="rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
                <h2 className="flex items-center gap-2 text-sm font-semibold"><History size={15} /> Version history</h2><p className="mt-1 text-xs leading-5 text-zinc-500">Every successful checkpoint stays visible. Restoring creates a new checkpoint and preserves this history.</p>
                <div className="mt-4 space-y-3">{versions.length === 0 && <p className="rounded-lg border border-dashed border-zinc-200 p-3 text-xs text-zinc-500 dark:border-zinc-700">No checkpoints yet.</p>}{versions.map((version) => <article key={version.id} className="rounded-lg border border-zinc-100 p-3 dark:border-zinc-800"><div className="flex items-start justify-between gap-2"><div className="min-w-0"><p className="truncate text-sm font-medium">{version.commitMessage}</p><p className="mt-1 text-[11px] text-zinc-400">{new Date(version.pushedAt).toLocaleString()} · {version.commitSha.slice(0, 7)} · {version.changedFiles.length} file{version.changedFiles.length === 1 ? '' : 's'}</p></div>{version.action === 'revert' && <span className="rounded bg-amber-50 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 dark:bg-amber-950/30 dark:text-amber-300">Restore</span>}</div><button type="button" disabled={busy || !editor || !codeStatus?.clean || versions[0]?.id === version.id} onClick={() => void restoreVersion(version)} className="mt-3 inline-flex h-8 items-center gap-1 rounded-lg border border-zinc-200 px-2 text-xs font-medium disabled:opacity-40 dark:border-zinc-700"><RotateCcw size={12} /> Revert to this version</button></article>)}</div>
              </section>
            </main>
          )}

          <aside className="grid gap-4 lg:grid-cols-2">
            {activeTab === 'settings' && (<>
            <section className="rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
              <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">Project owner & task routing</h2>
              <p className="mt-1 text-xs leading-5 text-zinc-500">Controls who owns this Project and becomes the default handler for new tasks.</p>
              <div className="mt-3 flex items-start justify-between gap-3 rounded-lg bg-zinc-50 px-3 py-2.5 dark:bg-zinc-950/40">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-zinc-800 dark:text-zinc-200">{project.manager.displayName}</p>
                  <p className="mt-0.5 text-xs text-zinc-500">{[project.manager.provider, project.manager.model].filter(Boolean).join(' · ') || 'Profile defaults'}</p>
                </div>
                <span className="shrink-0 rounded bg-zinc-200/70 px-2 py-1 text-[11px] font-medium text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">Current owner</span>
              </div>
              <label className="mt-3 block text-[11px] font-medium text-zinc-500">Reassign Project owner<select value={nextManager} onChange={(event) => setNextManager(event.target.value)} className="mt-1 h-9 w-full rounded-lg border border-zinc-200 bg-transparent px-2 text-sm dark:border-zinc-700">{profiles.filter((profile) => profile.active).map((profile) => <option key={profile.id} value={profile.id}>{profile.displayName}</option>)}</select></label>
              {nextManager !== project.managerProfileId && <label className="mt-2 block text-[11px] font-medium text-zinc-500">Previous owner keeps<select value={previousManagerRole} onChange={(event) => setPreviousManagerRole(event.target.value as typeof previousManagerRole)} className="mt-1 h-9 w-full rounded-lg border border-zinc-200 bg-transparent px-2 text-sm dark:border-zinc-700"><option value="none">No access</option><option value="view">View</option><option value="contribute">Contribute</option></select></label>}
              <button disabled={busy || nextManager === project.managerProfileId} onClick={() => void changeManager()} className="mt-2 h-8 w-full rounded-lg border border-zinc-200 text-xs font-medium disabled:opacity-40 dark:border-zinc-700">Reassign owner</button>
              <p className="mt-2 text-[11px] leading-4 text-zinc-400">Applies to future tasks. Active tasks keep their assigned handler unless explicitly transferred.</p>
            </section>
            <section className="rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
              <h2 className="flex items-center gap-2 text-sm font-semibold text-zinc-900 dark:text-zinc-100"><Shield size={15} /> Collaborators</h2>
              <p className="mt-1 text-xs leading-5 text-zinc-500">Give other profiles access without changing the Project owner or task routing.</p>
              <div className="mt-3 space-y-2">
                {grants.length === 0 && <p className="rounded-lg border border-dashed border-zinc-200 px-3 py-3 text-xs text-zinc-400 dark:border-zinc-800">No collaborators yet.</p>}
                {grants.map((grant) => <div key={grant.profileId} className="flex items-center gap-2 rounded-lg border border-zinc-100 px-3 py-2 text-xs dark:border-zinc-800"><span className="min-w-0 flex-1 truncate">{profileName(grant.profileId)}</span><span className="rounded bg-zinc-100 px-1.5 py-0.5 text-zinc-500 dark:bg-zinc-800">{grant.role}</span><button type="button" aria-label={`Revoke ${profileName(grant.profileId)}`} disabled={busy} onClick={() => void removeGrant(grant.profileId)} className="text-zinc-400 hover:text-red-600"><Trash2 size={13} /></button></div>)}
              </div>
              <div className="mt-3 grid gap-2 sm:grid-cols-[minmax(0,1fr)_140px]">
                <label className="text-[11px] font-medium text-zinc-500">Profile<select aria-label="Profile access" value={grantProfileId} onChange={(event) => setGrantProfileId(event.target.value)} className="mt-1 h-9 w-full min-w-0 rounded-lg border border-zinc-200 bg-transparent px-2 text-xs dark:border-zinc-700"><option value="">Choose profile</option>{eligibleGrantProfiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.displayName}</option>)}</select></label>
                <label className="text-[11px] font-medium text-zinc-500">Permission<select aria-label="Access role" value={grantRole} onChange={(event) => setGrantRole(event.target.value as ProjectAccessRole)} className="mt-1 h-9 w-full rounded-lg border border-zinc-200 bg-transparent px-2 text-xs dark:border-zinc-700">{accessRoles.map((role) => <option key={role} value={role}>{role}</option>)}</select></label>
              </div>
              <button type="button" disabled={busy || !grantProfileId} onClick={() => void saveGrant()} className="mt-2 h-8 w-full rounded-lg border border-zinc-200 text-xs font-medium disabled:opacity-40 dark:border-zinc-700">Grant access</button>
            </section>
            <section className="rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900"><h2 className="flex items-center gap-2 text-sm font-medium"><GitBranch size={15} /> Repository</h2>{project.repositoryLink ? <><a href={project.repositoryLink.htmlUrl} target="_blank" rel="noreferrer" className="mt-2 block truncate text-sm font-medium text-zinc-800 hover:underline dark:text-zinc-200">{project.repositoryLink.fullName}</a><p className="mt-1 text-xs text-zinc-500">{project.repositoryLink.defaultBranch} · protected branch · verified installation {project.repositoryLink.installationId}</p></> : <p className="mt-2 text-xs text-zinc-500">No repository selected.</p>}<Link to="/settings#github" className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-zinc-700 dark:text-zinc-300">GitHub setup <ExternalLink size={12} /></Link></section>
            </>)}
            {activeTab === 'references' && (
            <section className="w-full max-w-5xl rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900 lg:col-span-2">
              <h2 className="flex items-center gap-2 text-sm font-medium"><FileText size={15} /> References</h2>
              <p className="mt-1 text-[11px] leading-4 text-zinc-400">Originals are hashed and stored in Project-scoped storage; paths are never exposed.</p>
              <div className="mt-3">
                <input
                  id="project-reference-upload"
                  aria-label="Upload Project references"
                  disabled={uploadingReference}
                  type="file"
                  multiple
                  accept=".pdf,.docx,.txt,.md,.csv,.xlsx,.png,.jpg,.jpeg"
                  onChange={(event) => {
                    void uploadReferences(event.target.files);
                    event.target.value = '';
                  }}
                  className="peer sr-only"
                />
                <label
                  htmlFor="project-reference-upload"
                  aria-disabled={uploadingReference}
                  onDragEnter={(event) => {
                    event.preventDefault();
                    if (!uploadingReference) setReferenceDragActive(true);
                  }}
                  onDragOver={(event) => {
                    event.preventDefault();
                    event.dataTransfer.dropEffect = uploadingReference ? 'none' : 'copy';
                    if (!uploadingReference) setReferenceDragActive(true);
                  }}
                  onDragLeave={(event) => {
                    if (event.currentTarget.contains(event.relatedTarget as Node)) return;
                    setReferenceDragActive(false);
                  }}
                  onDrop={(event) => {
                    event.preventDefault();
                    setReferenceDragActive(false);
                    if (uploadingReference) {
                      setReferenceUploadStatus('Wait for the current upload to finish before adding more files');
                    } else {
                      void uploadReferences(event.dataTransfer.files);
                    }
                  }}
                  className={`flex min-h-32 w-full cursor-pointer flex-col items-center justify-center rounded-xl border-2 border-dashed px-5 py-6 text-center transition-colors peer-focus-visible:outline-none peer-focus-visible:ring-2 peer-focus-visible:ring-blue-500 peer-focus-visible:ring-offset-2 dark:peer-focus-visible:ring-offset-zinc-900 ${
                    referenceDragActive
                      ? 'border-blue-500 bg-blue-50 text-blue-700 dark:bg-blue-950/30 dark:text-blue-300'
                      : 'border-zinc-300 bg-zinc-50/70 text-zinc-600 hover:border-zinc-400 hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-950/40 dark:text-zinc-300 dark:hover:border-zinc-600'
                  } ${uploadingReference ? 'cursor-wait opacity-60' : ''}`}
                >
                  {uploadState ? (
                    <div className="flex flex-col items-center py-1">
                      <Loader2 size={26} className="animate-spin text-blue-600 dark:text-blue-400" />
                      <span className="mt-2 text-sm font-semibold text-zinc-800 dark:text-zinc-200">
                        {uploadState.phase === 'uploading'
                          ? `Uploading ${uploadState.filename}…`
                          : `Indexing & analyzing ${uploadState.filename}…`}
                      </span>
                      <span className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
                        {uploadState.phase === 'uploading'
                          ? `${uploadState.percent}% · Transferring file (${uploadState.index} of ${uploadState.total})`
                          : `Extracting text, OCR & search indexing (${uploadState.index} of ${uploadState.total})`}
                      </span>
                      {/* Visual Progress Bar */}
                      <div className="mt-3.5 w-64 max-w-full h-2 rounded-full bg-zinc-200 dark:bg-zinc-800 overflow-hidden">
                        <div
                          className={`h-full rounded-full transition-all duration-300 ${
                            uploadState.phase === 'indexing'
                              ? 'bg-emerald-500 animate-pulse w-full'
                              : 'bg-blue-600'
                          }`}
                          style={uploadState.phase === 'uploading' ? { width: `${Math.max(5, uploadState.percent)}%` } : undefined}
                        />
                      </div>
                      <div className="mt-2.5 flex items-center gap-3 text-[11px]">
                        <span className={`inline-flex items-center gap-1 ${uploadState.phase === 'uploading' ? 'font-semibold text-blue-600 dark:text-blue-400' : 'text-emerald-600 dark:text-emerald-400'}`}>
                          {uploadState.phase === 'indexing' ? '✔' : '●'} 1. Uploading
                        </span>
                        <span className="text-zinc-300 dark:text-zinc-600">→</span>
                        <span className={`inline-flex items-center gap-1 ${uploadState.phase === 'indexing' ? 'font-semibold text-emerald-600 dark:text-emerald-400' : 'text-zinc-400'}`}>
                          {uploadState.phase === 'indexing' ? <Loader2 size={10} className="animate-spin" /> : '○'} 2. Indexing
                        </span>
                      </div>
                    </div>
                  ) : (
                    <>
                      <UploadCloud size={24} strokeWidth={1.7} aria-hidden="true" />
                      <span className="mt-2 text-sm font-medium">
                        {referenceDragActive ? 'Drop files to upload' : 'Drop files here or click to browse'}
                      </span>
                      <span className="mt-1 text-xs text-zinc-400">PDF, DOCX, TXT/MD, CSV/XLSX, PNG/JPEG · 25 MB per file</span>
                    </>
                  )}
                </label>
                <p aria-live="polite" className="mt-2 min-h-4 text-xs text-zinc-500">{referenceUploadStatus}</p>
              </div>
              <div className="mt-3 flex gap-2">
                <input aria-label="Project reference search" value={referenceSearch} onChange={(event) => setReferenceSearch(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') void runReferenceSearch(); }} placeholder="Search references…" className="h-8 min-w-0 flex-1 rounded-lg border border-zinc-200 bg-transparent px-2 text-xs dark:border-zinc-700" />
                <button type="button" onClick={() => void runReferenceSearch()} className="h-8 rounded-lg border border-zinc-200 px-2 text-xs font-medium dark:border-zinc-700">Search</button>
              </div>
              <div className="mt-3 space-y-2">
                {references.length === 0 && <p className="text-xs text-zinc-500">No Project references uploaded yet.</p>}
                {references.map((reference) => <div key={reference.id} className="rounded-lg border border-zinc-100 p-2 text-xs dark:border-zinc-800"><div className="flex items-start justify-between gap-2"><div className="min-w-0"><a className="truncate font-medium text-zinc-700 underline-offset-2 hover:underline dark:text-zinc-200" href={projectReferenceDownloadUrl(project.id, reference.id)}>{reference.originalFilename}</a><p className="mt-0.5 text-[11px] text-zinc-400">{reference.status} · {Math.ceil(reference.sizeBytes / 1024)} KB · SHA-256 {reference.sha256.slice(0, 12)}…</p>{reference.error && <p className="mt-1 text-[11px] text-amber-600 dark:text-amber-300">{reference.error}</p>}</div><div className="flex shrink-0 gap-1"><button type="button" disabled={busy || reindexingId === reference.id} onClick={() => void reindexReference(reference.id)} className="rounded border border-zinc-200 px-1.5 py-0.5 text-[11px] dark:border-zinc-700 inline-flex items-center gap-1 hover:bg-zinc-50 dark:hover:bg-zinc-800 transition-colors disabled:opacity-50">{reindexingId === reference.id && <Loader2 size={10} className="animate-spin" />}{reindexingId === reference.id ? 'Indexing…' : 'Reindex'}</button><button type="button" aria-label={`Delete ${reference.originalFilename}`} disabled={busy} onClick={() => void removeReference(reference.id)} className="text-zinc-400 hover:text-red-600"><Trash2 size={13} /></button></div></div></div>)}
              </div>
              {referenceResults.length > 0 && <div className="mt-3 space-y-2 border-t border-zinc-100 pt-3 dark:border-zinc-800"><h3 className="text-[11px] font-semibold uppercase tracking-wide text-zinc-400">Citations</h3>{referenceResults.map((result) => <div key={result.chunkId} className="text-xs text-zinc-500"><span className="font-medium text-zinc-700 dark:text-zinc-300">{result.citation.originalFilename}</span><span> · chunk {result.citation.chunkIndex + 1}{result.citation.pageNumber ? ` · page ${result.citation.pageNumber}` : ''}{result.citation.sheetName ? ` · ${result.citation.sheetName}` : ''}{result.citation.cellRange ? ` · ${result.citation.cellRange}` : ''}</span><p className="mt-1">{result.snippet.replace(/<\/?mark>/g, '')}</p></div>)}</div>}
            </section>
            )}
            {activeTab === 'activity' && (
            <section className="w-full max-w-3xl rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900 lg:col-span-2"><h2 className="text-xs font-semibold uppercase tracking-wide text-zinc-400">Manager history</h2><p className="mt-1 text-xs text-zinc-500">Recorded Project ownership changes. Active task handlers remain immutable unless explicitly transferred.</p><div className="mt-2 space-y-2">{history.map((entry) => <div key={entry.id} className="text-xs text-zinc-500"><span className="font-medium text-zinc-700 dark:text-zinc-300">{profileName(entry.profileId)}</span><br />{new Date(entry.effectiveFrom).toLocaleString()}{entry.effectiveTo ? ` – ${new Date(entry.effectiveTo).toLocaleString()}` : ' – current'}</div>)}</div></section>
            )}
          </aside>
        </div>
      </div>
    </div>
  );
}