import type { TaskAttachment } from '@shared/types';

/** Hide the transport manifest only after every draft has a real published preview.
 * Invalid or failed publications stay visible so failures cannot look successful. */
export function stripPublishedPreviewManifests(content: string, attachments: TaskAttachment[]): string {
  const paths = new Set(attachments.filter((a) => a.preview?.groupId).map((a) => a.path));
  return content.replace(/^```olympus-preview\s*\n([\s\S]*?)^```[ \t]*$/gm, (block, json: string) => {
    try {
      const value = JSON.parse(json);
      return Array.isArray(value.drafts) && value.drafts.length > 0
        && value.drafts.every((draft: { path?: string }) => typeof draft?.path === 'string' && paths.has(draft.path))
        ? '' : block;
    } catch { return block; }
  }).trim();
}
