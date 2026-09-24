# PET API reference

Base URL: `/api` on the server origin. Health check lives at the **origin root**: `GET /health`.

Conventions:

* **Auth** — `Authorization: Bearer <access_token>` on everything except `POST /api/auth/login`, `POST /api/auth/refresh`, `POST /api/auth/logout`, and `GET /health`.
* **Errors** — `{ "error": { "code", "message", "details"? } }`. Codes the client branches on: `UNAUTHORIZED`, `TOKEN_EXPIRED`, `INVALID_CREDENTIALS`, `FORBIDDEN`, `NOT_FOUND`, `VALIDATION_ERROR`, `POSSIBLE_DUPLICATES`, `INVALID_TRANSITION`, `ACTIVE_VISIT_EXISTS`, `RATE_LIMITED`, `PASSWORD_POLICY`, `UNSUPPORTED_MEDIA`, `PAYLOAD_TOO_LARGE`, `EMAIL_TAKEN`, `CONFLICT`.
* **Validation failures** include `details.fields` — a map of field → message.
* **Pagination** — `?limit=&offset=`; list responses return `{ …, total }`.
* **Search** — `?q=` on list endpoints plus dedicated `GET /api/search`.
* **Roles** — `main_admin` (everything) and `employee` (field work). Server-side enforced; the UI's hidden buttons are cosmetic.

---

## Health & build

| Method | Path | Auth | Returns |
|---|---|---|---|
| GET | `/health` | — | `{status:"ok", service, version, driver, uptime_seconds, time}` |
| GET | `/build-info.json` | — | Frontend build descriptor (404 when no SPA deployed) |

## Auth — `/api/auth`

| Method | Path | Auth | Body → Returns |
|---|---|---|---|
| POST | `/login` | — | `{email, password}` → `{access_token, token_type:"Bearer", expires_in, refresh_token, user}` |
| POST | `/refresh` | — | `{refresh_token}` → same session shape (old token is rotated out; reuse revokes the family) |
| POST | `/logout` | — | `{refresh_token}` → `{ok:true}` (idempotent) |
| POST | `/change-password` | access | `{current_password, new_password}` → `{changed:true, re_login_required:true}` — revokes all sessions |

Password policy: ≥ 8 chars, one letter, one number. Failed logins rate-limited per IP.

## Me — `/api/me`

| Method | Path | Returns |
|---|---|---|
| GET | `/` | `{user}` |
| GET | `/dashboard` | `{my_tasks, active_visit, attendance_today, unread_messages, unread_notifications, my_students, recent_visits}` |
| GET | `/attendance/today` | `{record: EmployeeAttendance \| null}` |
| GET | `/notifications` | `{notifications, unread}` |
| POST | `/notifications/read` | `{ids?}` → `{read:true}` (no ids = mark all) |
| GET | `/directory` | `{members:[{id,name,role,employee_code,department}]}` — active staff for pickers |

## Employees — `/api/employees` *(main_admin only)*

| Method | Path | Body → Returns |
|---|---|---|
| GET | `/?q=&status=&limit=&offset=` | `{employees, total}` |
| POST | `/` | `{name, email, phone?, department?, joining_date?}` → `{user, temporaryPassword}` — password shown once, `must_change_password=true` |
| PATCH | `/:id` | `{name?, email?, phone?, department?}` → `{employee}` (renames cascade to denormalized copies) |
| POST | `/:id/status` | `{status: "ACTIVE"\|"DISABLED"}` → `{employee}` — disabling revokes all sessions |
| POST | `/:id/reset-access` | `{}` → `{user, temporaryPassword}` — revokes all sessions |

## Students — `/api/students`

| Method | Path | Notes |
|---|---|---|
| GET | `/?q=&status=&school_id=` | `{students, total}` — q matches name, PET ID, phones, parent, district |
| POST | `/` | Registration input (see `StudentRegistrationInput`) + optional `photo_data` → `201 {student, duplicates}`; **409 POSSIBLE_DUPLICATES** with `details.duplicates[]` unless `acknowledge_duplicates:true` |
| POST | `/duplicates-check` | `{name, parent_phone?, student_phone?, school_id?, dob?}` → `{duplicates}` with `reasons[]` |
| GET | `/:id` | `{student}` |
| GET | `/:id/profile` | `{student, journey, tests, results, enrollment, documents, tasks, visits}` |
| PATCH | `/:id` | Field updates (not status) → `{student}` |
| POST | `/:id/status` | `{to_status, reason?}` → `{student}` — validated lifecycle transitions; `selected/waitlisted/not_selected/enrolled` are admin-only |

Lifecycle: `registered → test_scheduled → test_completed → under_evaluation → {selected|waitlisted|not_selected}`; `selected → enrolled`; `not_selected → inactive|registered`; `inactive → registered`.

## Schools — `/api/schools`

| Method | Path | Notes |
|---|---|---|
| GET | `/?q=&status=` | `{schools, total}` |
| POST | `/` | `{name, address?, …}` → `201 {school}` (issues `SCH-0001` code) |
| GET | `/:id` | `{school}` |
| GET | `/:id/profile` | `{school, stats, recent_visits, recent_students}` |
| PATCH | `/:id` | Updates; a rename cascades to students/visits copies |
| POST | `/:id/archive` | `{school}` |

## Field visits — `/api/field-visits`

| Method | Path | Notes |
|---|---|---|
| GET | `/?status=&school_id=&employee_id=` | `{visits, total}` — employees default to their own |
| POST | `/start` | `{school_id, purpose?, latitude?, longitude?}` → `201 {visit}`; **409 ACTIVE_VISIT_EXISTS** if one is running |
| GET | `/:id` | `{visit, media, students, tasks}` |
| PATCH | `/:id` | Owner/admin editable fields → `{visit}` |
| POST | `/:id/end` | `{report?, students_contacted?, documents_collected?, latitude?, longitude?}` → `{visit}` |

## Tasks — `/api/tasks`

| Method | Path | Notes |
|---|---|---|
| GET | `/?status=&assigned_to_user_id=` | `{tasks, total}` — admin sees all, employee sees assigned+created; default = open only |
| POST | `/` | `{title, assigned_to_user_id, priority?, due_date?, description?, school_id?, student_id?, visit_id?}` → `201 {task}` + notification |
| GET | `/:id` | `{task, events}` (assignee/creator/admin) |
| POST | `/:id/status` | `{status, note?}` → `{task}` — flow `pending→accepted→in_progress→submitted→completed` (+`cancelled`) |
| POST | `/:id/reassign` | `{assigned_to_user_id, note?}` → `{task}` — creator/admin only, not when finished |

## Chat — `/api/conversations`

| Method | Path | Notes |
|---|---|---|
| GET | `/` | `{conversations}` each with `members`, `unread_count`, `last_message` |
| GET | `/unread-count` | `{unread}` |
| POST | `/direct` | `{user_id}` → `201 {conversation}` (idempotent — reopens the same thread) |
| POST | `/group` | `{title, member_ids[]}` → `201 {conversation}` |
| GET | `/:id/messages?limit=&before=` | `{messages}` oldest→newest; opening marks read |
| POST | `/:id/messages` | `{text, attachment_paths?, linked_*?}` → `201 {message}` + notifications |

## Attendance — `/api/attendance`

| Method | Path | Notes |
|---|---|---|
| GET | `/?employee_id=&from=&to=&month=` | `{attendance, total}` — employees locked to their own rows |
| POST | `/check-in` | `{latitude?, longitude?}` → `{record, alreadyCheckedIn}` (idempotent) |
| POST | `/check-out` | `{latitude?, longitude?}` → `{record, alreadyCheckedOut}` (400 if never checked in) |
| POST | `/mark` | *admin* `{employee_id, date, status, remarks?}` → `{record}` |
| GET | `/summary?month=YYYY-MM` | *admin* `{month, summary:[{employee_id, present, absent, leave, half_day, late, days}]}` |

## Tests — `/api/tests`

| Method | Path | Notes |
|---|---|---|
| GET | `/?status=` | `{tests, total}` (subjects included) |
| POST | `/` | *admin* `{name, passing_percentage?, scheduled_date?, subjects:[{name,max_marks,passing_marks?}]}` → `201 {test}` |
| GET | `/:id` | `{test, assignments:[{…, score}]}` |
| PATCH | `/:id` | *admin* updates / subject replacement → `{test}` |
| POST | `/:id/assign` | *admin* `{student_ids[]}` → `{assigned, skipped, errors}` |
| POST | `/:id/marks/:studentId` | `{marks:[{subject_id, obtained_marks}]}` → `{score}` (upsert; ≤ max_marks enforced) |
| GET | `/:id/scores/:studentId` | `{score}` — totals, percentage, `complete`, `suggested_result` |
| POST | `/:id/finalize/:studentId` | Requires every subject marked; bumps `test_scheduled → test_completed` |
| POST | `/:id/absent/:studentId` | Clears marks, flags absent |
| POST | `/:id/decision/:studentId` | *admin* `{decision:"selected"\|"waitlisted"\|"not_selected", remarks?}` → `{student}` |

## Enrollment — `/api/enrollments`

| Method | Path | Notes |
|---|---|---|
| GET | `/?status=` | `{enrollments, total}` |
| GET | `/:studentId` | `{enrollment}` |
| POST | `/:studentId/start` | *admin* `{notes?}` → `{enrollment}` (stage `follow_up`) |
| POST | `/:studentId/stage` | *admin* `{stage:"documents"\|"verification"\|"enrolled"\|"follow_up", notes?}` — `enrolled` completes the record **and** sets student status `enrolled` |
| POST | `/:studentId/withdraw` | *admin* `{reason?}` → `{enrollment}` (student → `inactive`) |

## Website forms — `/api/website-forms` *(main_admin only)*

| Method | Path | Notes |
|---|---|---|
| GET | `/?status=` | `{submissions, total}` |
| POST | `/:id/assign` | `{assigned_to_user_id}` → `{submission}` (status `new→assigned`) |
| POST | `/:id/status` | `{status:"assigned"\|"in_progress"\|"closed"\|"new"}` → `{submission}` |
| POST | `/:id/convert` | `{overrides?, acknowledge_duplicates?}` → `{form, student, duplicates}` — same duplicate guard as registration; source recorded as `website` |

## Uploads & files

| Method | Path | Notes |
|---|---|---|
| POST | `/uploads` | `{category:"students"\|"schools"\|"field-visits"\|"documents", fileName, mimeType, dataBase64}` → `201 {relative_path, size}` — image/pdf/video/text only, ≤ `PET_MAX_UPLOAD_BYTES` |
| POST | `/media/field` | `{visit_id?, school_id?, type?, relative_path, original_name?, caption?}` → `201 {media}` |
| POST | `/media/student` | `{student_id, type?, relative_path, …}` → `201 {document}` |
| GET | `/files/<relative_path>` | Authenticated bytes; traversal (`../`) rejected |

## Offline sync — `POST /api/sync`

```jsonc
{ "operations": [ { "idempotency_key": "q-…", "type": "student.register", "payload": { … } } ] }
→ { "results": [ { "idempotency_key", "status": "ok"|"error", "deduplicated"?, "code"?, "message"?, "result"? } ], "processed_at" }
```

Types: `student.register`, `attendance.check_in`, `attendance.check_out`, `visit.start`, `visit.end`, `task.create`, `task.status`, `media.register`.

Guarantees: per `(user, idempotency_key)` exactly-once — the first outcome (success **or** rejection) is stored and replayed with `deduplicated:true`. Unknown types come back as per-entry errors without blocking the rest of the batch; a batch missing an `idempotency_key` is a `400`.

## Reports, search, settings

| Method | Path | Auth | Returns |
|---|---|---|---|
| GET | `/reports/dashboard` | admin | `AdminDashboard` — `kpis`, `pipeline`, `live_visits`, `task_queue`, `overdue_tasks`, `attendance_today`, `recent_registrations`, `website_forms`, `recent_activity` |
| GET | `/search?q=` | any | `{query, students, schools, employees, tasks}` (partial fields, ≤ 8 each) |
| GET | `/activity?limit=&offset=` | admin | `{activity, total}` audit entries (actions named `PET_*`) |
| GET | `/settings/organization` | any | `{organization: object \| null}` |
| PATCH | `/settings/organization` | admin | Merges fields → `{organization}` |
