/**
 * Audit trail — every meaningful mutation lands in `audit_log`, which the
 * Admin dashboard renders as "Recent activity" (actions are shown after
 * stripping the PET_ prefix, so action names are written PET_VERB_NOUN).
 */
'use strict';

const { uuid, now } = require('./ids');
const { parseJson, toJson } = require('./http');

function logAction(db, { actorId = null, actorLabel = null, action, targetType = null, targetId = null, metadata = null, ip = null }) {
  db.prepare(
    `INSERT INTO audit_log (actor_type, actor_id, actor_label, action, target_type, target_id, metadata, ip, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    actorId ? 'user' : 'system',
    actorId,
    actorLabel,
    action,
    targetType,
    targetId,
    metadata === null ? null : toJson(metadata),
    ip,
    now(),
  );
}

function listActivity(db, { limit = 50, offset = 0 }) {
  const total = Number(db.prepare('SELECT COUNT(*) AS c FROM audit_log').get().c);
  const rows = db
    .prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT ? OFFSET ?')
    .all(limit, offset);
  return {
    total,
    activity: rows.map(r => ({
      id: Number(r.id),
      actor_type: r.actor_type,
      actor_id: r.actor_id,
      actor_label: r.actor_label,
      action: r.action,
      target_type: r.target_type,
      target_id: r.target_id,
      metadata: parseJson(r.metadata),
      ip: r.ip,
      created_at: r.created_at,
    })),
  };
}

module.exports = { logAction, listActivity };
