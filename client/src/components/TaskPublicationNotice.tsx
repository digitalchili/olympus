import type { PublicationIssueCode } from '../lib/chatSendRecovery';

export function TaskPublicationNotice({ issue, onReview }: {
  issue: PublicationIssueCode | null;
  onReview: () => void;
}) {
  if (!issue) return null;
  const conflict = issue === 'PUBLICATION_CONFLICT';
  return <div role="status" className="mx-auto mb-2 flex max-w-[760px] flex-wrap items-center gap-x-3 gap-y-1 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:bg-amber-950/30 dark:text-amber-200">
    <span className="inline-flex items-center gap-1.5 font-medium"><span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-amber-500" />{conflict ? 'GitHub push needs attention' : 'GitHub push awaiting confirmation'}</span>
    <span>{conflict ? 'Your work is saved. Review the existing push to continue.' : 'Your work is saved. No need to submit it again.'}</span>
    <button type="button" onClick={onReview} className="font-medium underline underline-offset-2">{conflict ? 'Review publication' : 'Resume publication'}</button>
  </div>;
}
