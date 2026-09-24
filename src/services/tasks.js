/**
 * Tasks — creation, guarded status flow, reassignment. Every change writes a
 * task_events row (the detail screen's trail) and notifies people.
 */
'use strict';

const { ApiError, notFound, forbidden, badRequest } = require('../lib/errors');
const { uuid, now } = require('../lib/ids');
const { tx } = require('../db');
const { logAction } = require('../lib/audit');
const { notify } = require('../lib/notify');
const { toTask, toTaskEvent } = require('./serialize');

const STATUS_FLOW = {
  pending: ['accepted', 'in_progress', 'cancelled'],
  accepted: ['in_progress', 'cancelled'],
  in_progress: ['submitted', 'completed', 'cancelled'],
  submitted: ['completed', 'cancelled'],
  completed: [],
  cancelled: ['pending'], // reopen (admin / creator)
};

const PRIORITIES = ['low', 'normal', 'high', 'urgent'];
const STATUSES = ['pending', 'accepted', 'in_progress', 'submitted', 'completed', 'cancelled'];

function canModerate(task, user) {
  return (
    user.role === 'main_admin' ||
    task.assigned_to_user_id === user.id ||
    task.created_by_user_id === user.id
  );
}

/**
 * Visibility: Main Admin sees everything; an employee sees tasks they are
 * assigned or created (peer tasks are creatable by anyone).
 */
function listTasks(db, user, { status = null, assigned_to_user_id = null, limit = 50, offset = 0 }) {
  const where = [];
  const params = [];
  if (user.role !== 'main_admin') {
    where.push('(t.assigned_to_user_id = ? OR t.created_by_user_id = ?)');
    params.push(user.id, user.id);
  }
  if (status) {
    where.push('t.status = ?');
    params.push(status);
  } else {
    where.push(`t.status NOT IN ('completed', 'cancelled')`);
  }
  if (assigned_to_user_id) {
    where.push('t.assigned_to_user_id = ?');
    params.push(assigned_to_user_id);
  }
  const clause = `WHERE ${where.join(' AND ')}`;
  const total = Number(db.prepare(`SELECT COUNT(*) AS c FROM tasks t ${clause}`).get(...params).c);
  const rows = db
    .prepare(
      `SELECT t.* FROM tasks t ${clause}
        ORDER BY CASE t.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END,
                 t.due_date IS NULL, t.due_date, t.created_at DESC
        LIMIT ? OFFSET ?`,
    )
    .all(...params, limit, offset);
  return { total, tasks: rows.map(toTask) };
}

function taskDetail(db, id) {
  const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(String(id || ''));
  if (!row) throw notFound('Task not found.');
  const events = db
    .prepare('SELECT * FROM task_events WHERE task_id = ? ORDER BY created_at ASC, id ASC')
    .all(row.id);
  return { task: toTask(row), events: events.map(toTaskEvent) };
}

function addEvent(db, taskId, actor, type, from, to, note) {
  db.prepare(
    `INSERT INTO task_events (id, task_id, actor_user_id, actor_user_name, event_type, from_status, to_status, note, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(uuid(), taskId, actor.id, actor.name, type, from ?? null, to ?? null, note ?? null, now());
}

function createTask(db, user, input, { ip = null } = {}) {
  return tx(db, () => {
    const assignee = db.prepare('SELECT * FROM users WHERE id = ?').get(String(input.assigned_to_user_id || ''));
    if (!assignee) throw badRequest('Assignee not found.');
    if (assignee.status !== 'ACTIVE') throw badRequest('That account is disabled.');
    if (input.school_id) {
      const school = db.prepare('SELECT id FROM schools WHERE id = ?').get(input.school_id);
      if (!school) throw badRequest('Linked school not found.');
    }
    if (input.student_id) {
      const student = db.prepare('SELECT id FROM students WHERE id = ?').get(input.student_id);
      if (!student) throw badRequest('Linked student not found.');
    }

    const ts = now();
    const id = uuid();
    db.prepare(
      `INSERT INTO tasks (id, title, description, created_by_user_id, created_by_user_name,
                          assigned_to_user_id, assigned_to_user_name, priority, status, due_date,
                          school_id, student_id, visit_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      input.title,
      input.description ?? null,
      user.id,
      user.name,
      assignee.id,
      assignee.name,
      input.priority || 'normal',
      input.due_date ?? null,
      input.school_id ?? null,
      input.student_id ?? null,
      input.visit_id ?? null,
      ts,
      ts,
    );
    addEvent(db, id, user, 'created', null, 'pending', null);
    notify(db, {
      userId: assignee.id,
      title: 'New task assigned',
      message: input.title,
      type: 'task',
      linkType: 'task',
      linkId: id,
    });
    logAction(db, {
      actorId: user.id,
      actorLabel: user.name,
      action: 'PET_TASK_CREATED',
      targetType: 'task',
      targetId: id,
      metadata: { title: input.title, assigned_to: assignee.name },
      ip,
    });
    return { task: toTask(db.prepare('SELECT * FROM tasks WHERE id = ?').get(id)) };
  });
}

function changeTaskStatus(db, user, id, status, note = null, { ip = null } = {}) {
  return tx(db, () => {
    const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(String(id));
    if (!task) throw notFound('Task not found.');
    if (!STATUSES.includes(status)) throw badRequest(`Unknown status '${status}'.`);
    if (task.status === status) return { task: toTask(task) };
    if (!canModerate(task, user)) {
      throw forbidden('Only the assignee, the creator, or a Main Admin can change this task.');
    }
    const allowed = STATUS_FLOW[task.status] || [];
    if (!allowed.includes(status)) {
      throw new ApiError(400, 'INVALID_TRANSITION', `Cannot move a ${task.status} task to ${status}.`, {
        from: task.status,
        to: status,
        allowed,
      });
    }
    const ts = now();
    db.prepare(
      'UPDATE tasks SET status = ?, completed_at = ?, updated_at = ? WHERE id = ?',
    ).run(status, status === 'completed' ? ts : null, ts, task.id);
    addEvent(db, task.id, user, 'status_change', task.status, status, note);

    const notifyTarget = task.assigned_to_user_id === user.id ? task.created_by_user_id : task.assigned_to_user_id;
    notify(db, {
      userId: notifyTarget,
      title: `Task ${status.replace('_', ' ')}`,
      message: task.title,
      type: 'task',
      linkType: 'task',
      linkId: task.id,
    });
    logAction(db, {
      actorId: user.id,
      actorLabel: user.name,
      action: 'PET_TASK_STATUS_CHANGED',
      targetType: 'task',
      targetId: task.id,
      metadata: { from: task.status, to: status, note },
      ip,
    });
    return { task: toTask(db.prepare('SELECT * FROM tasks WHERE id = ?').get(task.id)) };
  });
}

function reassignTask(db, user, id, assigneeId, note = null, { ip = null } = {}) {
  return tx(db, () => {
    const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(String(id));
    if (!task) throw notFound('Task not found.');
    if (user.role !== 'main_admin' && task.created_by_user_id !== user.id) {
      throw forbidden('Only the creator or a Main Admin can reassign a task.');
    }
    if (['completed', 'cancelled'].includes(task.status)) {
      throw badRequest('Finished tasks cannot be reassigned.');
    }
    const assignee = db.prepare('SELECT * FROM users WHERE id = ?').get(String(assigneeId || ''));
    if (!assignee) throw badRequest('Assignee not found.');
    if (assignee.status !== 'ACTIVE') throw badRequest('That account is disabled.');

    const ts = now();
    db.prepare(
      'UPDATE tasks SET assigned_to_user_id = ?, assigned_to_user_name = ?, updated_at = ? WHERE id = ?',
    ).run(assignee.id, assignee.name, ts, task.id);
    addEvent(db, task.id, user, 'reassigned', null, null, note || `Reassigned to ${assignee.name}`);
    notify(db, {
      userId: assignee.id,
      title: 'Task reassigned to you',
      message: task.title,
      type: 'task',
      linkType: 'task',
      linkId: task.id,
    });
    logAction(db, {
      actorId: user.id,
      actorLabel: user.name,
      action: 'PET_TASK_REASSIGNED',
      targetType: 'task',
      targetId: task.id,
      metadata: { to: assignee.name, note },
      ip,
    });
    return { task: toTask(db.prepare('SELECT * FROM tasks WHERE id = ?').get(task.id)) };
  });
}

module.exports = {
  STATUS_FLOW,
  PRIORITIES,
  STATUSES,
  listTasks,
  taskDetail,
  createTask,
  changeTaskStatus,
  reassignTask,
};
