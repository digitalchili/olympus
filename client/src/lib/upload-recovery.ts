export type UploadStatus = 'uploading' | 'uploaded' | 'error';

export type UploadRecoveryFile = {
  id: string;
  status: UploadStatus;
  uploadedPath?: string;
  error?: string;
};

export function failedUpload<T extends UploadRecoveryFile>(file: T, error: string): T {
  const { uploadedPath: _uploadedPath, error: _error, ...rest } = file;
  return { ...rest, status: 'error', error } as T;
}

export function retryUpload<T extends UploadRecoveryFile>(file: T): T {
  const { uploadedPath: _uploadedPath, error: _error, ...rest } = file;
  return { ...rest, status: 'uploading' } as T;
}

export function uploadBlocksSend(files: UploadRecoveryFile[]): boolean {
  return files.some((file) => file.status === 'uploading' || file.status === 'error');
}
