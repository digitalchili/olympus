import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import type { BoardEvent, Task, TaskRunState } from '../shared/types.js';
import { applyProjectBoardEvent } from '../client/src/hooks/useProjectBoardEvents.js';

let tasks: Task[] = [];
let runs = new Map<string, TaskRunState>();
const setTasks = (value: Task[] | ((current: Task[]) => Task[])) => {
  tasks = typeof value === 'function' ? value(tasks) : value;
};
const setRuns = (value: Map<string, TaskRunState> | ((current: Map<string, TaskRunState>) => Map<string, TaskRunState>)) => {
  runs = typeof value === 'function' ? value(runs) : value;
};

const task = {
  id: 'task-1',
  title: 'Cross-profile Project task',
  description: null,
  status: 'in_progress',
  project_id: 'project-1',
  handling_profile_id: 'historical-handler',
  delegated_worker_id: null,
  profile_name: 'historical-handler',
  routing_source: 'project',
  created_at: 1,
  updated_at: 1,
} as Task;

applyProjectBoardEvent({ type: 'task_created', task }, setTasks, setRuns);
assert.deepEqual(tasks.map((item) => item.id), ['task-1']);

const activeRun = {
  taskId: task.id,
  runId: 'run-1',
  kind: 'chat',
  status: 'streaming',
} as TaskRunState;
applyProjectBoardEvent({ type: 'task_runs_snapshot', runs: [activeRun] }, setTasks, setRuns);
assert.equal(runs.get(task.id)?.runId, 'run-1');

applyProjectBoardEvent({
  type: 'task_updated',
  task: { ...task, status: 'in_review', updated_at: 2 },
}, setTasks, setRuns);
assert.equal(tasks[0].status, 'in_review');

applyProjectBoardEvent({
  type: 'task_run_updated',
  run: { ...activeRun, status: 'completed' },
}, setTasks, setRuns);
assert.equal(runs.has(task.id), false);

applyProjectBoardEvent({ type: 'task_deleted', taskId: task.id }, setTasks, setRuns);
assert.equal(tasks.length, 0);

const eventsSource = await readFile('server/events.ts', 'utf8');
const projectsRoute = await readFile('server/routes/projects.ts', 'utf8');
const detailSource = await readFile('client/src/components/ProjectDetailPage.tsx', 'utf8');
const boardSource = await readFile('client/src/components/Board.tsx', 'utf8');
assert.match(eventsSource, /projectClients/);
assert.match(eventsSource, /scopedTask\.project_id !== projectId/);
assert.match(projectsRoute, /router\.get\('\/:id\/events'/);
assert.match(projectsRoute, /requireProfileProjectAccess\(projectId, actor, 'view'\)/);
assert.match(projectsRoute, /getTask\(run\.taskId\)\?\.project_id === projectId/);
assert.match(detailSource, /useProjectBoardEvents/);
assert.doesNotMatch(detailSource, /useStore\(\(state\) => state\.taskRuns\)/);
assert.match(boardSource, /aria-label="Project filter"/);
assert.match(boardSource, /task\.project_id === locationFilter/);
assert.match(boardSource, /selectedProject\.managerProfileId/);

console.log('Project-scoped live task and run event tests passed');
