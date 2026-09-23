/**
 * Row → API shape mappers. One place keeps every endpoint's JSON identical
 * to the TypeScript contracts in the frontend `types/pet.ts`.
 */
'use strict';

const { parseJson } = require('../lib/http');

const bool = v => (v ? 1 : 0);

function toUser(r) {
  if (!r) return null;
  return {
    id: r.id,
    name: r.name,
    email: r.email,
    phone: r.phone ?? null,
    role: r.role,
    employee_code: r.employee_code ?? null,
    status: r.status,
    department: r.department ?? null,
    team_id: r.team_id ?? null,
    photo_path: r.photo_path ?? null,
    joining_date: r.joining_date ?? null,
    must_change_password: !!r.must_change_password,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

function toStudent(r) {
  if (!r) return null;
  return {
    id: r.id,
    pet_student_id: r.pet_student_id,
    name: r.name,
    photo_path: r.photo_path ?? null,
    dob: r.dob ?? null,
    age: r.age ?? null,
    gender: r.gender ?? null,
    student_phone: r.student_phone ?? null,
    parent_name: r.parent_name ?? null,
    parent_phone: r.parent_phone ?? null,
    parent_relation: r.parent_relation ?? null,
    school_id: r.school_id ?? null,
    school_name: r.school_name ?? null,
    school_address: r.school_address ?? null,
    locality: r.locality ?? null,
    city: r.city ?? null,
    district: r.district ?? null,
    state: r.state ?? null,
    current_class: r.current_class ?? null,
    previous_school: r.previous_school ?? null,
    address: r.address ?? null,
    status: r.status,
    registration_source: r.registration_source,
    registered_by_user_id: r.registered_by_user_id,
    registered_by_user_name: r.registered_by_user_name ?? '',
    registration_date: r.registration_date,
    intake_id: r.intake_id ?? null,
    registered_visit_id: r.registered_visit_id ?? null,
    notes: r.notes ?? null,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

function toSchool(r) {
  if (!r) return null;
  return {
    id: r.id,
    school_code: r.school_code,
    name: r.name,
    address: r.address ?? null,
    locality: r.locality ?? null,
    city: r.city ?? null,
    district: r.district ?? null,
    state: r.state ?? null,
    phone: r.phone ?? null,
    contact_person_name: r.contact_person_name ?? null,
    contact_person_phone: r.contact_person_phone ?? null,
    latitude: r.latitude ?? null,
    longitude: r.longitude ?? null,
    status: r.status,
    notes: r.notes ?? null,
    created_by_user_id: r.created_by_user_id ?? null,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

function toVisit(r) {
  if (!r) return null;
  return {
    id: r.id,
    school_id: r.school_id,
    school_name: r.school_name ?? '',
    employee_id: r.employee_id,
    employee_name: r.employee_name ?? '',
    purpose: r.purpose ?? null,
    status: r.status,
    started_at: r.started_at,
    ended_at: r.ended_at ?? null,
    start_latitude: r.start_latitude ?? null,
    start_longitude: r.start_longitude ?? null,
    end_latitude: r.end_latitude ?? null,
    end_longitude: r.end_longitude ?? null,
    students_contacted: Number(r.students_contacted || 0),
    students_registered: Number(r.students_registered || 0),
    documents_collected: Number(r.documents_collected || 0),
    notes: r.notes ?? null,
    report: r.report ?? null,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

function toMedia(r) {
  if (!r) return null;
  return {
    id: r.id,
    visit_id: r.visit_id ?? null,
    school_id: r.school_id ?? null,
    uploaded_by_user_id: r.uploaded_by_user_id,
    uploaded_by_user_name: r.uploaded_by_user_name ?? '',
    type: r.type,
    relative_path: r.relative_path ?? null,
    original_name: r.original_name ?? null,
    caption: r.caption ?? null,
    status: r.status,
    created_at: r.created_at,
  };
}

function toDocument(r) {
  if (!r) return null;
  return {
    id: r.id,
    student_id: r.student_id,
    uploaded_by_user_id: r.uploaded_by_user_id,
    uploaded_by_user_name: r.uploaded_by_user_name ?? '',
    type: r.type,
    relative_path: r.relative_path ?? null,
    original_name: r.original_name ?? null,
    caption: r.caption ?? null,
    status: r.status,
    created_at: r.created_at,
  };
}

function toTask(r) {
  if (!r) return null;
  return {
    id: r.id,
    title: r.title,
    description: r.description ?? null,
    created_by_user_id: r.created_by_user_id,
    created_by_user_name: r.created_by_user_name ?? '',
    assigned_to_user_id: r.assigned_to_user_id,
    assigned_to_user_name: r.assigned_to_user_name ?? '',
    priority: r.priority,
    status: r.status,
    due_date: r.due_date ?? null,
    school_id: r.school_id ?? null,
    student_id: r.student_id ?? null,
    visit_id: r.visit_id ?? null,
    created_at: r.created_at,
    updated_at: r.updated_at,
    completed_at: r.completed_at ?? null,
  };
}

function toTaskEvent(r) {
  if (!r) return null;
  return {
    id: r.id,
    task_id: r.task_id,
    actor_user_id: r.actor_user_id,
    actor_user_name: r.actor_user_name ?? '',
    event_type: r.event_type,
    from_status: r.from_status ?? null,
    to_status: r.to_status ?? null,
    note: r.note ?? null,
    created_at: r.created_at,
  };
}

function toMessage(r) {
  if (!r) return null;
  return {
    id: r.id,
    conversation_id: r.conversation_id,
    sender_id: r.sender_id,
    sender_name: r.sender_name ?? '',
    text: r.text,
    attachment_paths: r.attachment_paths ?? null,
    linked_task_id: r.linked_task_id ?? null,
    linked_student_id: r.linked_student_id ?? null,
    linked_school_id: r.linked_school_id ?? null,
    linked_visit_id: r.linked_visit_id ?? null,
    created_at: r.created_at,
  };
}

function toAttendance(r) {
  if (!r) return null;
  return {
    id: r.id,
    employee_id: r.employee_id,
    employee_name: r.employee_name ?? '',
    date: r.date,
    check_in_at: r.check_in_at ?? null,
    check_out_at: r.check_out_at ?? null,
    status: r.status,
    latitude: r.latitude ?? null,
    longitude: r.longitude ?? null,
    remarks: r.remarks ?? null,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

function toTest(r) {
  if (!r) return null;
  return {
    id: r.id,
    name: r.name,
    description: r.description ?? null,
    passing_percentage: Number(r.passing_percentage ?? 0),
    scheduled_date: r.scheduled_date ?? null,
    status: r.status,
    created_by_user_id: r.created_by_user_id,
    created_by_user_name: r.created_by_user_name ?? '',
    created_at: r.created_at,
    updated_at: r.updated_at,
    subjects: r.subjects || [],
  };
}

function toSubject(r) {
  return {
    id: r.id,
    test_id: r.test_id,
    name: r.name,
    max_marks: Number(r.max_marks),
    passing_marks: r.passing_marks === null || r.passing_marks === undefined ? null : Number(r.passing_marks),
    sort_order: Number(r.sort_order || 0),
  };
}

function toEnrollment(r) {
  if (!r) return null;
  return {
    id: r.id,
    student_id: r.student_id,
    stage: r.stage,
    status: r.status,
    notes: r.notes ?? null,
    started_by_user_id: r.started_by_user_id,
    started_by_user_name: r.started_by_user_name ?? '',
    verified_by_user_id: r.verified_by_user_id ?? null,
    enrolled_at: r.enrolled_at ?? null,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

function toSubmission(r) {
  if (!r) return null;
  return {
    id: r.id,
    form_type: r.form_type,
    name: r.name,
    phone: r.phone ?? '',
    email: r.email ?? null,
    payload: parseJson(r.payload),
    status: r.status,
    assigned_to_user_id: r.assigned_to_user_id ?? null,
    assigned_to_user_name: r.assigned_to_user_name ?? null,
    converted_student_id: r.converted_student_id ?? null,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

module.exports = {
  bool,
  toUser,
  toStudent,
  toSchool,
  toVisit,
  toMedia,
  toDocument,
  toTask,
  toTaskEvent,
  toMessage,
  toAttendance,
  toTest,
  toSubject,
  toEnrollment,
  toSubmission,
};
