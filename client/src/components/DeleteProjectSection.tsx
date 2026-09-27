import { useRef, useState } from 'react';
import { Trash2 } from 'lucide-react';
import { ApiError, deleteProject } from '../lib/api';
import { toErrorMessage } from '../lib/format';
import { DeleteConfirmModal } from './DeleteConfirmModal';

interface Props {
  projectId: string;
  projectName: string;
  disabled?: boolean;
  onDeleted: () => void;
}

export function DeleteProjectSection({ projectId, projectName, disabled = false, onDeleted }: Props) {
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cleanupPending, setCleanupPending] = useState(false);
  const pending = useRef(false);

  const remove = async () => {
    if (disabled || pending.current) return;
    pending.current = true;
    setDeleting(true);
    setError(null);
    try {
      await deleteProject(projectId);
      onDeleted();
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 404) { onDeleted(); return; }
      if (cause instanceof ApiError && cause.code === 'PROJECT_CLEANUP_PENDING') setCleanupPending(true);
      setError(toErrorMessage(cause, 'Could not delete Project'));
      pending.current = false;
      setDeleting(false);
    }
  };

  return (
    <section className="rounded-xl border border-red-200 bg-white p-4 dark:border-red-900/60 dark:bg-zinc-900 lg:col-span-2">
      <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">Delete Project</h2>
      <p className="mt-1 text-xs leading-5 text-zinc-500">Permanently remove this Project, all its tasks and their local project copies, task files, references and previews to free disk space. The GitHub repository is kept.</p>
      <button
        type="button"
        disabled={disabled || deleting}
        onClick={() => { setError(null); setConfirming(true); }}
        className="mt-3 inline-flex h-9 items-center gap-2 rounded-lg bg-red-600 px-3 text-sm font-medium text-white hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-50"
      >
        <Trash2 size={14} /> Delete Project
      </button>
      {confirming && <DeleteConfirmModal
        title={cleanupPending ? 'Finish disk cleanup' : 'Delete Project'}
        body={cleanupPending
          ? 'The Project and its tasks have been deleted. Retry to remove the remaining local files and free their disk space. You can also retry from the Projects page.'
          : `Permanently delete “${projectName}” and all its tasks, settings and version history? Olympus will remove its local project copies, task files, uploaded references and saved previews. Local changes not pushed to GitHub will be lost. The GitHub repository, Hermes session history and shared or manually selected folders are kept. This cannot be undone.`}
        confirmLabel={cleanupPending ? 'Retry cleanup' : 'Delete Project'}
        cancelLabel={cleanupPending ? 'Back to Projects' : 'Cancel'}
        isConfirming={deleting}
        error={error}
        onConfirm={() => void remove()}
        onCancel={() => { if (!pending.current) { if (cleanupPending) onDeleted(); else setConfirming(false); } }}
      />}
    </section>
  );
}
