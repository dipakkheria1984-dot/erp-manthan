import { PERMISSIONS, type Permission } from "@/lib/permissions";

export type NavItem = {
  label: string;
  href: string;
  /** Item is shown when the user holds at least one of these. */
  anyOf: Permission[];
};

export type NavSection = {
  label: string;
  items: NavItem[];
  /**
   * Starts shut, for areas that are set up once and rarely revisited, so they
   * do not push the daily sections down the sidebar. Every section can be
   * collapsed by hand — this only decides where it starts.
   */
  defaultCollapsed?: boolean;
};

export const NAV_SECTIONS: NavSection[] = [
  {
    label: "Overview",
    items: [{ label: "Dashboard", href: "/dashboard", anyOf: [] }],
  },
  {
    label: "Admissions",
    items: [
      { label: "Applications", href: "/enrollment", anyOf: [PERMISSIONS.ENROLLMENT_VIEW] },
      { label: "New application", href: "/enrollment/new", anyOf: [PERMISSIONS.ENROLLMENT_CREATE] },
      { label: "Students", href: "/students", anyOf: [PERMISSIONS.STUDENT_VIEW] },
      { label: "Bulk import", href: "/students/import", anyOf: [PERMISSIONS.STUDENT_IMPORT] },
    ],
  },
  {
    label: "Fees",
    items: [
      { label: "Collect fees", href: "/fees/collect", anyOf: [PERMISSIONS.FEE_COLLECT] },
      { label: "Receipts", href: "/fees/receipts", anyOf: [PERMISSIONS.FEE_COLLECT, PERMISSIONS.FEE_CANCEL_RECEIPT] },
      { label: "Import receipts", href: "/fees/import", anyOf: [PERMISSIONS.FEE_COLLECT] },
      { label: "Reminders", href: "/fees/reminders", anyOf: [PERMISSIONS.INSTITUTE_MANAGE] },
    ],
  },
  // Above Academics deliberately: reports are opened many times a day, the
  // academic structure is set up once a year and then left alone.
  {
    label: "Reports",
    items: [
      {
        label: "Reporting suite",
        href: "/reports",
        anyOf: [
          PERMISSIONS.REPORT_STUDENT_RECORDS,
          PERMISSIONS.REPORT_DEPARTMENT_WISE,
          PERMISSIONS.REPORT_COURSE_WISE,
          PERMISSIONS.REPORT_LEDGER,
          PERMISSIONS.REPORT_FEE_COLLECTION,
          PERMISSIONS.REPORT_FEE_DUE,
        ],
      },
    ],
  },
  {
    label: "Academics",
    defaultCollapsed: true,
    items: [
      { label: "Departments", href: "/academic/departments", anyOf: [PERMISSIONS.ACADEMIC_VIEW] },
      { label: "Courses", href: "/academic/courses", anyOf: [PERMISSIONS.ACADEMIC_VIEW] },
      { label: "Batches", href: "/academic/batches", anyOf: [PERMISSIONS.ACADEMIC_VIEW] },
      { label: "Bulk import", href: "/academic/import", anyOf: [PERMISSIONS.ACADEMIC_MANAGE] },
      { label: "Promotion", href: "/promotion", anyOf: [PERMISSIONS.PROMOTION_RUN] },
    ],
  },
  {
    label: "Administration",
    items: [
      { label: "Institute setup", href: "/setup", anyOf: [PERMISSIONS.INSTITUTE_MANAGE] },
      { label: "Terms & conditions", href: "/setup/terms", anyOf: [PERMISSIONS.TERMS_MANAGE] },
      { label: "Staff accounts", href: "/users", anyOf: [PERMISSIONS.USERS_VIEW, PERMISSIONS.USERS_MANAGE] },
      { label: "Roles", href: "/users/roles", anyOf: [PERMISSIONS.ROLES_MANAGE] },
      { label: "Audit trail", href: "/users/audit", anyOf: [PERMISSIONS.AUDIT_VIEW] },
    ],
  },
];

/** True when `pathname` is inside one of the section's items. */
export function sectionContains(section: NavSection, pathname: string): boolean {
  return section.items.some((item) => pathname === item.href || pathname.startsWith(`${item.href}/`));
}

export function visibleSections(permissions: readonly string[]): NavSection[] {
  return NAV_SECTIONS.map((section) => ({
    ...section,
    items: section.items.filter((item) => item.anyOf.length === 0 || item.anyOf.some((p) => permissions.includes(p))),
  })).filter((section) => section.items.length > 0);
}
