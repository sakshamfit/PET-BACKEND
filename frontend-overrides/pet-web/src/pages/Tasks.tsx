/**
 * Tasks — both directions (admin → employee, employee → employee),
 * status flow actions, creation with links, admin reassignment.
 */

import { useCallback, useEffect, useState } from 'react';
import { petTasks, petMe, petStudents, petSchools, getPetUser, PetApiFailure } from '../services/petApi';
import type { PetTask, TaskEvent, TaskStatus } from '../types/pet';
import { Badge, Card, EmptyState, Field, Modal, Spinner, taskStatusLabel } from '../ui';

const NEXT_ACTIONS: Record<string, TaskStatus[]> = {
  pending: ['accepted', 'in_progress', 'cancelled'],
  accepted: ['in_progress', 'cancelled'],
  in_progress: ['submitted', 'completed', 'cancelled'],
  submitted: ['completed', 'cancelled'],
};

export function TasksPage() {
  const [tasks, setTasks] = useState<PetTask[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('');
  const [showCreate, setShowCreate] = useState(false);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [busyTaskId, setBusyTaskId] = useState<string | null>(null);
  const isAdmin = getPetUser()?.role === 'main_admin';

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = filter ? { status: filter } : {};
      setTasks((await petTasks.list(params)).tasks);
      setError('');
    } catch (err) {
      setError(err instanceof PetApiFailure ? err.message : 'Could not load tasks.');
    } finally {
      setLoading(false);
    }
  }, [filter]);

  useEffect(() => { void load(); }, [load]);

  async function advance(id: string, status: TaskStatus) {
    if (status === 'cancelled' && !window.confirm('Cancel this task?')) return;
    setBusyTaskId(id);
    setError('');
    try {
      await petTasks.changeStatus(id, status);
      await load();
    } catch (err) {
      setError(err instanceof PetApiFailure ? err.message : 'Could not update the task.');
    } finally {
      setBusyTaskId(null);
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <div className="-mx-1 flex gap-1.5 overflow-x-auto px-1">
          {[['', 'Open'], ['submitted', 'Submitted'], ['completed', 'Completed'], ['cancelled', 'Cancelled']].map(([k, label]) => (
            <button key={k}
              className={`shrink-0 rounded-full px-3 py-1.5 text-xs font-semibold ${filter === k ? 'bg-pet-800 text-white' : 'bg-white text-slate-600 border border-slate-200'}`}
              onClick={() => setFilter(k)}>
              {label}
            </button>
          ))}
        </div>
        <button className="p-btn-primary shrink-0" onClick={() => setShowCreate(true)}>+ Task</button>
      </div>

      {error ? (
        <div className="flex items-start justify-between gap-3 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">
          <span>{error}</span>
          <button className="font-semibold underline" onClick={() => void load()}>Retry</button>
        </div>
      ) : null}

      {loading ? <Spinner /> : tasks.length === 0 ? (
        <Card><EmptyState title="No tasks here" hint="Create a task or wait for an assignment." /></Card>
      ) : (
        <div className="space-y-2">
          {tasks.map(t => {
            const next = NEXT_ACTIONS[t.status] ?? [];
            return (
              <Card key={t.id}>
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-sm font-bold text-slate-900">{t.title}</p>
                    {t.description ? <p className="mt-0.5 text-xs text-slate-500">{t.description}</p> : null}
                    <p className="mt-1 text-xs text-slate-500">
                      {t.created_by_user_name} → <b>{t.assigned_to_user_name}</b>
                      {t.due_date ? ` · due ${t.due_date}` : ''}
                      {t.priority !== 'normal' ? ` · ${t.priority}` : ''}
                    </p>
                  </div>
                  <Badge tone={t.status === 'completed' ? 'green' : t.status === 'cancelled' ? 'red' : t.status === 'pending' ? 'amber' : 'blue'}>
                    {taskStatusLabel(t.status)}
                  </Badge>
                </div>
                <div className="mt-2.5 flex flex-wrap gap-1.5">
                  <button
                    className="p-btn-ghost !min-h-8 !px-2.5 text-xs"
                    onClick={() => setSelectedTaskId(t.id)}
                  >
                    Details
                  </button>
                  {next.map(s => (
                    <button
                      key={s}
                      className={`p-btn-ghost !min-h-8 !px-2.5 text-xs ${s === 'cancelled' ? 'text-rose-700' : ''}`}
                      disabled={busyTaskId === t.id}
                      onClick={() => void advance(t.id, s)}
                    >
                      → {taskStatusLabel(s)}
                    </button>
                  ))}
                </div>
              </Card>
            );
          })}
        </div>
      )}

      {selectedTaskId ? (
        <TaskDetailModal id={selectedTaskId} onClose={() => setSelectedTaskId(null)} />
      ) : null}

      {showCreate ? (
        <Modal title="New Task" onClose={() => setShowCreate(false)}>
          <CreateTaskForm isAdmin={isAdmin} onDone={async () => { setShowCreate(false); await load(); }} />
        </Modal>
      ) : null}
    </div>
  );
}

function TaskDetailModal({ id, onClose }: { id: string; onClose: () => void }) {
  const [data, setData] = useState<{ task: PetTask; events: TaskEvent[] } | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let alive = true;
    void petTasks.detail(id)
      .then(result => { if (alive) setData(result); })
      .catch(err => {
        if (alive) setError(err instanceof PetApiFailure ? err.message : 'Could not load task details.');
      });
    return () => { alive = false; };
  }, [id]);

  return (
    <Modal title="Task details" onClose={onClose}>
      {!data ? (
        error ? <EmptyState title="Task unavailable" hint={error} /> : <Spinner label="Loading task…" />
      ) : (
        <div className="space-y-4">
          <div>
            <div className="flex items-start justify-between gap-3">
              <h3 className="text-base font-bold text-slate-900">{data.task.title}</h3>
              <Badge tone={data.task.status === 'completed' ? 'green' : data.task.status === 'cancelled' ? 'red' : 'blue'}>
                {taskStatusLabel(data.task.status)}
              </Badge>
            </div>
            {data.task.description ? <p className="mt-1 whitespace-pre-line text-sm text-slate-600">{data.task.description}</p> : null}
          </div>

          <div className="grid grid-cols-2 gap-3 text-xs">
            <div><p className="font-semibold text-slate-400">Assigned to</p><p className="font-medium text-slate-800">{data.task.assigned_to_user_name}</p></div>
            <div><p className="font-semibold text-slate-400">Created by</p><p className="font-medium text-slate-800">{data.task.created_by_user_name}</p></div>
            <div><p className="font-semibold text-slate-400">Priority</p><p className="font-medium capitalize text-slate-800">{data.task.priority}</p></div>
            <div><p className="font-semibold text-slate-400">Due date</p><p className="font-medium text-slate-800">{data.task.due_date || 'No due date'}</p></div>
          </div>

          {(data.task.student_id || data.task.school_id || data.task.visit_id) ? (
            <div>
              <p className="p-label">Linked records</p>
              <div className="flex flex-wrap gap-1.5">
                {data.task.student_id ? <Badge tone="blue">Student linked</Badge> : null}
                {data.task.school_id ? <Badge tone="green">School linked</Badge> : null}
                {data.task.visit_id ? <Badge tone="purple">Visit linked</Badge> : null}
              </div>
            </div>
          ) : null}

          <section>
            <p className="p-label">Activity</p>
            {data.events.length === 0 ? <p className="text-xs text-slate-500">No activity recorded.</p> : (
              <ol className="relative space-y-2 border-l-2 border-slate-200 pl-4">
                {data.events.map(event => (
                  <li key={event.id} className="text-xs">
                    <span className="absolute -left-[5px] mt-1 h-2 w-2 rounded-full bg-pet-700" />
                    <p className="font-semibold text-slate-800">
                      {event.event_type === 'status_change' && event.to_status
                        ? `${event.from_status ? taskStatusLabel(event.from_status) : 'Task'} → ${taskStatusLabel(event.to_status)}`
                        : event.event_type.replaceAll('_', ' ')}
                    </p>
                    <p className="text-slate-500">
                      {event.actor_user_name} · {new Date(event.created_at).toLocaleString()}
                      {event.note ? ` · ${event.note}` : ''}
                    </p>
                  </li>
                ))}
              </ol>
            )}
          </section>
        </div>
      )}
    </Modal>
  );
}

function CreateTaskForm({ isAdmin, onDone }: { isAdmin: boolean; onDone: () => void }) {
  const [members, setMembers] = useState<Array<{ id: string; name: string; role: string }>>([]);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [assignee, setAssignee] = useState('');
  const [priority, setPriority] = useState('normal');
  const [dueDate, setDueDate] = useState('');
  const [studentQ, setStudentQ] = useState('');
  const [studentId, setStudentId] = useState('');
  const [schoolQ, setSchoolQ] = useState('');
  const [schoolId, setSchoolId] = useState('');
  const [studentOptions, setStudentOptions] = useState<Array<{ id: string; name: string }>>([]);
  const [schoolOptions, setSchoolOptions] = useState<Array<{ id: string; name: string }>>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    void petMe.directory().then(r => setMembers(r.members)).catch(() => {});
  }, []);

  useEffect(() => {
    const t = setTimeout(async () => {
      if (studentQ.trim().length >= 2 && !studentId) {
        try {
          const res = await petStudents.search({ q: studentQ.trim() });
          setStudentOptions(res.students.slice(0, 4).map(s => ({ id: s.id, name: `${s.name} (${s.pet_student_id})` })));
        } catch { /* noop */ }
      }
    }, 250);
    return () => clearTimeout(t);
  }, [studentQ, studentId]);

  useEffect(() => {
    const t = setTimeout(async () => {
      if (schoolQ.trim().length >= 2 && !schoolId) {
        try {
          const res = await petSchools.list({ q: schoolQ.trim() });
          setSchoolOptions(res.schools.slice(0, 4).map(s => ({ id: s.id, name: s.name })));
        } catch { /* noop */ }
      }
    }, 250);
    return () => clearTimeout(t);
  }, [schoolQ, schoolId]);

  async function submit(ev: React.FormEvent) {
    ev.preventDefault();
    setBusy(true);
    setError('');
    try {
      await petTasks.create({
        title: title.trim(),
        description: description.trim() || undefined,
        assigned_to_user_id: assignee,
        priority,
        due_date: dueDate || undefined,
        student_id: studentId || undefined,
        school_id: schoolId || undefined,
      });
      onDone();
    } catch (err) {
      setError(err instanceof PetApiFailure ? err.message : 'Could not create the task.');
      setBusy(false);
    }
  }

  return (
    <form className="space-y-3" onSubmit={submit}>
      <Field label="Title *">
        <input className="p-input" value={title} onChange={e => setTitle(e.target.value)} required minLength={2} />
      </Field>
      <Field label="Description">
        <textarea className="p-input" rows={2} value={description} onChange={e => setDescription(e.target.value)} />
      </Field>
      <Field label="Assign to *">
        <select className="p-input" value={assignee} onChange={e => setAssignee(e.target.value)} required>
          <option value="">Select team member…</option>
          {members.map(m => (
            <option key={m.id} value={m.id}>{m.name} ({m.role === 'main_admin' ? 'Main Admin' : 'Employee'})</option>
          ))}
        </select>
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Priority">
          <select className="p-input" value={priority} onChange={e => setPriority(e.target.value)}>
            <option value="low">Low</option><option value="normal">Normal</option>
            <option value="high">High</option><option value="urgent">Urgent</option>
          </select>
        </Field>
        <Field label="Due date">
          <input type="date" className="p-input" value={dueDate} onChange={e => setDueDate(e.target.value)} />
        </Field>
      </div>
      <Field label="Linked student (optional)">
        <input className="p-input" value={studentQ} placeholder="Search student…"
          onChange={e => { setStudentQ(e.target.value); setStudentId(''); }} />
        {!studentId && studentOptions.length ? (
          <div className="mt-1 space-y-0.5">
            {studentOptions.map(o => (
              <button type="button" key={o.id} className="w-full rounded-lg px-3 py-2 text-left text-xs hover:bg-slate-50"
                onClick={() => { setStudentId(o.id); setStudentQ(o.name); }}>
                {o.name}
              </button>
            ))}
          </div>
        ) : null}
      </Field>
      <Field label="Linked school (optional)">
        <input className="p-input" value={schoolQ} placeholder="Search school…"
          onChange={e => { setSchoolQ(e.target.value); setSchoolId(''); }} />
        {!schoolId && schoolOptions.length ? (
          <div className="mt-1 space-y-0.5">
            {schoolOptions.map(o => (
              <button type="button" key={o.id} className="w-full rounded-lg px-3 py-2 text-left text-xs hover:bg-slate-50"
                onClick={() => { setSchoolId(o.id); setSchoolQ(o.name); }}>
                {o.name}
              </button>
            ))}
          </div>
        ) : null}
      </Field>
      {isAdmin ? null : <p className="text-xs text-slate-500">You can assign tasks to any team member (peer tasks enabled).</p>}
      {error ? <p className="text-sm font-medium text-rose-600">{error}</p> : null}
      <button className="p-btn-primary w-full" disabled={busy || !assignee}>
        {busy ? 'Creating…' : 'Create task'}
      </button>
    </form>
  );
}
