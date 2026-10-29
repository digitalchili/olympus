import { createHash, randomUUID } from 'node:crypto';
import type { ProjectRepositoryLink } from '../shared/types.js';
import type { RepositoryRelease, RepositoryReleaseMode, RepositoryReleasePreview } from '../shared/repository-releases.js';
import { getProjectRepositoryLink, listProjectRepositoryLinks } from './db/projects.js';
import { getQueuedTaskMessage } from './db/task-message-queue.js';
import { getLatestTaskAgentRun } from './db/task-agent-runs.js';
import { abandonProjectPublication, createProjectPublication, getProjectPublication } from './db/project-publications.js';
import { getRepositoryRelease, listRepositoryContributions, listRepositoryReleases, queueReleaseFingerprint, saveRepositoryRelease, type ReleaseMember, type SavedRepositoryRelease } from './db/repository-releases.js';
import { repositoryKey } from './db/repository-queue.js';
import { createRepositoryInventory, isRepositoryAncestor, readRepositoryGit, repositoryPublishedPath } from './repository-inventory.js';
import { createRepositoryDevelopment } from './repository-development.js';
import { canProfileAccessProject, requireProfileProjectAccess } from './project-access.js';
import { claimProjectOperation, hasTaskOperation } from './task-run-lifecycle.js';
import { failedCodingEvidence, sourceIdentity, verifyReleaseSource } from './coding-verification.js';
import { ProjectPublicationError, type InstallationTokenProvider, type ProjectCpService } from './project-cp.js';

const conflict = (message: string) => Object.assign(new Error(message), { statusCode: 409 });
const identity = (link: ProjectRepositoryLink) => JSON.stringify([link.provider, link.providerRepositoryId, link.installationId, link.cloneUrl, link.defaultBranch, link.mode]);
function publicRelease(row: SavedRepositoryRelease): RepositoryRelease {
  const { id, mode, state, included, excluded, message, targetBranch, commitSha, createdAt } = row;
  return { id, mode, state, included, excluded, message, targetBranch, commitSha, createdAt,checks:row.verification?.checks };
}

export function createRepositoryReleaseService(options: { rootDir: string; cp: ProjectCpService; tokenProvider?: InstallationTokenProvider; canDispatch?: () => boolean }) {
  const inventory = createRepositoryInventory(options.rootDir), development = createRepositoryDevelopment(options.rootDir);
  const busy = new Set<string>();
  const operations = new Map<string, { controller: AbortController; done: Promise<void> }>();
  const observed = new Map<string, ProjectRepositoryLink>();
  const canDispatch = () => options.canDispatch?.() ?? true;
  function linkFor(projectId: string, actor: string | null, write = false): ProjectRepositoryLink {
    if (actor) requireProfileProjectAccess(projectId, actor, write ? 'contribute' : 'view');
    const link = getProjectRepositoryLink(projectId);
    if (!link || (write && link.mode !== 'branch_pr')) throw conflict('Connect this Project to a writable repository before publishing.');
    return link;
  }
  function assertMemberAccess(row: SavedRepositoryRelease) {
    for (const member of row.members) {
      const link = linkFor(member.projectId, row.actor, true);
      if (identity(link) !== identity(row.repository)) throw conflict('A repository connection or access changed. Review this release again.');
    }
  }
  async function snapshot(projectId: string, actor: string | null) {
    const link = linkFor(projectId, actor);
    observed.set(projectId, link);
    const targetSha = await options.cp.repositoryHead({ repositoryLink: link, tokenProvider: options.tokenProvider });
    return inventory.read(link, targetSha, actor);
  }
  async function preview(projectId: string, mode: RepositoryReleaseMode, actor: string | null = null): Promise<RepositoryReleasePreview> {
    if (!['all','ready'].includes(mode)) throw conflict('Choose whether to wait for all tasks or publish ready changes.');
    const view = await snapshot(projectId, actor);
    if (view.hasHiddenWork) throw conflict('Some repository work is unavailable in this view. Open from a profile with access to all included work.');
    if (!view.targetSha) throw conflict('The GitHub target could not be confirmed. Try again after connecting the repository.');
    const included = view.changes.filter(row => row.state === 'ready' || (mode === 'all' && row.state === 'working'));
    const excluded = view.changes.filter(row => !included.includes(row));
    if (!included.length) throw conflict('There are no checked changes ready to publish yet.');
    const queued = included.filter(row => row.queueId).map(row => queueReleaseFingerprint(getQueuedTaskMessage(row.taskId)!));
    const token = createHash('sha256').update(JSON.stringify([identity(linkFor(projectId, actor)), view.targetSha, view.acceptedSha, mode, included, excluded, queued])).digest('hex');
    return { token, mode, included, excluded, targetBranch: view.targetBranch, targetSha: view.targetSha };
  }
  function update(row: SavedRepositoryRelease, patch: Partial<SavedRepositoryRelease>) {
    const current = getRepositoryRelease(row.id);
    if (current?.state === 'cancelled') throw conflict('This release was cancelled. All task work is saved.');
    Object.assign(row, patch); saveRepositoryRelease(row);
  }
  async function advance(id: string, retry = false) {
    let row = getRepositoryRelease(id);
    if (!row || busy.has(row.repositoryKey) || !canDispatch() || ['confirmed','cancelled'].includes(row.state)) return;
    if (!retry && ['blocked','publishing'].includes(row.state)) return;
    busy.add(row.repositoryKey);
    const controller = new AbortController();
    let settled!: () => void;
    operations.set(id, { controller, done: new Promise<void>(resolve => { settled = resolve; }) });
    const claims: Array<() => void> = [];
    try {
      for (const link of listProjectRepositoryLinks().filter(link => repositoryKey(link) === row!.repositoryKey)) {
        const claim = claimProjectOperation(link.projectId);
        if (!claim) return;
        claims.push(claim);
      }
      if (!canDispatch()) return;
      const link = linkFor(row.projectId, row.actor, true);
      if (identity(link) !== identity(row.repository)) throw conflict('The repository connection changed. Review this release again.');
      assertMemberAccess(row);
      if (row.publicationId && getProjectPublication(row.publicationId)?.state === 'confirmed') {
        update(row,{state:'confirmed',message:'On GitHub. Deployment has not been verified.'}); return;
      }
      const path = development.pathFor(link), accepted = await development.head(link);
      const targetPath = await repositoryPublishedPath(options.rootDir, link, row.targetSha);
      if (!row.sourceSha) {
        const contributions = listRepositoryContributions(row.repositoryKey);
        const resolved: ReleaseMember[] = [];
        const waiting: string[] = [];
        for (const member of row.members) {
          if (member.state === 'ready' && member.commitSha) { resolved.push(member); continue; }
          let runId = member.runId;
          if (member.queueId) {
            // Admission records this binding synchronously. A preparation still
            // holding the task operation may not have created its run yet.
            const fresh = getRepositoryRelease(row.id)!;
            const binding = fresh.members.find(item => item.id === member.id);
            if (fresh.state === 'blocked') throw conflict(fresh.message);
            runId = binding?.boundRunId ?? null;
            if (!runId) {
              const queued = getQueuedTaskMessage(member.taskId);
              if (!queued && hasTaskOperation(member.taskId)) { waiting.push(member.title); continue; }
              if (!queued || queued.id !== member.queueId || queueReleaseFingerprint(queued) !== member.queueFingerprint) {
                throw conflict('A saved request was changed or removed. Review the included tasks and make a new publish request.');
              }
              waiting.push(member.title); continue;
            }
          }
          const contribution = contributions.find(item => item.taskId === member.taskId && item.runId === runId);
          if (!contribution || !await isRepositoryAncestor(path, contribution.commitSha, accepted)) {
            const latest = getLatestTaskAgentRun(member.taskId);
            const recovering = latest?.recoveryState && ['pending', 'waiting', 'running'].includes(latest.recoveryState);
            if (member.state === 'stopped' || latest?.status === 'stopped') {
              throw conflict(`“${member.title}” was stopped. Its work is saved. Cancel this publish request to choose the ready tasks, or finish this task and review a new request.`);
            }
            if (member.state === 'needs_attention' || (latest && latest.runId !== runId)
              || (!recovering && latest?.status === 'error') || (runId && failedCodingEvidence(member.taskId, runId))) {
              throw conflict(`“${member.title}” needs attention before it can be included. Open that task to finish its checks, then review a new publish request.`);
            }
            waiting.push(member.title); continue;
          }
          resolved.push({ ...member, state: 'ready', commitSha: contribution.commitSha, previousSha: contribution.previousSha,
            changedFiles: contribution.changedFiles, runId: contribution.runId });
        }
        if (waiting.length) {
          // Keep bindings that admission may have saved during this read.
          row = getRepositoryRelease(row.id)!;
          update(row, { state:'waiting', message:`Waiting for ${[...new Set(waiting)].map(title => `“${title}”`).join(', ')} to finish and pass checks. This release will continue automatically.` });
          return;
        }
        let source = resolved.find(member => member.commitSha)?.commitSha ?? row.targetSha;
        for (const member of resolved) if (member.commitSha) {
          if (await isRepositoryAncestor(path, source, member.commitSha)) source = member.commitSha;
          else if (!await isRepositoryAncestor(path, member.commitSha, source)) throw conflict('These changes do not yet share one checked development version. Finish their handoff before publishing.');
        }
        // Never include an intervening later task just because it is an ancestor.
        for (const contribution of contributions) {
          if (!contribution.changedFiles.length || await isRepositoryAncestor(targetPath, contribution.commitSha, row.targetSha)
            || !await isRepositoryAncestor(path, contribution.commitSha, source)) continue;
          if (!resolved.some(member => member.taskId === contribution.taskId && member.runId === contribution.runId)) {
            throw conflict('Other task changes were combined after this request. Review the updated list before publishing together.');
          }
        }
        update(row, { sourceSha: source, members:resolved, included:resolved.map(member => ({...member,reason:'Checked and included in this release.'})), state:'checking', message:'Checking the combined changes in a separate release copy. Your tasks can keep working.' });
      }
      if (!await isRepositoryAncestor(path, row.sourceSha, accepted)) throw conflict('The saved release source is no longer in the accepted development version. Review it before publishing.');
      const remote = await options.cp.repositoryHead({ repositoryLink: link, tokenProvider: options.tokenProvider });
      if (row.publicationId && remote === row.commitSha) {
        await options.cp.publishRepositoryRelease({ id:row.id, publicationId:row.publicationId, targetSha:row.targetSha, repositoryLink:link, tokenProvider:options.tokenProvider });
        update(row,{state:'confirmed',message:'On GitHub. Deployment has not been verified.'}); return;
      }
      if (remote !== row.targetSha) throw conflict('GitHub changed after this publish request. Review the updated changes before trying again.');
      if (!row.candidate) update(row, { candidate: await options.cp.prepareRepositoryRelease({ id:row.id,sourceSha:row.sourceSha!,targetSha:row.targetSha,repositoryLink:link,tokenProvider:options.tokenProvider }) });
      const covered = new Set<string>();
      for (const member of row.members) if (member.commitSha && member.previousSha) {
        for (const sha of (await readRepositoryGit(row.candidate!.workdir,'rev-list',member.commitSha,'--not',member.previousSha,row.targetSha)).split('\n').filter(Boolean)) covered.add(sha);
      }
      const required = (await readRepositoryGit(row.candidate!.workdir,'rev-list',row.sourceSha!,'--not',row.targetSha)).split('\n').filter(Boolean);
      if (required.some(sha=>!covered.has(sha))) throw conflict('This version includes earlier saved changes that have not been checked for this release. Review those tasks before publishing together.');
      const beforeChecks = await sourceIdentity(row.candidate!.workdir);
      if (beforeChecks.head !== row.candidate!.headSha || await readRepositoryGit(row.candidate!.workdir,'status','--porcelain')
        || (row.verification && beforeChecks.fingerprint !== row.verification.source.fingerprint)) throw conflict('The saved release copy changed. Start a new publish request to check the current work.');
      controller.signal.throwIfAborted();
      if (!row.verification?.passed) update(row, { verification: await verifyReleaseSource(row.candidate!.workdir, controller.signal) });
      if (!row.verification!.passed) throw conflict(row.verification!.reason ?? 'The combined release checks failed. All work is saved.');
      if (beforeChecks.fingerprint !== row.verification!.source.fingerprint) throw conflict('The release copy changed before checks. Review it before publishing.');
      if ((await sourceIdentity(row.candidate!.workdir)).fingerprint !== row.verification!.source.fingerprint) throw conflict('The release copy changed after checks. Review it before publishing.');
      assertMemberAccess(row);
      if (identity(linkFor(row.projectId,row.actor,true)) !== identity(row.repository)) throw conflict('The repository connection changed. Review this release again.');
      if (getRepositoryRelease(row.id)?.state === 'cancelled') return;
      if (!row.publicationId) {
        const publicationId = row.id;
        // The receipt ID is deterministic so a restart between these writes
        // recovers the same exact candidate instead of creating another push.
        if (!getProjectPublication(publicationId)) createProjectPublication({ id:publicationId,projectId:row.projectId,taskId:null,leaseId:null,
          repository:{installationId:link.installationId,providerRepositoryId:link.providerRepositoryId,cloneUrl:link.cloneUrl,defaultBranch:link.defaultBranch},
          action:'commit_push',revertedVersionId:null,parentSha:row.targetSha,treeSha:row.candidate!.treeSha,commitSha:row.candidate!.headSha,
          commitMessage:'Publish checked repository changes',changedFiles:row.candidate!.changedFiles,targetBranch:link.defaultBranch,
          refs:[{ref:`refs/heads/${link.defaultBranch}`,source:'commit',createOnly:false}],createdAt:Date.now() });
        update(row,{publicationId,commitSha:row.candidate!.headSha,state:'publishing',message:'Publishing this checked version to GitHub.'});
      }
      await options.cp.publishRepositoryRelease({ id:row.id,publicationId:row.publicationId!,targetSha:row.targetSha,repositoryLink:link,tokenProvider:options.tokenProvider });
      update(row,{state:'confirmed',message:'On GitHub. Deployment has not been verified.'});
    } catch (error) {
      if (getRepositoryRelease(row.id)?.state !== 'cancelled') {
        const unknown = error instanceof ProjectPublicationError && error.code === 'PUBLICATION_UNCONFIRMED';
        update(row,{state:unknown?'publishing':'blocked',message:unknown ? 'GitHub has not confirmed this publish yet. Retry confirmation for this same saved version.'
          : error instanceof Error && (error as any).statusCode === 409 ? error.message
            : 'The combined release could not be prepared or checked. All work is saved. Review its checks and repository connection before retrying.'});
      }
    } finally { claims.reverse().forEach(release=>release()); busy.delete(row.repositoryKey); operations.delete(id); settled(); }
  }
  return {
    preview,
    async overview(projectId: string, actor: string | null = null) {
      const view = await snapshot(projectId,actor);
      const row = listRepositoryReleases(view.repositoryKey)[0];
      const visible = !actor || !row || [...row.included,...row.excluded].every(member=>canProfileAccessProject(member.projectId,actor));
      return {...view,release:row && visible ? publicRelease(row) : null};
    },
    async request(projectId: string, mode: RepositoryReleaseMode, token: string, actor: string | null = null) {
      if (!canDispatch()) throw conflict('Maintenance is in progress. Try again when Olympus is ready.');
      const link = linkFor(projectId,actor,true), view = await preview(projectId,mode,actor);
      if (token !== view.token) throw conflict('The task list changed. Review the updated publish preview.');
      if (listRepositoryReleases(repositoryKey(link)).some(row=>!['confirmed','cancelled'].includes(row.state))) throw conflict('This repository already has a saved publish request. Open it before starting another.');
      const members: ReleaseMember[] = view.included.flatMap(item => {
        if (!item.queueId) return [{...item}];
        const queued = getQueuedTaskMessage(item.taskId);
        if (!queued || queued.id !== item.queueId) throw conflict('The saved request changed. Review the publish preview.');
        // A same-task queued turn continues the captured active turn's files.
        // The queue accepts that chain only once, after the bound final turn.
        return [{...item,queueFingerprint:queueReleaseFingerprint(queued)}];
      });
      const row: SavedRepositoryRelease = {id:randomUUID(),repositoryKey:repositoryKey(link),projectId,actor,repository:link,
        mode,state:'waiting',included:view.included,excluded:view.excluded,members,sourceSha:null,targetSha:view.targetSha,
        message:'Publish request saved. Waiting for the included tasks and checks.',targetBranch:link.defaultBranch,commitSha:null,createdAt:Date.now()};
      assertMemberAccess(row); saveRepositoryRelease(row); return publicRelease(row);
    },
    async tick() {
      if (!canDispatch()) return;
      const pending = listRepositoryReleases().filter(row=>['waiting','checking'].includes(row.state));
      for (const row of pending) observed.set(row.projectId, row.repository);
      // Refresh remote objects outside read-only sidebar requests, never in task clones.
      await Promise.all([...new Map([...observed.values()].map(link=>[repositoryKey(link),link])).values()].map(async link => {
        const current = getProjectRepositoryLink(link.projectId);
        if (current && identity(current) === identity(link)) await options.cp.refreshRepositoryTarget({repositoryLink:current,tokenProvider:options.tokenProvider}).catch(()=>{});
      }));
      for (const row of pending) await advance(row.id);
    },
    async retry(projectId: string, id: string, actor: string | null = null) {
      const row=getRepositoryRelease(id), link=linkFor(projectId,actor,true);
      if (!row || row.repositoryKey!==repositoryKey(link)) throw conflict('Publish request not found.');
      if (actor && row.members.some(member=>!canProfileAccessProject(member.projectId,actor,'contribute'))) throw conflict('This publish request requires access to all included Projects.');
      await advance(id,true); return publicRelease(getRepositoryRelease(id)!);
    },
    async cancel(projectId: string,id: string,actor: string | null = null) {
      const row=getRepositoryRelease(id),link=linkFor(projectId,actor,true);
      if (!row || row.repositoryKey!==repositoryKey(link)) throw conflict('Publish request not found.');
      if (actor && row.members.some(member=>!canProfileAccessProject(member.projectId,actor,'contribute'))) throw conflict('This publish request requires access to all included Projects.');
      if (row.state==='confirmed' || (row.publicationId && busy.has(row.repositoryKey))) throw conflict('Publication has already started. Wait for its GitHub confirmation before stopping retries.');
      if (row.publicationId) abandonProjectPublication(row.publicationId);
      saveRepositoryRelease({...row,state:'cancelled',message:row.publicationId ? 'Stopped retrying this saved publication. Check GitHub for its final status. All task work is saved.' : 'Publish request cancelled. All task work is saved.'});
      const operation = operations.get(id);
      operation?.controller.abort(new Error('Publish request cancelled'));
      await operation?.done;
    },
  };
}
export type RepositoryReleaseService = ReturnType<typeof createRepositoryReleaseService>;
