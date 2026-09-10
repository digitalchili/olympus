import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router';
import { ProfileProvider } from '../../client/src/contexts/ProfileContext';
import { TaskKanban } from '../../client/src/components/Board';
import type { Task } from '../../shared/types';
import '../../client/src/styles/globals.css';

window.fetch = async () => new Response(JSON.stringify({ profiles: [{ id: 'default', label: 'Somboon', isDefault: true }] }), { headers: { 'Content-Type': 'application/json' } });
const initial = [
  { id: 'active', title: 'Active task', status: 'in_progress' },
  { id: 'review-a', title: 'Review task A', status: 'in_review' },
  { id: 'review-b', title: 'Review task B', status: 'in_review', profile_name: 'som' },
  { id: 'done', title: 'Already complete', status: 'done' },
].map(task => ({ description: '', created_at: Date.now(), updated_at: Date.now(), ...task })) as Task[];
let failOnce = true;
function Fixture() {
  const [tasks, setTasks] = useState(initial);
  const [calls, setCalls] = useState<string[]>([]);
  return <main className="p-6">
    <p>Disposable board fixture. Review task B fails once; retry should move only that task.</p>
    <TaskKanban tasks={tasks} taskRuns={new Map()} createTaskTo="/tasks/new" onDeleteTask={async () => { throw new Error('Delete must not run'); }}
      onMoveTask={async (task, status) => {
        setCalls(current => [...current, `${task.id}:${task.profile_name ?? 'default'}:${status}`]);
        await new Promise(resolve => setTimeout(resolve, 1200));
        if (task.id === 'review-b' && failOnce) { failOnce = false; throw new Error('Fixture failure'); }
        const updated = { ...task, status, updated_at: Date.now() };
        setTasks(current => current.map(item => item.id === task.id ? updated : item));
        return updated;
      }} />
    <pre aria-label="Move requests">{calls.join('\n')}</pre>
  </main>;
}
createRoot(document.getElementById('root')!).render(<BrowserRouter><ProfileProvider><Fixture /></ProfileProvider></BrowserRouter>);
