/**
 * Chat — direct + group conversations, unread counts computed from each
 * member's `last_read_at` (reading a thread marks it read server-side).
 */
'use strict';

const { notFound, forbidden, badRequest } = require('../lib/errors');
const { uuid, now } = require('../lib/ids');
const { tx } = require('../db');
const { logAction } = require('../lib/audit');
const { notify } = require('../lib/notify');
const { toMessage } = require('./serialize');

function membersOf(db, conversationId) {
  return db
    .prepare(
      `SELECT cm.user_id, cm.last_read_at, u.name, u.role
         FROM conversation_members cm JOIN users u ON u.id = cm.user_id
        WHERE cm.conversation_id = ?
        ORDER BY u.name COLLATE NOCASE`,
    )
    .all(conversationId);
}

function unreadFor(db, conversationId, userId, lastReadAt) {
  const params = [conversationId, userId];
  let sql = `SELECT COUNT(*) AS c FROM chat_messages WHERE conversation_id = ? AND sender_id <> ?`;
  if (lastReadAt) {
    sql += ' AND created_at > ?';
    params.push(lastReadAt);
  }
  return Number(db.prepare(sql).get(...params).c);
}

function conversationRow(db, id, userId) {
  const row = db.prepare('SELECT * FROM conversations WHERE id = ?').get(String(id || ''));
  if (!row) throw notFound('Conversation not found.');
  const isMember = db
    .prepare('SELECT 1 AS x FROM conversation_members WHERE conversation_id = ? AND user_id = ?')
    .get(row.id, userId);
  if (!isMember) throw forbidden('You are not part of this conversation.');
  return row;
}

function decorate(db, row, userId) {
  const members = membersOf(db, row.id);
  const me = members.find(m => m.user_id === userId);
  const last = db
    .prepare('SELECT text FROM chat_messages WHERE conversation_id = ? ORDER BY created_at DESC, id DESC LIMIT 1')
    .get(row.id);
  return {
    id: row.id,
    type: row.type,
    title: row.title,
    created_by_user_id: row.created_by_user_id,
    last_message_at: row.last_message_at,
    created_at: row.created_at,
    members: members.map(m => ({ user_id: m.user_id, name: m.name, role: m.role })),
    unread_count: unreadFor(db, row.id, userId, me ? me.last_read_at : null),
    last_message: last ? last.text : null,
  };
}

function listConversations(db, userId) {
  const rows = db
    .prepare(
      `SELECT c.* FROM conversations c
         JOIN conversation_members cm ON cm.conversation_id = c.id
        WHERE cm.user_id = ?
        ORDER BY COALESCE(c.last_message_at, c.created_at) DESC`,
    )
    .all(userId);
  return { conversations: rows.map(r => decorate(db, r, userId)) };
}

function unreadCount(db, userId) {
  const rows = db
    .prepare(
      `SELECT c.id, COALESCE(cm.last_read_at, '') AS last_read_at
         FROM conversations c JOIN conversation_members cm ON cm.conversation_id = c.id
        WHERE cm.user_id = ?`,
    )
    .all(userId);
  let total = 0;
  for (const r of rows) total += unreadFor(db, r.id, userId, r.last_read_at || null);
  return { unread: total };
}

function openDirect(db, user, otherId) {
  return tx(db, () => {
    const other = db.prepare('SELECT * FROM users WHERE id = ?').get(String(otherId || ''));
    if (!other) throw notFound('That team member does not exist.');
    if (other.id === user.id) throw badRequest('Pick someone else to chat with.');

    const existing = db
      .prepare(
        `SELECT c.id FROM conversations c
          WHERE c.type = 'direct'
            AND EXISTS (SELECT 1 FROM conversation_members m WHERE m.conversation_id = c.id AND m.user_id = ?)
            AND EXISTS (SELECT 1 FROM conversation_members m WHERE m.conversation_id = c.id AND m.user_id = ?)
          LIMIT 1`,
      )
      .get(user.id, other.id);
    if (existing) {
      return { conversation: decorate(db, db.prepare('SELECT * FROM conversations WHERE id = ?').get(existing.id), user.id) };
    }

    const ts = now();
    const id = uuid();
    db.prepare(
      'INSERT INTO conversations (id, type, title, created_by_user_id, created_at) VALUES (?, ?, NULL, ?, ?)',
    ).run(id, 'direct', user.id, ts);
    const addMember = db.prepare(
      'INSERT INTO conversation_members (conversation_id, user_id, joined_at, last_read_at) VALUES (?, ?, ?, ?)',
    );
    addMember.run(id, user.id, ts, ts);
    addMember.run(id, other.id, ts, ts);
    return { conversation: decorate(db, db.prepare('SELECT * FROM conversations WHERE id = ?').get(id), user.id) };
  });
}

function createGroup(db, user, title, memberIds = []) {
  return tx(db, () => {
    const cleanTitle = String(title || '').trim();
    if (!cleanTitle) throw badRequest('Give the group a title.');
    const unique = [...new Set(memberIds.map(String))].filter(id => id && id !== user.id);
    const members = [user];
    for (const id of unique) {
      const row = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
      if (!row) throw notFound(`Team member ${id} not found.`);
      members.push(row);
    }
    const ts = now();
    const id = uuid();
    db.prepare(
      'INSERT INTO conversations (id, type, title, created_by_user_id, created_at) VALUES (?, ?, ?, ?, ?)',
    ).run(id, 'group', cleanTitle, user.id, ts);
    const addMember = db.prepare(
      'INSERT INTO conversation_members (conversation_id, user_id, joined_at, last_read_at) VALUES (?, ?, ?, ?)',
    );
    for (const m of members) addMember.run(id, m.id, ts, m.id === user.id ? ts : null);
    logAction(db, {
      actorId: user.id,
      actorLabel: user.name,
      action: 'PET_CHAT_GROUP_CREATED',
      targetType: 'conversation',
      targetId: id,
      metadata: { title: cleanTitle, members: members.length },
    });
    return { conversation: decorate(db, db.prepare('SELECT * FROM conversations WHERE id = ?').get(id), user.id) };
  });
}

function listMessages(db, user, conversationId, { limit = 100, before = null } = {}) {
  const convo = conversationRow(db, conversationId, user.id);
  const params = [convo.id];
  let sql = 'SELECT * FROM chat_messages WHERE conversation_id = ?';
  if (before) {
    sql += ' AND created_at < ?';
    params.push(before);
  }
  sql += ' ORDER BY created_at DESC, id DESC LIMIT ?';
  params.push(limit);
  const rows = db.prepare(sql).all(...params);
  rows.reverse(); // oldest → newest for natural scroll order
  // Opening the thread marks it read for this member.
  db.prepare(
    'UPDATE conversation_members SET last_read_at = ? WHERE conversation_id = ? AND user_id = ?',
  ).run(now(), convo.id, user.id);
  return { messages: rows.map(toMessage) };
}

function sendMessage(db, user, conversationId, input) {
  return tx(db, () => {
    const convo = conversationRow(db, conversationId, user.id);
    const text = String(input.text || '').trim();
    if (!text && !(input.attachment_paths || []).length) throw badRequest('Message cannot be empty.');

    const ts = now();
    const id = uuid();
    const attachments =
      input.attachment_paths && input.attachment_paths.length
        ? JSON.stringify(input.attachment_paths)
        : null;
    db.prepare(
      `INSERT INTO chat_messages (id, conversation_id, sender_id, sender_name, text, attachment_paths,
                                  linked_task_id, linked_student_id, linked_school_id, linked_visit_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      convo.id,
      user.id,
      user.name,
      text,
      attachments,
      input.linked_task_id ?? null,
      input.linked_student_id ?? null,
      input.linked_school_id ?? null,
      input.linked_visit_id ?? null,
      ts,
    );
    db.prepare('UPDATE conversations SET last_message_at = ? WHERE id = ?').run(ts, convo.id);
    db.prepare(
      'UPDATE conversation_members SET last_read_at = ? WHERE conversation_id = ? AND user_id = ?',
    ).run(ts, convo.id, user.id);

    const label =
      convo.type === 'group' ? `New message in ${convo.title || 'group'}` : `Message from ${user.name}`;
    for (const m of membersOf(db, convo.id)) {
      if (m.user_id === user.id) continue;
      notify(db, {
        userId: m.user_id,
        title: label,
        message: text.slice(0, 140),
        type: 'chat',
        linkType: 'conversation',
        linkId: convo.id,
      });
    }
    return { message: toMessage(db.prepare('SELECT * FROM chat_messages WHERE id = ?').get(id)) };
  });
}

module.exports = {
  listConversations,
  unreadCount,
  openDirect,
  createGroup,
  listMessages,
  sendMessage,
  decorate,
  conversationRow,
};
