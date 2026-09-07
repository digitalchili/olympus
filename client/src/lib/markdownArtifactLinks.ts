import type { Root, RootContent } from 'hast';
import { BASE } from './api';
import { apiPathWithProfile } from './profileQuery';

function artifactPath(href: string): string | null {
  let path = href;
  if (/^https?:\/\//i.test(path)) {
    try {
      const url = new URL(path);
      if (typeof window === 'undefined' || url.origin !== window.location.origin) return null;
      path = url.pathname;
    } catch {
      return null;
    }
  } else if (path.startsWith('sandbox:/')) {
    path = path.slice('sandbox:'.length);
  } else if (path.startsWith('file:///')) {
    path = path.slice('file://'.length);
  } else if (/^[a-z][a-z\d+.-]*:/i.test(path)) {
    return null;
  }
  // Keep web URLs, app/API routes and anchors as ordinary links.
  if (!path || path.startsWith('//') || path.startsWith('#') || path.startsWith('?')
    || /^\/(?:[?#]|$)/.test(path)
    || /^\/(?:api|tasks|bots|files|projects|settings|skills|scheduled-tasks|channels|studio|cron)(?:[/?#]|$)/.test(path)) return null;
  if (!path.startsWith('/') && !path.startsWith('~/') && !path.startsWith('./')
    && !path.startsWith('../') && !/\.[a-z\d]{1,12}$/i.test(path)) return null;
  try {
    return decodeURIComponent(path);
  } catch {
    return null;
  }
}

/** Convert local links before Markdown sanitization removes file/sandbox schemes.
 * The task endpoint remains responsible for filesystem and profile authorization. */
export function rewriteArtifactLinks({ taskId }: { taskId?: string }) {
  return (tree: Root) => {
    if (!taskId) return;
    const endpoint = `/tasks/${encodeURIComponent(taskId)}/artifacts/download`;
    function visit(node: Root | RootContent) {
      if (node.type === 'element' && node.tagName === 'a' && typeof node.properties.href === 'string') {
        const path = artifactPath(node.properties.href);
        if (path !== null) {
          node.properties.href = `${BASE}${apiPathWithProfile(`${endpoint}?path=${encodeURIComponent(path)}`)}`;
        }
      }
      if ('children' in node) node.children.forEach(visit);
    }
    visit(tree);
  };
}

export function isArtifactDownloadUrl(href?: string): boolean {
  return !!href && /^\/api\/(?:tasks\/[^/]+\/artifacts|files)\/download\?/.test(href);
}
