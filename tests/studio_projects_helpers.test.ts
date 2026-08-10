import assert from 'node:assert/strict';
import type { StudioGitHubRepository, StudioProject } from '../shared/types.js';
import {
  initialStudioRepositoryId,
  selectableStudioRepositories,
} from '../client/src/lib/studio-projects.js';

const repositories: StudioGitHubRepository[] = [
  {
    id: 101,
    name: 'already-imported',
    fullName: 'example/already-imported',
    owner: 'example',
    private: true,
    defaultBranch: 'main',
    htmlUrl: 'https://github.com/example/already-imported',
    cloneUrl: 'https://github.com/example/already-imported.git',
  },
  {
    id: 102,
    name: 'available',
    fullName: 'example/available',
    owner: 'example',
    private: true,
    defaultBranch: 'main',
    htmlUrl: 'https://github.com/example/available',
    cloneUrl: 'https://github.com/example/available.git',
  },
];

const projects = [{ providerRepositoryId: 101 }] as StudioProject[];
assert.deepEqual(selectableStudioRepositories(repositories, projects), [repositories[1]]);
assert.equal(initialStudioRepositoryId(repositories, projects), 102);
assert.equal(initialStudioRepositoryId(repositories, [
  { providerRepositoryId: 101 },
  { providerRepositoryId: 102 },
] as StudioProject[]), null);

console.log('Studio repository selection helper tests passed');
