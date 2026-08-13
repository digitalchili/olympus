import assert from 'node:assert/strict';
import {
  projectChipClasses,
  projectTaskPath,
} from '../client/src/lib/projectTaskPresentation.ts';

const project = {
  id: 'project-1',
  name: 'Project One',
} as const;

assert.equal(projectTaskPath({ id: 'task-1', project_id: project.id }, project), '/projects/project-1/tasks/task-1');
assert.equal(projectTaskPath({ id: 'task-2', project_id: null }, undefined), '/tasks/task-2');
assert.equal(projectTaskPath({ id: 'task-3', project_id: 'missing-project' }, undefined), '/projects/missing-project/tasks/task-3');

assert.equal(projectChipClasses(project.id), projectChipClasses(project.id));
assert.notEqual(projectChipClasses(project.id), projectChipClasses('project-2'));
assert.match(projectChipClasses(project.id), /bg-/);
assert.match(projectChipClasses(project.id), /text-/);
assert.match(projectChipClasses(project.id), /dark:/);

console.log('Project task presentation tests passed');