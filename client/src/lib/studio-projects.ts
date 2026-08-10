import type { StudioGitHubRepository, StudioProject } from '@shared/types';

export function selectableStudioRepositories(
  repositories: StudioGitHubRepository[],
  projects: Pick<StudioProject, 'providerRepositoryId'>[],
): StudioGitHubRepository[] {
  const imported = new Set(projects.map((project) => project.providerRepositoryId));
  return repositories.filter((repository) => !imported.has(repository.id));
}

export function initialStudioRepositoryId(
  repositories: StudioGitHubRepository[],
  projects: Pick<StudioProject, 'providerRepositoryId'>[],
): number | null {
  return selectableStudioRepositories(repositories, projects)[0]?.id ?? null;
}
