import { useRef } from 'react';
import { Download, FileText, Image as ImageIcon, Loader2, Paperclip, RotateCcw, X } from 'lucide-react';
import { fileDownloadUrl, filePreviewUrl } from '../lib/api';
import { BASE } from '../lib/api';
import { apiPathWithProfile } from '../lib/profileQuery';
import { formatBytes } from '../lib/format';
import type { PendingFile } from '../hooks/useFileAttachments';
import type { TaskAttachment } from '@shared/types';

export function AttachmentTray({
  files,
  onRemove,
  onRetry,
}: {
  files: PendingFile[];
  onRemove: (id: string) => void;
  onRetry?: (id: string) => void;
}) {
  if (files.length === 0) return null;

  return (
    <div className="flex flex-wrap gap-2 px-4 py-2">
      {files.map((f) => {
        const statusText = f.status === 'uploading'
          ? 'Uploading'
          : f.status === 'error'
            ? 'Upload failed'
            : formatBytes(f.file.size);

        return (
          <div
            key={f.id}
            className={`group flex items-center gap-2 rounded-lg border px-2.5 py-1.5 text-xs ${
              f.status === 'error'
                ? 'border-red-200 bg-red-50 dark:border-red-900/60 dark:bg-red-950/20'
                : 'border-zinc-200 bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900'
            }`}
          >
            {f.previewUrl ? (
              <img src={f.previewUrl} alt={f.file.name} className="h-8 w-8 rounded object-cover" />
            ) : (
              <FileText size={14} className="shrink-0 text-zinc-400" />
            )}
            <div className="min-w-0">
              <span className="block max-w-[120px] truncate font-medium text-zinc-700 dark:text-zinc-300">
                {f.file.name}
              </span>
              <span className={f.status === 'error' ? 'text-red-500' : 'text-zinc-400 dark:text-zinc-500'}>
                {statusText}
              </span>
            </div>
            {f.status === 'uploading' && <Loader2 size={12} className="shrink-0 animate-spin text-zinc-400" />}
            {f.status === 'error' && onRetry && (
              <button
                type="button"
                onClick={() => onRetry(f.id)}
                aria-label={`Retry ${f.file.name}`}
                title={`Retry ${f.file.name}`}
                className="shrink-0 rounded-md p-0.5 text-red-400 hover:bg-red-100 hover:text-red-600 dark:hover:bg-red-900/50"
              >
                <RotateCcw size={12} />
              </button>
            )}
            <button
              type="button"
              onClick={() => onRemove(f.id)}
              aria-label={`Remove ${f.file.name}`}
              className="shrink-0 rounded-md p-0.5 text-zinc-400 hover:bg-zinc-200 hover:text-zinc-700 dark:hover:bg-zinc-700 dark:hover:text-zinc-200"
            >
              <X size={12} />
            </button>
          </div>
        );
      })}
    </div>
  );
}

const IMAGE_EXTENSION = /\.(avif|gif|jpe?g|png|svg|webp)$/i;
const PDF_EXTENSION = /\.pdf$/i;

function attachmentName(path: string): string {
  const name = path.split('/').pop() || 'Attachment';
  return name.replace(/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}-/i, '');
}

/** Attachment cards for persisted messages. File paths remain in the stored text
 * for Hermes, but are replaced in the chat UI with a useful visual reference. */
export function MessageAttachmentCards({
  paths = [],
  taskId,
  attachments = [],
}: {
  paths?: string[];
  taskId?: string;
  attachments?: TaskAttachment[];
}) {
  const items = attachments.length > 0
    ? attachments
    : paths.map((path) => ({ path, name: attachmentName(path), size: 0 }));
  if (items.length === 0) return null;

  return (
    <div className="mt-2 flex flex-wrap gap-2">
      {items.map((attachment) => {
        const { path, name } = attachment;
        const isImage = IMAGE_EXTENSION.test(name);
        const isPdf = PDF_EXTENSION.test(name);
        const downloadUrl = taskId
          ? `${BASE}${apiPathWithProfile(`/tasks/${encodeURIComponent(taskId)}/artifacts/download?path=${encodeURIComponent(path)}`)}`
          : fileDownloadUrl(path);
        return (
          <a
            key={path}
            href={downloadUrl}
            download={name}
            title={`Download ${name}`}
            className="group flex w-36 overflow-hidden rounded-lg border border-zinc-200 bg-white text-left shadow-sm transition-colors hover:border-zinc-300 hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900 dark:hover:border-zinc-600 dark:hover:bg-zinc-800"
          >
            <div className="flex h-20 w-20 shrink-0 items-center justify-center overflow-hidden bg-zinc-100 dark:bg-zinc-800">
              {isImage && !taskId ? (
                <img src={filePreviewUrl(path)} alt="" className="h-full w-full object-cover" />
              ) : isPdf ? (
                <FileText size={28} className="text-red-400" />
              ) : (
                <ImageIcon size={24} className="text-zinc-400 dark:text-zinc-500" />
              )}
            </div>
            <div className="flex min-w-0 flex-1 flex-col justify-between p-2">
              <span className="line-clamp-2 text-[11px] font-medium leading-4 text-zinc-700 dark:text-zinc-200">{name}</span>
              <span className="mt-1 inline-flex items-center gap-1 text-[10px] text-zinc-400 dark:text-zinc-500">
                <Download size={10} /> {isPdf ? 'PDF' : isImage ? 'Image' : 'File'}
              </span>
            </div>
          </a>
        );
      })}
    </div>
  );
}

export function AttachButton({ onFiles, disabled = false }: { onFiles: (files: FileList) => void; disabled?: boolean }) {
  const inputRef = useRef<HTMLInputElement>(null);

  return (
    <>
      <input
        ref={inputRef}
        type="file"
        multiple
        onChange={(e) => {
          if (e.target.files?.length) onFiles(e.target.files);
          e.target.value = '';
        }}
        className="hidden"
      />
      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        disabled={disabled}
        title="Attach files"
        aria-label="Attach files"
        className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-zinc-200 bg-white text-zinc-500 shadow-sm transition-colors hover:bg-zinc-50 hover:text-zinc-700 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-400 dark:hover:bg-zinc-700/70 dark:hover:text-zinc-200"
      >
        <Paperclip size={14} />
      </button>
    </>
  );
}

export function UploadErrorBar({ error, onDismiss }: { error: string; onDismiss: () => void }) {
  return (
    <div className="flex items-center gap-2 px-4 pb-2 text-xs text-red-500">
      <span className="min-w-0 truncate">{error}</span>
      <button type="button" onClick={onDismiss} className="shrink-0 text-red-400 hover:text-red-600">
        <X size={12} />
      </button>
    </div>
  );
}

export function AttachDropOverlay() {
  return (
    <div className="pointer-events-none absolute inset-0 z-50 flex items-center justify-center rounded-xl border-2 border-dashed border-zinc-400 bg-zinc-100/80 dark:border-zinc-500 dark:bg-zinc-900/80">
      <span className="text-sm font-medium text-zinc-600 dark:text-zinc-300">Drop files to attach</span>
    </div>
  );
}
