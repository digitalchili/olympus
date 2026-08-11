import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const sidebar = await readFile('client/src/components/Sidebar.tsx', 'utf8');
const header = await readFile('client/src/components/Header.tsx', 'utf8');
const board = await readFile('client/src/components/Board.tsx', 'utf8');
const column = await readFile('client/src/components/Column.tsx', 'utf8');
const card = await readFile('client/src/components/TaskCard.tsx', 'utf8');
const detail = await readFile('client/src/components/ProjectDetailPage.tsx', 'utf8');
const newTask = await readFile('client/src/components/NewTaskPage.tsx', 'utf8');

assert.match(sidebar, /FolderKanban/);
assert.match(sidebar, /label="All Tasks"/);
assert.doesNotMatch(sidebar, /label="Tasks"/);
assert.match(header, /let title = 'All Tasks'/);

assert.match(board, /Inbox and Project tasks you can access/);
assert.match(board, /projectById=/);
assert.match(board, /showTaskLocation/);
assert.match(column, /showTaskLocation/);
assert.match(column, /project=\{task\.project_id \? projectById\?\.get\(task\.project_id\) : undefined\}/);
assert.match(card, /Inbox/);
assert.match(card, /to=\{`\/projects\/\$\{project\.id\}`\}/);
assert.match(card, /Project location/);
assert.match(card, /task\.project_id \? 'Project' : 'Inbox'/);

for (const tab of ['Board', 'References', 'Activity', 'Settings']) {
  assert.match(detail, new RegExp(`>${tab}<`));
}
assert.match(detail, /useSearchParams/);
assert.match(detail, /usePageHeader/);
assert.match(detail, /label: project\?\.name \?\? 'Project'/);
assert.match(detail, /activeTab === 'board'/);
assert.match(detail, /activeTab === 'references'/);
assert.match(detail, /activeTab === 'activity'/);
assert.match(detail, /activeTab === 'settings'/);
assert.doesNotMatch(detail, /lg:grid-cols-\[minmax\(0,1fr\)_300px\]/);

assert.match(newTask, /const projectLocked = Boolean\(initialProjectId\)/);
assert.match(newTask, /disabled=\{projectLocked\}/);
assert.match(newTask, /This task belongs to/);
assert.match(newTask, /Future tasks use the Project manager policy/);
assert.match(newTask, /projectSelectionPending/);
assert.match(newTask, /Waiting for Project/);

console.log('Projects information architecture UI tests passed');
