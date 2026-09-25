/**
 * Students — search (multi-criteria), list, register, canonical profile
 * with lifecycle journey. Employees and Main Admin share the screen;
 * selection/enrollment actions surface only where the API allows them.
 */

import { useCallback, useEffect, useState } from 'react';
import { petStudents, getPetUser, PetApiFailure } from '../services/petApi';
import type { PetStudent, StudentStatus, StudentStatusHistoryEntry, PetTask } from '../types/pet';
import { Badge, Card, EmptyState, Field, Modal, Spinner, studentStatusTone } from '../ui';
import { RegisterStudentForm } from './students_shared';

const FILTERS: Array<{ key: StudentStatus | ''; label: string }> = [
  { key: '', label: 'All' },
  { key: 'registered', label: 'Registered' },
  { key: 'test_scheduled', label: 'Test Scheduled' },
  { key: 'test_completed', label: 'Test Completed' },
  { key: 'under_evaluation', label: 'Evaluating' },
  { key: 'selected', label: 'Selected' },
  { key: 'waitlisted', label: 'Waitlisted' },
  { key: 'not_selected', label: 'Not selected' },
  { key: 'enrolled', label: 'Enrolled' },
  { key: 'inactive', label: 'Inactive' },
];

export function StudentsPage() {
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const [students, setStudents] = useState<PetStudent[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showRegister, setShowRegister] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params: Record<string, string> = {};
      if (q.trim()) params.q = q.trim();
      if (status) params.status = status;
      const res = await petStudents.search(params);
      setStudents(res.students);
      setTotal(res.total);
      setError('');
    } catch (err) {
      setError(err instanceof PetApiFailure ? err.message : 'Could not load students.');
    } finally {
      setLoading(false);
    }
  }, [q, status]);

  useEffect(() => {
    const t = setTimeout(() => void load(), 250);
    return () => clearTimeout(t);
  }, [load]);

  return (
    <div className="space-y-3">
      <div className="flex gap-2">
        <input className="p-input flex-1" placeholder="Search name, PET ID, phone, parent, district…"
          value={q} onChange={e => setQ(e.target.value)} />
        <button className="p-btn-primary shrink-0" onClick={() => setShowRegister(true)}>+ New</button>
      </div>
      <div className="-mx-1 flex gap-1.5 overflow-x-auto px-1 pb-1">
        {FILTERS.map(f => (
          <button key={f.key}
            className={`shrink-0 rounded-full px-3 py-1.5 text-xs font-semibold ${status === f.key ? 'bg-pet-800 text-white' : 'bg-white text-slate-600 border border-slate-200'}`}
            onClick={() => setStatus(f.key)}>
            {f.label}
          </button>
        ))}
      </div>
      <p className="text-xs text-slate-500">{total} student{total === 1 ? '' : 's'}</p>
      {error ? (
        <div className="flex items-start justify-between gap-3 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">
          <span>{error}</span>
          <button className="font-semibold underline" onClick={() => void load()}>Retry</button>
        </div>
      ) : null}

      {loading ? <Spinner /> : students.length === 0 ? (
        <Card><EmptyState title="No students found" hint="Try a different search or lifecycle filter." /></Card>
      ) : (
        <div className="space-y-2">
          {students.map(s => (
            <button key={s.id} className="p-card w-full p-3.5 text-left" onClick={() => setSelectedId(s.id)}>
              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <p className="truncate text-sm font-bold text-slate-900">{s.name}</p>
                  <p className="text-xs text-slate-500">
                    {s.pet_student_id} · {s.school_name || 'No school'}{s.district ? ` · ${s.district}` : ''}
                  </p>
                </div>
                <Badge tone={studentStatusTone(s.status)}>{s.status.replaceAll('_', ' ')}</Badge>
              </div>
            </button>
          ))}
        </div>
      )}

      {showRegister ? (
        <Modal title="Register Student" onClose={() => setShowRegister(false)}>
          <RegisterStudentForm onDone={async () => { setShowRegister(false); await load(); }} />
        </Modal>
      ) : null}

      {selectedId ? <StudentProfileModal id={selectedId} onClose={() => { setSelectedId(null); void load(); }} /> : null}
    </div>
  );
}

interface ProfileData {
  student: PetStudent;
  journey: StudentStatusHistoryEntry[];
  tests: Array<Record<string, unknown>>;
  results: Array<Record<string, unknown>>;
  enrollment: Record<string, unknown> | null;
  documents: Array<Record<string, unknown>>;
  tasks: PetTask[];
  visits: Array<Record<string, unknown>>;
}

const NEXT_STEPS: Record<string, StudentStatus[]> = {
  registered: ['test_scheduled'],
  test_scheduled: ['test_completed'],
  test_completed: ['under_evaluation'],
  under_evaluation: ['selected', 'waitlisted', 'not_selected'],
  selected: ['enrolled'],
  waitlisted: ['selected', 'not_selected', 'enrolled'],
  not_selected: ['registered', 'inactive'],
  inactive: ['registered'],
};

function StudentProfileModal({ id, onClose }: { id: string; onClose: () => void }) {
  const [data, setData] = useState<ProfileData | null>(null);
  const [error, setError] = useState('');
  const [busyStatus, setBusyStatus] = useState(false);
  const [editing, setEditing] = useState(false);
  const isAdmin = getPetUser()?.role === 'main_admin';

  const load = useCallback(async () => {
    try { setData((await petStudents.profile(id)) as unknown as ProfileData); }
    catch (err) { setError(err instanceof PetApiFailure ? err.message : 'Profile unavailable.'); }
  }, [id]);
  useEffect(() => { void load(); }, [load]);

  async function advance(to: StudentStatus) {
    if (!data) return;
    const reason = window.prompt(`Optional reason for moving this student to “${to.replaceAll('_', ' ')}”:`, '') ?? '';
    setBusyStatus(true);
    try {
      await petStudents.changeStatus(data.student.id, to, reason.trim() || undefined);
      await load();
    } catch (err) {
      setError(err instanceof PetApiFailure ? err.message : 'Status change failed.');
    } finally {
      setBusyStatus(false);
    }
  }

  if (!data) {
    return (
      <Modal title="Student Profile" onClose={onClose}>
        {error ? <EmptyState title="Could not load" hint={error} /> : <Spinner />}
      </Modal>
    );
  }
  const { student, journey, tests, results, enrollment, documents, tasks } = data;
  const nextSteps = (NEXT_STEPS[student.status] ?? []).filter(s =>
    isAdmin || !['selected', 'waitlisted', 'not_selected', 'enrolled'].includes(s));

  return (
    <Modal title={student.name} onClose={onClose}>
      <div className="space-y-4">
        <div className="flex items-center justify-between gap-2">
          <div>
            <p className="text-xs font-bold text-pet-800">{student.pet_student_id}</p>
            <p className="text-xs text-slate-500">
              {student.current_class ? `Class ${student.current_class} · ` : ''}
              {student.school_name || 'No school'}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Badge tone={studentStatusTone(student.status)}>{student.status.replaceAll('_', ' ')}</Badge>
            <button className="p-btn-ghost !min-h-8 !px-2.5 text-xs" onClick={() => setEditing(value => !value)}>
              {editing ? 'Close edit' : 'Edit'}
            </button>
          </div>
        </div>

        {editing ? (
          <EditStudentForm
            student={student}
            onCancel={() => setEditing(false)}
            onSaved={async () => { setEditing(false); await load(); }}
          />
        ) : null}

        <div className="grid grid-cols-2 gap-x-3 gap-y-1.5 text-xs">
          <KV k="Parent" v={student.parent_name} />
          <KV k="Parent phone" v={student.parent_phone} />
          <KV k="Student phone" v={student.student_phone} />
          <KV k="DOB" v={student.dob} />
          <KV k="District" v={student.district} />
          <KV k="Registered by" v={student.registered_by_user_name} />
          <KV k="Source" v={student.registration_source?.replaceAll('_', ' ')} />
          <KV k="Since" v={student.registration_date?.slice(0, 10)} />
        </div>

        {nextSteps.length ? (
          <div>
            <p className="p-label">Next step</p>
            <div className="flex flex-wrap gap-2">
              {nextSteps.map(to => (
                <button key={to} className="p-btn-primary !min-h-9 !px-3 text-xs" disabled={busyStatus}
                  onClick={() => advance(to)}>
                  → {to.replaceAll('_', ' ')}
                </button>
              ))}
            </div>
          </div>
        ) : null}
        {error ? <p className="text-sm font-medium text-rose-600">{error}</p> : null}

        <section>
          <p className="p-label">Journey</p>
          <ol className="relative space-y-2.5 border-l-2 border-slate-200 pl-4">
            {journey.map(j => (
              <li key={j.id} className="text-xs">
                <span className="absolute -left-[5px] mt-1 h-2 w-2 rounded-full bg-pet-700" />
                <p className="font-semibold text-slate-800">
                  {j.from_status ? `${j.from_status.replaceAll('_', ' ')} → ` : ''}
                  {j.to_status.replaceAll('_', ' ')}
                </p>
                <p className="text-slate-500">
                  {j.changed_by_user_name} · {new Date(j.created_at).toLocaleDateString()}
                  {j.reason ? ` · ${j.reason}` : ''}
                </p>
              </li>
            ))}
          </ol>
        </section>

        {tests.length ? (
          <section>
            <p className="p-label">Tests</p>
            {tests.map((t: Record<string, unknown>, i) => (
              <p key={i} className="text-xs text-slate-700">
                {String(t.test_name)} — {String(t.assignment_status)}
                {t.percentage != null ? ` · ${t.percentage}%` : ''}
                {t.evaluation_result ? ` · ${String(t.evaluation_result).replaceAll('_', ' ')}` : ''}
              </p>
            ))}
          </section>
        ) : null}

        {results.length ? (
          <section>
            <p className="p-label">Marks</p>
            {results.map((r: Record<string, unknown>, i) => (
              <p key={i} className="text-xs text-slate-700">
                {String(r.subject)}: {String(r.obtained_marks)}/{String(r.max_marks)}
              </p>
            ))}
          </section>
        ) : null}

        {enrollment ? (
          <section>
            <p className="p-label">Enrollment</p>
            <p className="text-xs text-slate-700">
              Stage: {String(enrollment.stage).replaceAll('_', ' ')} · status: {String(enrollment.status)}
            </p>
          </section>
        ) : null}

        <div className="flex gap-3 text-xs text-slate-500">
          <span>📄 {documents.length} documents</span>
          <span>✅ {tasks.length} tasks</span>
        </div>
      </div>
    </Modal>
  );
}

function EditStudentForm({
  student,
  onCancel,
  onSaved,
}: {
  student: PetStudent;
  onCancel: () => void;
  onSaved: () => Promise<void>;
}) {
  const [form, setForm] = useState({
    name: student.name,
    current_class: student.current_class ?? '',
    parent_name: student.parent_name ?? '',
    parent_phone: student.parent_phone ?? '',
    student_phone: student.student_phone ?? '',
    district: student.district ?? '',
    city: student.city ?? '',
    notes: student.notes ?? '',
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  function set(key: keyof typeof form, value: string) {
    setForm(current => ({ ...current, [key]: value }));
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      await petStudents.update(student.id, {
        name: form.name.trim(),
        current_class: form.current_class.trim() || null,
        parent_name: form.parent_name.trim() || null,
        parent_phone: form.parent_phone.trim() || null,
        student_phone: form.student_phone.trim() || null,
        district: form.district.trim() || null,
        city: form.city.trim() || null,
        notes: form.notes.trim() || null,
      });
      await onSaved();
    } catch (err) {
      setError(err instanceof PetApiFailure ? err.message : 'Could not update the student.');
      setBusy(false);
    }
  }

  return (
    <form className="space-y-3 rounded-2xl border border-pet-100 bg-pet-50/60 p-3" onSubmit={submit}>
      <p className="p-label !mb-0">Edit student details</p>
      <Field label="Full name *">
        <input className="p-input" value={form.name} onChange={event => set('name', event.target.value)} required minLength={2} />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Current class"><input className="p-input" value={form.current_class} onChange={event => set('current_class', event.target.value)} /></Field>
        <Field label="Student phone"><input className="p-input" inputMode="tel" value={form.student_phone} onChange={event => set('student_phone', event.target.value)} /></Field>
        <Field label="Parent/guardian"><input className="p-input" value={form.parent_name} onChange={event => set('parent_name', event.target.value)} /></Field>
        <Field label="Parent phone"><input className="p-input" inputMode="tel" value={form.parent_phone} onChange={event => set('parent_phone', event.target.value)} /></Field>
        <Field label="District"><input className="p-input" value={form.district} onChange={event => set('district', event.target.value)} /></Field>
        <Field label="City"><input className="p-input" value={form.city} onChange={event => set('city', event.target.value)} /></Field>
      </div>
      <Field label="Notes"><textarea className="p-input" rows={2} value={form.notes} onChange={event => set('notes', event.target.value)} /></Field>
      {error ? <p className="text-sm font-medium text-rose-600">{error}</p> : null}
      <div className="flex gap-2">
        <button className="p-btn-primary flex-1" disabled={busy}>{busy ? 'Saving…' : 'Save changes'}</button>
        <button type="button" className="p-btn-ghost" onClick={onCancel} disabled={busy}>Cancel</button>
      </div>
    </form>
  );
}

function KV({ k, v }: { k: string; v: string | null | undefined }) {
  return (
    <div>
      <p className="font-semibold text-slate-400">{k}</p>
      <p className="font-medium text-slate-800">{v || '—'}</p>
    </div>
  );
}
