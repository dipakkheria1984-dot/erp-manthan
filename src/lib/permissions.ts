/**
 * Permission catalogue and the three predefined roles (spec 8.1 / 8.3).
 *
 * Admin can create custom roles with any subset of these permissions, so the
 * catalogue — not the role name — is what the rest of the app checks against.
 * This file is safe to import from client components.
 */

export const PERMISSIONS = {
  // Module 9 — Institute Setup
  INSTITUTE_MANAGE: "institute.manage",
  // Module 8 — User Management
  USERS_VIEW: "users.view",
  USERS_MANAGE: "users.manage",
  ROLES_MANAGE: "roles.manage",
  AUDIT_VIEW: "audit.view",
  // Module 5 — Academic Structure
  ACADEMIC_VIEW: "academic.view",
  ACADEMIC_MANAGE: "academic.manage",
  // Module 1 — Enrollment
  ENROLLMENT_VIEW: "enrollment.view",
  ENROLLMENT_CREATE: "enrollment.create",
  ENROLLMENT_VERIFY_DOCUMENTS: "enrollment.verify_documents",
  /// Approve/reject an application — Admin only per spec 1.4.
  ENROLLMENT_APPROVE: "enrollment.approve",
  /// Move an enrolled student to a different course, scrapping the fee
  /// structure that came with the old one — Admin only.
  ENROLLMENT_CHANGE_COURSE: "enrollment.change_course",
  // Module 2 — Fee assignment
  FEE_ASSIGN: "fee.assign",
  /// Approve a scholarship above the hidden threshold — Admin only (spec 2.2).
  FEE_APPROVE_SCHOLARSHIP: "fee.approve_scholarship",
  // Module 3 — Fee collection
  FEE_COLLECT: "fee.collect",
  /// Cancel/void a receipt — Admin only per spec 3.4.
  FEE_CANCEL_RECEIPT: "fee.cancel_receipt",
  FEE_WAIVE: "fee.waive",
  /// Grant or cancel a concession on an installment — Admin only (spec 2.2).
  FEE_DISCOUNT: "fee.discount",
  /// Write off an accrued late fee. Available to Accountant as well as Admin —
  /// it is a counter decision, taken while the family is paying (spec 3.2).
  FEE_WAIVE_LATE_FEE: "fee.waive_late_fee",
  // Module 4 — Students
  STUDENT_VIEW: "student.view",
  /// Bulk-import existing student data (spec 1.8).
  STUDENT_IMPORT: "student.import",
  /// Change student status — Admin only per spec 4.
  STUDENT_STATUS_CHANGE: "student.status_change",
  // Module 6 — Promotion
  PROMOTION_RUN: "promotion.run",
  // Module 7 — Reports
  REPORT_STUDENT_RECORDS: "report.student_records",
  REPORT_DEPARTMENT_WISE: "report.department_wise",
  REPORT_COURSE_WISE: "report.course_wise",
  REPORT_LEDGER: "report.ledger",
  REPORT_FEE_COLLECTION: "report.fee_collection",
  REPORT_FEE_DUE: "report.fee_due",
  // Module 10 — Terms & Conditions
  TERMS_MANAGE: "terms.manage",
} as const;

export type Permission = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

export const ALL_PERMISSIONS: Permission[] = Object.values(PERMISSIONS);

/** Human-readable grouping used by the role editor UI. */
export const PERMISSION_GROUPS: { label: string; permissions: { key: Permission; label: string }[] }[] = [
  {
    label: "Institute Setup",
    permissions: [{ key: PERMISSIONS.INSTITUTE_MANAGE, label: "Manage institute profile & global configuration" }],
  },
  {
    label: "User Management",
    permissions: [
      { key: PERMISSIONS.USERS_VIEW, label: "View staff accounts" },
      { key: PERMISSIONS.USERS_MANAGE, label: "Create / edit / deactivate staff accounts" },
      { key: PERMISSIONS.ROLES_MANAGE, label: "Manage roles & permissions" },
      { key: PERMISSIONS.AUDIT_VIEW, label: "View audit trail" },
    ],
  },
  {
    label: "Academic Structure",
    permissions: [
      { key: PERMISSIONS.ACADEMIC_VIEW, label: "View departments, courses, batches, semesters" },
      { key: PERMISSIONS.ACADEMIC_MANAGE, label: "Manage academic structure & batch fees" },
    ],
  },
  {
    label: "Enrollment",
    permissions: [
      { key: PERMISSIONS.ENROLLMENT_VIEW, label: "View applications" },
      { key: PERMISSIONS.ENROLLMENT_CREATE, label: "Create & edit applications" },
      { key: PERMISSIONS.ENROLLMENT_VERIFY_DOCUMENTS, label: "Verify uploaded documents" },
      { key: PERMISSIONS.ENROLLMENT_APPROVE, label: "Approve / reject applications" },
      { key: PERMISSIONS.ENROLLMENT_CHANGE_COURSE, label: "Change an enrolled student's course" },
    ],
  },
  {
    label: "Fees",
    permissions: [
      { key: PERMISSIONS.FEE_ASSIGN, label: "Assign fees & build installment plans" },
      { key: PERMISSIONS.FEE_APPROVE_SCHOLARSHIP, label: "Approve scholarships above threshold" },
      { key: PERMISSIONS.FEE_COLLECT, label: "Record fee payments" },
      { key: PERMISSIONS.FEE_CANCEL_RECEIPT, label: "Cancel / void receipts" },
      { key: PERMISSIONS.FEE_WAIVE, label: "Waive & un-waive installments" },
      { key: PERMISSIONS.FEE_DISCOUNT, label: "Grant & cancel discounts on installments" },
      { key: PERMISSIONS.FEE_WAIVE_LATE_FEE, label: "Waive & restore late fees" },
    ],
  },
  {
    label: "Students",
    permissions: [
      { key: PERMISSIONS.STUDENT_VIEW, label: "View student records" },
      { key: PERMISSIONS.STUDENT_IMPORT, label: "Bulk-import existing student data" },
      { key: PERMISSIONS.STUDENT_STATUS_CHANGE, label: "Change student status" },
    ],
  },
  {
    label: "Promotion",
    permissions: [{ key: PERMISSIONS.PROMOTION_RUN, label: "Run semester promotions" }],
  },
  {
    label: "Reports",
    permissions: [
      { key: PERMISSIONS.REPORT_STUDENT_RECORDS, label: "Student Records report" },
      { key: PERMISSIONS.REPORT_DEPARTMENT_WISE, label: "Department-wise report" },
      { key: PERMISSIONS.REPORT_COURSE_WISE, label: "Course-wise report" },
      { key: PERMISSIONS.REPORT_LEDGER, label: "Student Ledger" },
      { key: PERMISSIONS.REPORT_FEE_COLLECTION, label: "Fee Collection report" },
      { key: PERMISSIONS.REPORT_FEE_DUE, label: "Fee Due report" },
    ],
  },
  {
    label: "Terms & Conditions",
    permissions: [{ key: PERMISSIONS.TERMS_MANAGE, label: "Manage T&C versions" }],
  },
];

export const SYSTEM_ROLES = {
  ADMIN: "Admin",
  REGISTRAR: "Registrar",
  ACCOUNTANT: "Accountant",
} as const;

/** Seed definitions for the three predefined roles. */
export const SYSTEM_ROLE_DEFINITIONS: {
  name: string;
  description: string;
  permissions: Permission[];
}[] = [
  {
    name: SYSTEM_ROLES.ADMIN,
    description: "Full access: approvals, status changes, promotion, financial reports, configuration.",
    permissions: ALL_PERMISSIONS,
  },
  {
    name: SYSTEM_ROLES.REGISTRAR,
    description:
      "Enrollment, document verification, fee collection entry, non-financial reports.",
    permissions: [
      PERMISSIONS.ACADEMIC_VIEW,
      PERMISSIONS.ENROLLMENT_VIEW,
      PERMISSIONS.ENROLLMENT_CREATE,
      PERMISSIONS.ENROLLMENT_VERIFY_DOCUMENTS,
      PERMISSIONS.FEE_ASSIGN,
      PERMISSIONS.FEE_COLLECT,
      PERMISSIONS.STUDENT_VIEW,
      PERMISSIONS.STUDENT_IMPORT,
      PERMISSIONS.REPORT_STUDENT_RECORDS,
      PERMISSIONS.REPORT_DEPARTMENT_WISE,
      PERMISSIONS.REPORT_COURSE_WISE,
    ],
  },
  {
    name: SYSTEM_ROLES.ACCOUNTANT,
    description:
      "Fee-only access: collection entry, Fee Collection / Fee Due reports and Student Ledger.",
    permissions: [
      PERMISSIONS.ACADEMIC_VIEW,
      PERMISSIONS.STUDENT_VIEW,
      PERMISSIONS.FEE_COLLECT,
      PERMISSIONS.FEE_WAIVE_LATE_FEE,
      PERMISSIONS.REPORT_LEDGER,
      PERMISSIONS.REPORT_FEE_COLLECTION,
      PERMISSIONS.REPORT_FEE_DUE,
    ],
  },
];

export function hasPermission(granted: readonly string[], required: Permission): boolean {
  return granted.includes(required);
}

export function hasAnyPermission(granted: readonly string[], required: readonly Permission[]): boolean {
  return required.some((p) => granted.includes(p));
}
