/**
 * In-app notifications. The frontend polls GET /me/notifications and shows
 * an unread badge; chat pushes one notification per non-sender member, and
 * task assignment/reassignment notifies the assignee.
 */
'use strict';

const { uuid, now } = require('./ids');

function notify(db, { userId, title, message = '', type = 'info', linkType = null, linkId = null }) {
  if (!userId) return;
  db.prepare(
    `INSERT INTO notifications (id, user_id, title, message, type, is_read, link_type, link_id, created_at)
     VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?)`,
  ).run(uuid(), userId, title, message, type, linkType, linkId, now());
}

function listNotifications(db, userId) {
  const rows = db
    .prepare('SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT 100')
    .all(userId);
  const unread = Number(
    db
      .prepare('SELECT COUNT(*) AS c FROM notifications WHERE user_id = ? AND is_read = 0')
      .get(userId).c,
  );
  return {
    unread,
    notifications: rows.map(r => ({
      id: r.id,
      user_id: r.user_id,
      title: r.title,
      message: r.message,
      type: r.type,
      is_read: r.is_read ? 1 : 0,
      link_type: r.link_type,
      link_id: r.link_id,
      created_at: r.created_at,
    })),
  };
}

function markRead(db, userId, ids) {
  if (ids && ids.length) {
    const stmt = db.prepare(
      'UPDATE notifications SET is_read = 1 WHERE user_id = ? AND id = ?',
    );
    for (const id of ids) stmt.run(userId, String(id));
    return { read: true };
  }
  db.prepare('UPDATE notifications SET is_read = 1 WHERE user_id = ?').run(userId);
  return { read: true };
}

module.exports = { notify, listNotifications, markRead };
