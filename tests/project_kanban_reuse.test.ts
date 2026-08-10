import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const board = await readFile('client/src/components/Board.tsx', 'utf8');
const column = await readFile('client/src/components/Column.tsx', 'utf8');
const card = await readFile('client/src/components/TaskCard.tsx', 'utf8');
const menu = await readFile('client/src/components/TaskContextMenu.tsx', 'utf8');
const detail = await readFile('client/src/components/ProjectDetailPage.tsx', 'utf8');
const api = await readFile('client/src/lib/api.ts', 'utf8');

assert.match(board, /export function TaskKanban\(/);
assert.match(board, /export function Board\(\)/);
assert.match(board, /<TaskKanban/);
assert.match(detail, /import \{ TaskKanban \} from '\.\/Board'/);
assert.match(detail, /<TaskKanban/);
assert.doesNotMatch(detail, /const grouped = useMemo/);
assert.doesNotMatch(detail, /\[\['Active', grouped\.active\]/);

assert.match(column, /createTaskTo/);
assert.match(column, /onMoveTask/);
assert.match(column, /onDeleteTask/);
assert.match(card, /toWithProfile\(`\/tasks\/\$\{task\.id\}`/);
assert.match(card, /task\.handling_profile_id \?\? task\.profile_name/);
assert.match(menu, /onMoveTask/);
assert.match(menu, /onDeleteTask/);
assert.doesNotMatch(menu, /useStore/);

assert.match(api, /export function moveTask\(id: string, status: TaskStatus, profileId\?: string \| null\)/);
assert.match(api, /export function deleteTask\(id: string, profileId\?: string \| null\)/);
assert.match(api, /apiPathWithProfile\(`\/tasks\/\$\{id\}\/move`, profileId\)/);
assert.match(api, /apiPathWithProfile\(`\/tasks\/\$\{id\}`, profileId\)/);

console.log('Canonical Project Kanban reuse and handler-aware interaction tests passed');
