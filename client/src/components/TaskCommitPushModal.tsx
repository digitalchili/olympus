import { useEffect, useState } from 'react';
import {
  AlertCircle,
  Check,
  CheckCircle2,
  FileCode2,
  GitCommitHorizontal,
  Loader2,
  Sparkles,
  X,
} from 'lucide-react';
import type { ProjectRepositoryLink, ProjectVersion, PublicProjectEditorLease } from '@shared/types';
import {
  commitPushProject,
  generateProjectCommitMessage,
  fetchProjectEditorStatus,
  prepareProjectEditor,
  type ProjectGitStatus,
} from '../lib/api';
import { toErrorMessage } from '../lib/format';

interface TaskCommitPushModalProps {
  open: boolean;
  onClose: () => void;
  projectId: string;
  taskId: string;
  taskTitle: string;
  repositoryLink: ProjectRepositoryLink;
  onCommitted?: (version: ProjectVersion) => void;
}

export function TaskCommitPushModal({
  open,
  onClose,
  projectId,
  taskId,
  taskTitle: _taskTitle,
  repositoryLink,
  onCommitted,
}: TaskCommitPushModalProps) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editor, setEditor] = useState<PublicProjectEditorLease | null>(null);
  const [codeStatus, setCodeStatus] = useState<ProjectGitStatus | null>(null);
  const [commitMessage, setCommitMessage] = useState('');
  const [generatingMessage, setGeneratingMessage] = useState(false);
  const [deployToDefault, setDeployToDefault] = useState(Boolean(repositoryLink.defaultBranch));
  const [pushStatus, setPushStatus] = useState<'idle' | 'pushing' | 'success'>('idle');
  const [lastPushedSha, setLastPushedSha] = useState<string | null>(null);

  const loadStatus = async () => {
    setLoading(true);
    setError(null);
    try {
      const prepRes = await prepareProjectEditor(projectId, taskId);
      setEditor(prepRes.editor);
      const statusRes = await fetchProjectEditorStatus(projectId, taskId);
      setCodeStatus(statusRes.status);
    } catch (cause) {
      setError(toErrorMessage(cause, 'Could not inspect project changes'));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (open) {
      setPushStatus('idle');
      setLastPushedSha(null);
      setError(null);
      void loadStatus();
    } else {
      setEditor(null);
      setCodeStatus(null);
      setCommitMessage('');
    }
  }, [open, projectId, taskId]);

  const handleAutoGenerate = async () => {
    if (!codeStatus || codeStatus.clean || generatingMessage) return;
    setGeneratingMessage(true);
    setError(null);
    try {
      const res = await generateProjectCommitMessage(projectId, taskId);
      if (res.message) setCommitMessage(res.message);
    } catch (cause) {
      setError(toErrorMessage(cause, 'Could not generate commit message'));
    } finally {
      setGeneratingMessage(false);
    }
  };

  const handleCommitAndPush = async () => {
    if (!codeStatus || codeStatus.clean || !commitMessage.trim() || pushStatus === 'pushing') return;
    setPushStatus('pushing');
    setError(null);
    try {
      const result = await commitPushProject(
        projectId,
        taskId,
        commitMessage.trim(),
        deployToDefault && Boolean(repositoryLink.defaultBranch),
      );
      setLastPushedSha(result.version?.commitSha ?? null);
      setPushStatus('success');
      onCommitted?.(result.version);
      setTimeout(() => {
        onClose();
      }, 1600);
    } catch (cause) {
      setPushStatus('idle');
      setError(toErrorMessage(cause, 'Commit & Push failed; your changes remain available to retry'));
    }
  };

  if (!open) return null;

  const targetBranch =
    deployToDefault && repositoryLink.defaultBranch
      ? repositoryLink.defaultBranch
      : editor?.branchName ?? 'feature branch';

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label="Commit and Push changes"
    >
      <div className="flex max-h-[90vh] w-full max-w-xl flex-col overflow-hidden rounded-xl border border-zinc-200 bg-white shadow-2xl dark:border-zinc-800 dark:bg-zinc-900">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-zinc-100 px-5 py-4 dark:border-zinc-800">
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-200">
              <GitCommitHorizontal size={17} strokeWidth={2.2} />
            </div>
            <div className="min-w-0">
              <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
                Commit & Push to GitHub
              </h2>
              <p className="truncate text-xs text-zinc-500 dark:text-zinc-400">
                {repositoryLink.fullName} · Target: <span className="font-mono font-medium text-zinc-700 dark:text-zinc-300">{targetBranch}</span>
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={pushStatus === 'pushing'}
            className="rounded-md p-1 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-600 disabled:opacity-40 dark:text-zinc-500 dark:hover:bg-zinc-800 dark:hover:text-zinc-300"
            aria-label="Close"
          >
            <X size={17} />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-5 space-y-4 text-xs">
          {loading && (
            <div className="flex items-center justify-center gap-2.5 py-12 text-zinc-500">
              <Loader2 size={18} className="animate-spin text-zinc-900 dark:text-zinc-100" />
              <span>Inspecting repository changes…</span>
            </div>
          )}

          {error && (
            <div className="flex items-start gap-2.5 rounded-lg border border-red-200 bg-red-50 p-3 text-red-800 dark:border-red-900/50 dark:bg-red-950/30 dark:text-red-300">
              <AlertCircle size={15} className="mt-0.5 shrink-0 text-red-600 dark:text-red-400" />
              <div className="flex-1">
                <p className="font-medium">{error}</p>
                <button
                  type="button"
                  onClick={() => void loadStatus()}
                  className="mt-2 font-semibold underline hover:no-underline"
                >
                  Retry
                </button>
              </div>
            </div>
          )}

          {!loading && !error && codeStatus && codeStatus.clean && (
            <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-zinc-200 py-10 text-center dark:border-zinc-800">
              <div className="flex h-10 w-10 items-center justify-center rounded-full bg-emerald-50 text-emerald-600 dark:bg-emerald-950/40 dark:text-emerald-400">
                <CheckCircle2 size={20} />
              </div>
              <h3 className="mt-3 text-sm font-semibold text-zinc-900 dark:text-zinc-100">
                Working tree is clean
              </h3>
              <p className="mt-1 max-w-sm text-xs text-zinc-500 dark:text-zinc-400">
                No uncommitted file changes were detected for this task. Any previous changes are already up to date on GitHub.
              </p>
            </div>
          )}

          {!loading && !error && codeStatus && !codeStatus.clean && (
            <>
              {/* Changed files summary */}
              <div>
                <div className="flex items-center justify-between">
                  <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
                    Changed files ({codeStatus.changedFiles.length})
                  </h3>
                  {editor?.branchName && (
                    <span className="text-[11px] text-zinc-400">
                      Branch: {editor.branchName}
                    </span>
                  )}
                </div>
                <ul className="mt-2 max-h-36 space-y-1 overflow-auto rounded-lg border border-zinc-200 p-2 font-mono text-xs dark:border-zinc-700 bg-zinc-50/50 dark:bg-zinc-950/40">
                  {codeStatus.changedFiles.map((file: string) => (
                    <li key={file} className="flex items-center gap-1.5 truncate text-zinc-700 dark:text-zinc-300">
                      <FileCode2 size={13} className="shrink-0 text-zinc-400" />
                      <span className="truncate">{file}</span>
                    </li>
                  ))}
                </ul>
              </div>

              {/* Diff Preview */}
              <details className="rounded-lg border border-zinc-200 p-2.5 dark:border-zinc-700">
                <summary className="cursor-pointer text-xs font-medium text-zinc-600 dark:text-zinc-400 select-none hover:text-zinc-900 dark:hover:text-zinc-200">
                  Review change preview
                </summary>
                <pre className="mt-2.5 max-h-44 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-5 text-zinc-600 dark:text-zinc-300 bg-zinc-50 dark:bg-zinc-950 p-2 rounded">
                  {codeStatus.diff || 'Binary or untracked files changed; review the file list above.'}
                </pre>
              </details>

              {/* Commit Message */}
              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <label className="text-xs font-medium text-zinc-700 dark:text-zinc-300">
                    Commit message
                  </label>
                  <button
                    type="button"
                    disabled={generatingMessage || pushStatus === 'pushing'}
                    onClick={() => void handleAutoGenerate()}
                    className="inline-flex items-center gap-1 text-xs font-medium text-zinc-600 hover:text-zinc-900 disabled:opacity-40 dark:text-zinc-400 dark:hover:text-zinc-200"
                  >
                    <Sparkles size={12} className={generatingMessage ? 'animate-spin' : ''} />
                    {generatingMessage ? 'Generating…' : 'Auto-generate'}
                  </button>
                </div>
                <input
                  type="text"
                  value={commitMessage}
                  onChange={(e) => setCommitMessage(e.target.value)}
                  disabled={pushStatus === 'pushing'}
                  maxLength={200}
                  placeholder="Describe what changed (e.g. feat: update checkout flow)"
                  className="h-9 w-full rounded-lg border border-zinc-200 bg-transparent px-3 text-sm text-zinc-900 placeholder:text-zinc-400 focus:border-zinc-900 focus:outline-none dark:border-zinc-700 dark:text-zinc-100 dark:focus:border-zinc-100"
                />
              </div>

              {/* Deployment Option */}
              {repositoryLink.defaultBranch && (
                <div className="rounded-lg border border-zinc-100 bg-zinc-50/60 p-3 dark:border-zinc-800 dark:bg-zinc-950/40">
                  <label className="flex items-start gap-2 text-xs text-zinc-700 dark:text-zinc-300 cursor-pointer select-none">
                    <input
                      type="checkbox"
                      checked={deployToDefault}
                      onChange={(e) => setDeployToDefault(e.target.checked)}
                      disabled={pushStatus === 'pushing'}
                      className="mt-0.5 rounded border-zinc-300 text-zinc-900 focus:ring-zinc-900 dark:border-zinc-700 dark:bg-zinc-800"
                    />
                    <div>
                      <span>
                        Deploy directly to <span className="font-semibold text-zinc-900 dark:text-zinc-100">{repositoryLink.defaultBranch}</span> (triggers Dokploy build)
                      </span>
                      <p className="mt-0.5 text-[11px] text-zinc-400 leading-normal">
                        {deployToDefault
                          ? `Pushes directly to ${repositoryLink.defaultBranch} to trigger your deployment webhook.`
                          : `Updates only this Project’s working branch (${editor?.branchName ?? 'working branch'}). Does not merge or deploy.`}
                      </p>
                    </div>
                  </label>
                </div>
              )}
            </>
          )}

          {/* Pushing state indicator */}
          {pushStatus === 'pushing' && (
            <div className="space-y-2 rounded-lg border border-zinc-200 bg-zinc-50/70 p-3 dark:border-zinc-800 dark:bg-zinc-950/50">
              <div className="flex items-center justify-between text-xs text-zinc-700 dark:text-zinc-300">
                <span className="inline-flex items-center gap-1.5 font-medium">
                  <Loader2 size={14} className="animate-spin text-zinc-900 dark:text-zinc-100" />
                  {deployToDefault && repositoryLink.defaultBranch ? 'Deploying to GitHub…' : 'Pushing to GitHub…'}
                </span>
                <span className="text-[11px] text-zinc-400">Uploading changes</span>
              </div>
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-zinc-200/70 dark:bg-zinc-800">
                <div className="h-full bg-zinc-900 dark:bg-zinc-100 rounded-full animate-pulse w-3/4" />
              </div>
            </div>
          )}

          {/* Success state indicator */}
          {pushStatus === 'success' && (
            <div className="flex items-center gap-2 rounded-lg border border-emerald-200/60 bg-emerald-50/80 p-3 text-xs font-medium text-emerald-800 dark:border-emerald-800/40 dark:bg-emerald-950/30 dark:text-emerald-300">
              <Check size={15} className="shrink-0 text-emerald-600 dark:text-emerald-400" />
              <span>
                {deployToDefault && repositoryLink.defaultBranch
                  ? `Successfully committed and deployed to ${repositoryLink.defaultBranch}!${lastPushedSha ? ` (${lastPushedSha.slice(0, 7)})` : ''}`
                  : `Successfully committed and pushed to GitHub!${lastPushedSha ? ` (${lastPushedSha.slice(0, 7)})` : ''}`}
              </span>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2.5 border-t border-zinc-100 bg-zinc-50/50 px-5 py-3 dark:border-zinc-800 dark:bg-zinc-950/30">
          <button
            type="button"
            onClick={onClose}
            disabled={pushStatus === 'pushing'}
            className="h-8.5 rounded-lg border border-zinc-200 px-3 text-xs font-medium text-zinc-700 hover:bg-zinc-100 disabled:opacity-40 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
          >
            {codeStatus?.clean ? 'Close' : 'Cancel'}
          </button>
          {!codeStatus?.clean && (
            <button
              type="button"
              disabled={loading || Boolean(error) || pushStatus === 'pushing' || !commitMessage.trim()}
              onClick={() => void handleCommitAndPush()}
              className="inline-flex h-8.5 items-center gap-1.5 rounded-lg bg-zinc-900 px-3.5 text-xs font-semibold text-white transition hover:bg-zinc-800 disabled:opacity-40 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
            >
              {pushStatus === 'pushing' ? (
                <>
                  <Loader2 size={13} className="animate-spin" />
                  {deployToDefault && repositoryLink.defaultBranch ? 'Deploying…' : 'Pushing…'}
                </>
              ) : pushStatus === 'success' ? (
                <>
                  <Check size={13} />
                  {deployToDefault && repositoryLink.defaultBranch ? 'Deployed!' : 'Pushed!'}
                </>
              ) : (
                <>
                  <GitCommitHorizontal size={14} />
                  {deployToDefault && repositoryLink.defaultBranch
                    ? `Commit & Deploy (${repositoryLink.defaultBranch})`
                    : 'Commit & Push'}
                </>
              )}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
