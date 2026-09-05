import { useCallback, useEffect, useRef, useState, type ClipboardEvent, type DragEvent, type RefObject } from 'react';
import { deleteFileEntry, uploadChatAttachment } from '../lib/api';
import { attachmentMessage, toErrorMessage } from '../lib/format';
import { createUuid } from '../lib/uuid';
import { failedUpload, retryUpload, uploadBlocksSend as filesBlockSend } from '../lib/upload-recovery';
import {
  createClipboardTextAttachment,
  restoreClipboardAttachmentInline,
  shouldAttachClipboardText,
  type ClipboardTextAttachmentMetadata,
} from '../lib/largePasteAttachments';

export type PendingFile = {
  id: string;
  file: File;
  previewUrl: string | null;
  status: 'uploading' | 'uploaded' | 'error';
  uploadedPath?: string;
  error?: string;
  textAttachment?: ClipboardTextAttachmentMetadata;
};

type ControlledTextInput = {
  value: string;
  setValue: (value: string, cursor?: number | null) => void;
  inputRef?: RefObject<HTMLTextAreaElement | null>;
};

// Backstop so a stalled connection eventually fails (surfacing a retry) instead
// of leaving a file pinned in 'uploading' — and Send disabled — forever.
const UPLOAD_TIMEOUT_MS = 5 * 60_000;

function createObjectUrl(file: File): string | null {
  if (typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') return null;
  return URL.createObjectURL(file);
}

function revokePreviews(files: PendingFile[]) {
  files.forEach((f) => {
    if (f.previewUrl && typeof URL !== 'undefined' && typeof URL.revokeObjectURL === 'function') {
      URL.revokeObjectURL(f.previewUrl);
    }
  });
}

/**
 * Manages a list of files staged for upload, with image previews and the
 * drag/drop + paste handlers used by the chat composers. Object URLs are
 * revoked on removal and on unmount.
 */
export function useFileAttachments(uploadBucketId: string, controlledInput?: ControlledTextInput) {
  const [pendingFiles, setPendingFiles] = useState<PendingFile[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const uploadControllersRef = useRef(new Map<string, AbortController>());
  const controlledInputRef = useRef(controlledInput);

  useEffect(() => {
    controlledInputRef.current = controlledInput;
  }, [controlledInput]);

  const startUpload = useCallback((pendingFile: PendingFile) => {
    const controller = new AbortController();
    uploadControllersRef.current.set(pendingFile.id, controller);
    const timeout = setTimeout(
      () => controller.abort(new DOMException('Upload timed out', 'TimeoutError')),
      UPLOAD_TIMEOUT_MS,
    );

    void uploadChatAttachment(uploadBucketId, pendingFile.id, pendingFile.file, controller.signal)
      .then((uploadedPath) => {
        setPendingFiles((prev) => prev.map((file) => (
          file.id === pendingFile.id
            ? { ...file, status: 'uploaded', uploadedPath, error: undefined }
            : file
        )));
      })
      .catch((err) => {
        const reason = controller.signal.reason;
        const timedOut = reason instanceof DOMException && reason.name === 'TimeoutError';
        // A user-initiated remove/clear aborts with no reason; leave that file alone.
        if (controller.signal.aborted && !timedOut) return;
        const message = timedOut
          ? `Upload timed out: ${pendingFile.file.name}`
          : toErrorMessage(err, `Failed to upload ${pendingFile.file.name}`);
        setPendingFiles((prev) => prev.map((file) => (
          file.id === pendingFile.id
            ? failedUpload(file, message)
            : file
        )));
        setUploadError(message);
      })
      .finally(() => {
        clearTimeout(timeout);
        // Only clear the entry if a newer upload (e.g. a retry) hasn't replaced it.
        if (uploadControllersRef.current.get(pendingFile.id) === controller) {
          uploadControllersRef.current.delete(pendingFile.id);
        }
      });
  }, [uploadBucketId]);

  const addPendingFiles = useCallback((next: PendingFile[]) => {
    if (next.length === 0) return;

    // Keep a still-relevant failure banner up; only clear it when nothing is failed.
    if (!pendingFiles.some((file) => file.status === 'error')) setUploadError(null);
    setPendingFiles((prev) => [...prev, ...next]);
    next.forEach(startUpload);
  }, [pendingFiles, startUpload]);

  const addFiles = useCallback((files: FileList | File[]) => {
    const next: PendingFile[] = Array.from(files).map((file) => ({
      id: createUuid(),
      file,
      previewUrl: file.type.startsWith('image/') ? createObjectUrl(file) : null,
      status: 'uploading',
    }));
    addPendingFiles(next);
  }, [addPendingFiles]);

  const removeFile = useCallback((id: string) => {
    uploadControllersRef.current.get(id)?.abort();
    uploadControllersRef.current.delete(id);
    const target = pendingFiles.find((f) => f.id === id);
    revokePreviews(target ? [target] : []);
    // The file was already uploaded to the workspace; drop the server copy too.
    if (target?.uploadedPath) void deleteFileEntry(target.uploadedPath, false).catch(() => {});
    setPendingFiles((prev) => prev.filter((f) => f.id !== id));
    if (!pendingFiles.some((f) => f.id !== id && f.status === 'error')) setUploadError(null);
  }, [pendingFiles]);

  const retryFile = useCallback((id: string) => {
    setUploadError(null);
    const target = pendingFiles.find((file) => file.id === id);
    if (!target) return;

    const retryTarget: PendingFile = retryUpload(target);
    setPendingFiles((prev) => prev.map((file) => file.id === id ? retryTarget : file));
    startUpload(retryTarget);
  }, [pendingFiles, startUpload]);

  const restoreTextFile = useCallback((id: string) => {
    const target = pendingFiles.find((file) => file.id === id);
    const textInput = controlledInputRef.current;
    if (!target?.textAttachment || !textInput) return;

    const restored = restoreClipboardAttachmentInline({
      currentValue: textInput.value,
      snapshotValue: target.textAttachment.snapshotValue ?? textInput.value,
      selectionStart: target.textAttachment.selectionStart ?? textInput.value.length,
      selectionEnd: target.textAttachment.selectionEnd ?? textInput.value.length,
      text: target.textAttachment.text,
    });
    removeFile(id);
    textInput.setValue(restored.value, restored.cursor);
    const applySelection = () => {
      const input = textInput.inputRef?.current;
      input?.focus();
      input?.setSelectionRange(restored.cursor, restored.cursor);
    };
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(applySelection);
    else setTimeout(applySelection, 0);
  }, [pendingFiles, removeFile]);

  // Clear the tray (after a send, or when leaving the view). Aborts in-flight
  // uploads and revokes previews, but leaves already-uploaded server copies
  // alone — only an explicit remove (the X) deletes the server file.
  const clearFiles = useCallback(() => {
    uploadControllersRef.current.forEach((controller) => controller.abort());
    uploadControllersRef.current.clear();
    setPendingFiles((prev) => {
      revokePreviews(prev);
      return [];
    });
  }, []);

  useEffect(() => clearFiles, [clearFiles]);

  // Uploads finish (or fail) before Send is enabled, so this just gathers the
  // already-uploaded paths. Callers gate Send on uploadBlocksSend, so every
  // remaining file here has an uploadedPath.
  const submitWithAttachments = useCallback((text: string): string => {
    if (pendingFiles.length === 0) return text;
    setUploadError(null);
    const filePaths = pendingFiles
      .map((file) => file.uploadedPath)
      .filter((path): path is string => Boolean(path));
    clearFiles();
    return attachmentMessage(text, filePaths);
  }, [clearFiles, pendingFiles]);

  const hasUploadingFiles = pendingFiles.some((file) => file.status === 'uploading');
  const hasFailedUploads = pendingFiles.some((file) => file.status === 'error');
  const uploadBlocksSend = filesBlockSend(pendingFiles);
  const sendBlockedLabel = hasUploadingFiles
    ? 'Uploading files'
    : hasFailedUploads
      ? 'Resolve failed uploads'
      : null;

  const onDragOver = useCallback((e: DragEvent) => {
    e.preventDefault();
    if (e.dataTransfer.types.includes('Files')) setDragOver(true);
  }, []);

  const onDragLeave = useCallback((e: DragEvent) => {
    e.preventDefault();
    if (e.relatedTarget && (e.currentTarget as Node).contains(e.relatedTarget as Node)) return;
    setDragOver(false);
  }, []);

  const onDrop = useCallback((e: DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    if (e.dataTransfer.files.length > 0) addFiles(e.dataTransfer.files);
  }, [addFiles]);

  const handlePaste = useCallback((e: ClipboardEvent) => {
    const files = Array.from(e.clipboardData.items)
      .filter((item) => item.kind === 'file')
      .map((item) => item.getAsFile())
      .filter((f): f is File => f !== null);
    if (files.length > 0) {
      e.preventDefault();
      addFiles(files);
      return;
    }

    const pastedText = e.clipboardData.getData('text/plain');
    if (!pastedText || !shouldAttachClipboardText(pastedText)) return;

    const textAttachment = createClipboardTextAttachment(pastedText);
    if (!textAttachment.ok) {
      setUploadError(textAttachment.error);
      return;
    }

    const textInput = controlledInputRef.current;
    if (!textInput) return;
    e.preventDefault();

    const target = e.currentTarget as HTMLTextAreaElement;
    const snapshotValue = textInput.value;
    const selectionStart = target.selectionStart ?? snapshotValue.length;
    const selectionEnd = target.selectionEnd ?? selectionStart;
    addPendingFiles([{
      id: createUuid(),
      file: textAttachment.file,
      previewUrl: createObjectUrl(textAttachment.file),
      status: 'uploading',
      textAttachment: {
        ...textAttachment.metadata,
        snapshotValue,
        selectionStart,
        selectionEnd,
      },
    }]);
  }, [addFiles, addPendingFiles]);

  return {
    pendingFiles,
    dragOver,
    uploadError,
    setUploadError,
    hasUploadingFiles,
    uploadBlocksSend,
    sendBlockedLabel,
    addFiles,
    removeFile,
    retryFile,
    restoreTextFile,
    clearFiles,
    submitWithAttachments,
    dragHandlers: { onDragOver, onDragLeave, onDrop },
    handlePaste,
  };
}
