import "server-only";
import { prisma } from "@/lib/db";
import { getInstitute, getInstituteLogo } from "@/lib/config";
import { termsInForce } from "@/lib/terms";
import { tuitionRateAt } from "@/lib/fees";
import { formatDate, formatDateTime } from "@/lib/dates";
import { formatPaisePdf, percentOf } from "@/lib/money";
import { installmentStatusLabel } from "@/lib/students";
import {
  createDocument,
  drawFieldRows,
  drawHeader,
  drawPageNumbers,
  drawParagraph,
  drawSignatureRow,
  drawTable,
  ensureSpace,
  htmlToPlainText,
  sectionHeading,
  toBuffer,
  applyFontFor,
  paletteOf,
  type PdfDoc,
} from "@/lib/pdf";
import { resolvePrintStyle } from "@/lib/print-theme";
import {
  ADMISSION_FORM_INCLUDE,
  RECEIPT_COPIES,
  drawAdmissionFormBody,
  drawReceiptCopy,
  fullAddress,
  loadReceiptLines,
} from "@/lib/pdf-sections";
import type { Prisma } from "@/generated/prisma/client";

/**
 * The welcome kit issued once an admission is approved (spec 1.4 step 9).
 *
 * A single multi-page PDF the office can hand over, email or print, holding the
 * five documents a newly admitted family needs:
 *
 *   1. Welcome & admission confirmation letter
 *   2. Admission form
 *   3. Year-wise fee payment plan
 *   4. Terms & conditions
 *   5. Registration fee receipt(s)
 *
 * The admission form and the receipts are drawn by the same code that serves
 * them on their own routes (src/lib/pdf-sections.ts), so the bound copy and the
 * office printout can never disagree.
 */

/* -------------------------------------------------------------------------- */
/* Data                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * One year of the course. Year 1 is always real — approval creates it. Later
 * years are projected from the same rules the promotion run applies, and are
 * marked indicative because exam and activity fees are never rate-locked.
 */
export type YearPlan = {
  yearNumber: number;
  academicYearName: string | null;
  semesterNumbers: number[];
  /** Gross tuition charged in the year, before any scholarship. */
  tuitionPaise: number;
  scholarshipPaise: number;
  examFeePaise: number;
  activityFeePaise: number;
  /** The fee heads added up: tuition − scholarship + exam + activity. */
  totalPaise: number;
  /**
   * What the year's fee assignments actually bill, which is what the installment
   * schedule is built from. Equal to `totalPaise` for anything this application
   * created; legacy rows that netted the registration fee off the assigned total
   * differ, and the plan says so rather than printing a row that does not add up.
   */
  assignedPaise: number;
  /** True when every semester of the year already has a real fee assignment. */
  confirmed: boolean;
  installments: {
    seqNo: number;
    semesterNumber: number;
    dueDate: Date;
    amountPaise: number;
    status: string;
  }[];
};

type KitSemester = Prisma.SemesterGetPayload<{ include: { academicYear: true } }>;
type KitFeeAssignment = Prisma.FeeAssignmentGetPayload<{
  include: { semester: true; academicYear: true; installments: true };
}>;

/** Everything the kit needs, or why it cannot be issued. */
export type WelcomeKitResult = Awaited<ReturnType<typeof loadWelcomeKit>>;
export type WelcomeKit = Extract<WelcomeKitResult, { ok: true }>;

export async function loadWelcomeKit(applicationId: string) {
  const application = await prisma.application.findUnique({
    where: { id: applicationId },
    include: { ...ADMISSION_FORM_INCLUDE, reviewedBy: { select: { name: true } } },
  });
  if (!application) return { ok: false, reason: "not-found" } as const;

  const student = await prisma.student.findUnique({
    where: { applicationId },
    include: {
      department: true,
      course: true,
      batch: true,
      feeAssignments: {
        include: { semester: true, academicYear: true, installments: { orderBy: { seqNo: "asc" } } },
        orderBy: [{ yearNumber: "asc" }, { createdAt: "asc" }],
      },
    },
  });
  // The kit confirms an admission, so it only exists once approval has created
  // the student record.
  if (!student) return { ok: false, reason: "not-enrolled" } as const;

  const [institute, terms, receiptTerms, semesters, registrationPayments] = await Promise.all([
    getInstitute(),
    // The kit's terms page is part of the admission; each enclosed receipt
    // carries the receipt terms at its own foot, exactly as the office prints it.
    termsInForce("ADMISSION"),
    termsInForce("RECEIPT"),
    prisma.semester.findMany({
      where: { batchId: student.batchId },
      include: { academicYear: true },
      orderBy: { semesterNumber: "asc" },
    }),
    prisma.payment.findMany({
      where: { applicationId, kind: "REGISTRATION" },
      select: { receiptNo: true, paymentDate: true },
      orderBy: [{ paymentDate: "asc" }, { receiptSeq: "asc" }],
    }),
  ]);

  const yearOne = student.feeAssignments.find((assignment) => assignment.yearNumber === 1);
  const lockedRatePaise =
    yearOne?.lockedTuitionRatePaise || (await tuitionRateAt(student.batchId, student.enrollmentDate));
  const scholarshipPercent = yearOne?.scholarshipPercent ?? application.approvedScholarshipPercent ?? 0;

  const receiptNos = [...new Set(registrationPayments.map((payment) => payment.receiptNo))];
  const receipts = await Promise.all(receiptNos.map((receiptNo) => loadReceiptLines(receiptNo)));

  return {
    ok: true as const,
    application,
    student,
    institute,
    terms,
    receiptTerms,
    lockedRatePaise,
    scholarshipPercent,
    years: buildYearPlans({ semesters, feeAssignments: student.feeAssignments, lockedRatePaise, scholarshipPercent }),
    receipts: receipts.filter((lines) => lines.length > 0),
  };
}

/**
 * Year-wise fee, mirroring what the system will actually charge:
 *
 *   - Tuition re-applies once per year, on that year's first semester, always at
 *     the rate locked on the enrollment date (spec 2.4).
 *   - The scholarship is Year 1 only (spec 2.2).
 *   - Exam and activity fees apply per semester at their current value and are
 *     never locked, which is why later years are labelled indicative.
 *
 * Where a real fee assignment already exists it is used verbatim in place of the
 * projection.
 */
function buildYearPlans({
  semesters,
  feeAssignments,
  lockedRatePaise,
  scholarshipPercent,
}: {
  semesters: KitSemester[];
  feeAssignments: KitFeeAssignment[];
  lockedRatePaise: number;
  scholarshipPercent: number;
}): YearPlan[] {
  const assignmentBySemester = new Map(feeAssignments.map((assignment) => [assignment.semesterId, assignment]));

  const byYear = new Map<number, typeof semesters>();
  for (const semester of semesters) {
    const list = byYear.get(semester.yearNumber) ?? [];
    list.push(semester);
    byYear.set(semester.yearNumber, list);
  }

  return [...byYear.entries()]
    .sort(([a], [b]) => a - b)
    .map(([yearNumber, list]) => {
      const plan: YearPlan = {
        yearNumber,
        academicYearName: list.find((semester) => semester.academicYear)?.academicYear?.name ?? null,
        semesterNumbers: list.map((semester) => semester.semesterNumber),
        tuitionPaise: 0,
        scholarshipPaise: 0,
        examFeePaise: 0,
        activityFeePaise: 0,
        totalPaise: 0,
        assignedPaise: 0,
        confirmed: true,
        installments: [],
      };

      list.forEach((semester, index) => {
        const assignment = assignmentBySemester.get(semester.id);
        if (assignment) {
          plan.tuitionPaise += assignment.lockedTuitionRatePaise;
          plan.scholarshipPaise += assignment.scholarshipAmountPaise;
          plan.examFeePaise += assignment.examFeePaise;
          plan.activityFeePaise += assignment.activityFeePaise;
          plan.totalPaise +=
            assignment.lockedTuitionRatePaise -
            assignment.scholarshipAmountPaise +
            assignment.examFeePaise +
            assignment.activityFeePaise;
          plan.assignedPaise += assignment.totalPayablePaise;
          plan.installments.push(
            ...assignment.installments.map((installment) => ({
              seqNo: installment.seqNo,
              semesterNumber: semester.semesterNumber,
              dueDate: installment.dueDate,
              amountPaise: installment.amountPaise,
              status: installment.status,
            })),
          );
          return;
        }

        plan.confirmed = false;
        const tuition = index === 0 ? lockedRatePaise : 0;
        const scholarship = yearNumber === 1 ? percentOf(tuition, scholarshipPercent) : 0;
        const total = tuition - scholarship + semester.examFeePaise + semester.activityFeePaise;
        plan.tuitionPaise += tuition;
        plan.scholarshipPaise += scholarship;
        plan.examFeePaise += semester.examFeePaise;
        plan.activityFeePaise += semester.activityFeePaise;
        plan.totalPaise += total;
        plan.assignedPaise += total;
      });

      return plan;
    });
}

/* -------------------------------------------------------------------------- */
/* Document                                                                    */
/* -------------------------------------------------------------------------- */

export function welcomeKitFileName(studentCode: string): string {
  return `welcome-kit-${studentCode}.pdf`;
}

export async function buildWelcomeKitPdf(data: WelcomeKit): Promise<Buffer> {
  const { student, institute } = data;
  const doc = createDocument({
    title: `Welcome kit — ${student.fullName} (${student.studentCode})`,
    bufferPages: true,
    style: resolvePrintStyle(institute),
    logo: await getInstituteLogo(institute),
  });

  drawWelcomeLetter(doc, data);

  doc.addPage();
  drawHeader(doc, institute, "ADMISSION FORM", `Application ID: ${data.application.applicationNo ?? "—"}`);
  drawAdmissionFormBody(doc, data.application);

  doc.addPage();
  drawFeePlan(doc, data);

  doc.addPage();
  drawTermsPage(doc, data);

  drawRegistrationReceipts(doc, data);

  drawPageNumbers(doc, `Welcome kit  ·  ${student.studentCode}`);
  return toBuffer(doc);
}

/* 1 — Welcome & admission confirmation letter ------------------------------- */

function drawWelcomeLetter(doc: PdfDoc, data: WelcomeKit): void {
  const { application, student, institute } = data;

  drawHeader(doc, institute, "ADMISSION CONFIRMATION & WELCOME LETTER", `Student ID: ${student.studentCode}`);

  const issued = `Date: ${formatDate(new Date())}`;
  applyFontFor(doc, issued).fontSize(9).text(issued, { align: "right" });
  doc.moveDown(0.8);

  sectionHeading(doc, "To");
  drawParagraph(doc, `${student.fullName}\n${fullAddress(student)}`, { size: 9, gap: 1 });

  drawParagraph(doc, `Dear ${student.fullName},`, { bold: true, gap: 0.8 });

  drawParagraph(
    doc,
    `We are pleased to confirm your admission to ${student.course.name} at ${institute.name}. ` +
      `Your application ${application.applicationNo ?? ""} has been approved and your student record is now active. ` +
      `Your Student ID is ${student.studentCode} — please quote it on every fee payment and in all correspondence with the office.`,
  );

  if (application.isProvisional) {
    drawParagraph(
      doc,
      "Your admission is currently provisional: it becomes final automatically once the registration fee and the first " +
        "installment are settled in full. No further confirmation is needed from your side beyond the payment.",
    );
  }

  if (data.scholarshipPercent > 0) {
    drawParagraph(
      doc,
      `A scholarship of ${data.scholarshipPercent}% has been approved on your tuition fee for Year 1. It has already been ` +
        "applied to the fee plan enclosed with this letter. Scholarships apply to the first year only.",
    );
  }

  doc.moveDown(0.2);
  sectionHeading(doc, "Admission summary");
  doc.moveDown(0.3);
  drawFieldRows(doc, [
    ["Student name", student.fullName],
    ["Student ID", student.studentCode],
    ["LF No.", String(student.lfNo)],
    ["Application ID", application.applicationNo ?? "—"],
    ["Department", student.department.name],
    ["Course", `${student.course.name} (${student.course.durationYears} year${student.course.durationYears === 1 ? "" : "s"})`],
    ["Batch", `${student.batch.name} (${student.batch.code})`],
    ["Academic year", application.academicYear?.name ?? "—"],
    ["Enrollment date", formatDate(student.enrollmentDate)],
    ["Course completion", formatDate(student.batch.completionDate)],
    ["Admission status", application.isProvisional ? "Provisional — pending fee settlement" : "Confirmed"],
    ["Approved by", application.reviewedBy?.name ?? "—"],
  ]);

  sectionHeading(doc, "What this kit contains");
  doc.moveDown(0.3);
  const contents = [
    "1.  This welcome and admission confirmation letter",
    "2.  Your admission form as recorded by the institute",
    "3.  The year-wise fee payment plan and installment schedule",
    "4.  The terms & conditions that apply to your admission",
    data.receipts.length > 0
      ? "5.  Your registration fee receipt"
      : "5.  Registration fee receipt — none recorded on this admission",
  ];
  for (const line of contents) drawParagraph(doc, line, { size: 9, gap: 0.15 });
  doc.moveDown(0.6);

  drawParagraph(
    doc,
    "Please read the enclosed terms & conditions carefully and keep this kit for your records. " +
      "Fee due dates are listed in the payment plan; reminders are sent before each due date and a late fee applies " +
      "after it. For any correction to the details printed here, contact the admissions office.",
  );
  drawParagraph(doc, "We look forward to welcoming you.", { gap: 0.4 });

  drawSignatureRow(doc, "Student / guardian acknowledgement", `For ${institute.name}`);

  doc.moveDown(1);
  const note = `Issued ${formatDateTime(new Date())} · This is a computer-generated document.`;
  applyFontFor(doc, note).fontSize(7).fillColor(paletteOf(doc).muted).text(note, { align: "center" });
  doc.fillColor(paletteOf(doc).ink);
}

/* 3 — Year-wise fee payment plan ------------------------------------------- */

function drawFeePlan(doc: PdfDoc, data: WelcomeKit): void {
  const { student, institute, years } = data;

  drawHeader(doc, institute, "FEE PAYMENT PLAN — YEAR WISE", `${student.fullName} · ${student.studentCode}`);

  sectionHeading(doc, "How your fee is calculated");
  doc.moveDown(0.3);
  drawFieldRows(doc, [
    ["Tuition rate locked at enrollment", formatPaisePdf(data.lockedRatePaise)],
    ["Scholarship approved (Year 1 only)", `${data.scholarshipPercent}%`],
    ["Course duration", `${student.course.durationYears} year(s) · ${student.course.totalSemesters} semesters`],
    ["Registration fee received", formatPaisePdf(data.application.registrationFeePaidPaise)],
  ]);

  if (years.length === 0) {
    drawParagraph(
      doc,
      "The semester structure for this batch has not been set up yet, so a year-wise plan cannot be printed. " +
        "The admissions office will issue it separately.",
    );
    return;
  }

  sectionHeading(doc, "Year-wise fee");
  doc.moveDown(0.3);
  const totals = years.reduce(
    (sum, year) => ({
      tuition: sum.tuition + year.tuitionPaise,
      scholarship: sum.scholarship + year.scholarshipPaise,
      exam: sum.exam + year.examFeePaise,
      activity: sum.activity + year.activityFeePaise,
      total: sum.total + year.totalPaise,
    }),
    { tuition: 0, scholarship: 0, exam: 0, activity: 0, total: 0 },
  );

  drawTable(
    doc,
    [
      { header: "Year", width: 46 },
      { header: "Sem.", width: 58 },
      { header: "Tuition", width: 78, align: "right" },
      { header: "Scholarship", width: 85, align: "right" },
      { header: "Exam", width: 62, align: "right" },
      { header: "Activity", width: 62, align: "right" },
      { header: "Year total", width: 108, align: "right" },
    ],
    [
      ...years.map((year) => [
        `${year.yearNumber}${year.confirmed ? "" : " *"}`,
        year.semesterNumbers.join(", "),
        formatPaisePdf(year.tuitionPaise),
        year.scholarshipPaise > 0 ? `− ${formatPaisePdf(year.scholarshipPaise)}` : "—",
        formatPaisePdf(year.examFeePaise),
        formatPaisePdf(year.activityFeePaise),
        formatPaisePdf(year.totalPaise),
      ]),
      [
        "All",
        "",
        formatPaisePdf(totals.tuition),
        totals.scholarship > 0 ? `− ${formatPaisePdf(totals.scholarship)}` : "—",
        formatPaisePdf(totals.exam),
        formatPaisePdf(totals.activity),
        formatPaisePdf(totals.total),
      ],
    ],
  );
  doc.moveDown(0.5);

  if (years.some((year) => !year.confirmed)) {
    drawParagraph(
      doc,
      "* Indicative. Tuition for these years is already fixed at the rate locked on your enrollment date, but exam and " +
        "activity fees are not rate-locked — they apply at their value for the academic year in question. The binding " +
        "installment schedule for each year is issued when you are promoted into it.",
      { size: 8 },
    );
  }

  const restated = years.filter((year) => year.assignedPaise !== year.totalPaise);
  if (restated.length > 0) {
    drawParagraph(
      doc,
      `Please note that the fee assigned to your account differs from the heads above for ${restated
        .map((year) => `Year ${year.yearNumber} (${formatPaisePdf(year.assignedPaise)})`)
        .join(", ")}. The assigned amount is the binding figure and is what that year's installments add up to. ` +
        "Contact the admissions office if this needs explaining.",
      { size: 8 },
    );
  }

  ensureSpace(doc, 150);
  sectionHeading(doc, "Please note");
  doc.moveDown(0.3);
  const notes = [
    "The registration fee is part of the total fee, not an extra charge — it is credited against your first installment.",
    "Tuition is locked to the batch rate in force on your enrollment date and does not change if the batch fee is revised later.",
    "Exam and activity fees are charged per semester at their current value and are not rate-locked.",
    "A late fee applies to any installment paid after its due date, as per the institute's late fee slabs.",
    "Every payment is receipted. Keep your receipts — they are the only proof of payment the institute recognises.",
  ];
  for (const note of notes) drawParagraph(doc, `•  ${note}`, { size: 8.5, gap: 0.2 });

  // Enrollment schedules Year 1 only, so the kit prints Year 1 due dates and
  // nothing else. A student promoted since has later installments on file, but
  // those belong to the schedule issued at that promotion, not to this document.
  const issued = years.find((year) => year.yearNumber === 1)?.installments ?? [];
  if (issued.length > 0) {
    doc.moveDown(0.5);
    ensureSpace(doc, 120);
    sectionHeading(doc, "Year 1 installment schedule");
    doc.moveDown(0.3);
    drawTable(
      doc,
      [
        { header: "Sem.", width: 50 },
        { header: "Installment", width: 80 },
        { header: "Due date", width: 125 },
        { header: "Amount", width: 125, align: "right" },
        { header: "Status", width: 115 },
      ],
      issued.map((installment) => [
        String(installment.semesterNumber),
        `#${installment.seqNo}`,
        formatDate(installment.dueDate),
        formatPaisePdf(installment.amountPaise),
        installmentStatusLabel(installment.status),
      ]),
    );
    doc.moveDown(0.5);
    drawParagraph(
      doc,
      "These are the due dates fixed at your enrollment. The installment schedule for Year 2 onwards is issued " +
        "separately when you are promoted into each year.",
      { size: 8 },
    );
  }
}

/* 4 — Terms & conditions ---------------------------------------------------- */

function drawTermsPage(doc: PdfDoc, data: WelcomeKit): void {
  const { institute, terms } = data;

  drawHeader(
    doc,
    institute,
    "TERMS & CONDITIONS",
    terms ? `${terms.title} · version ${terms.version} · effective ${formatDate(terms.effectiveFrom)}` : undefined,
  );

  const text = terms ? htmlToPlainText(terms.content) : "";
  if (!terms || !text.trim()) {
    drawParagraph(
      doc,
      "No terms & conditions have been published by the institute yet. Any terms published later will be made " +
        "available through the admissions office.",
    );
    return;
  }

  applyFontFor(doc, text).fontSize(8.5).fillColor(paletteOf(doc).ink).text(text, { align: "left", lineGap: 2 });

  doc.moveDown(1);
  ensureSpace(doc, 90);
  drawParagraph(
    doc,
    `I have read, understood and accept the terms & conditions set out above (version ${terms.version}) ` +
      "as they apply to this admission.",
    { size: 8.5, gap: 0.2 },
  );
  drawSignatureRow(doc, "Student / guardian signature", `For ${institute.name}`);
}

/* 5 — Registration fee receipt(s) ------------------------------------------- */

function drawRegistrationReceipts(doc: PdfDoc, data: WelcomeKit): void {
  const { institute } = data;

  if (data.receipts.length === 0) {
    doc.addPage();
    drawHeader(doc, institute, "REGISTRATION FEE RECEIPT");
    drawParagraph(
      doc,
      "No registration fee has been recorded against this admission, so there is no receipt to enclose. " +
        "Any payment made later is receipted separately and can be reprinted from the fee receipts register.",
    );
    return;
  }

  // The family gets the student copy; the office copy stays in the office file,
  // so only one is bound in. It is drawn by the same code as the printed
  // receipt, terms and all.
  data.receipts.forEach((lines) => {
    doc.addPage();
    const top = doc.page.margins.top;
    // Roughly the same band the printed receipt gives each copy, so the enclosed
    // copy looks like the one the office hands over rather than a stretched-out
    // version of it.
    const height = 430;
    drawReceiptCopy(doc, {
      lines,
      institute,
      terms: data.receiptTerms,
      copyLabel: RECEIPT_COPIES[0],
      top,
      height,
    });

    doc.y = top + height + 8;
    drawParagraph(
      doc,
      "This amount is part of your total course fee and has been credited against your first installment. " +
        "It is not an additional charge.",
      { size: 8 },
    );
  });
}
