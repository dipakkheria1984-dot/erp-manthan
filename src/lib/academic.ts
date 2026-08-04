import { daysBetween } from "@/lib/dates";
import { yearNumberForSemester } from "@/lib/fees";

/**
 * Academic structure rules shared by the batch editor and the bulk import, so a
 * batch created either way ends up with the same semester layout.
 */

export type SemesterSlot = {
  semesterNumber: number;
  startDate: Date;
  endDate: Date;
  yearNumber: number;
  /**
   * True for the semesters of year 1, which are the ones tied to the current
   * academic year when a batch is created. Later years get their academic year
   * when the cohort is promoted into them.
   */
  isFirstYear: boolean;
};

/**
 * Spreads a course's semesters evenly across the batch window (spec 5.3/5.4).
 * The last semester absorbs any rounding remainder so the final end date lands
 * exactly on the completion date.
 */
export function semesterLayout({
  startDate,
  completionDate,
  totalSemesters,
  durationYears,
}: {
  startDate: Date;
  completionDate: Date;
  totalSemesters: number;
  durationYears: number;
}): SemesterSlot[] {
  const perYear = Math.max(1, Math.round(totalSemesters / Math.max(1, durationYears)));
  const totalDays = daysBetween(startDate, completionDate);
  const slice = Math.floor(totalDays / totalSemesters);

  return Array.from({ length: totalSemesters }, (_, i) => {
    const semesterNumber = i + 1;
    const start = new Date(startDate);
    start.setDate(start.getDate() + slice * i);
    const end = new Date(startDate);
    end.setDate(end.getDate() + (semesterNumber === totalSemesters ? totalDays : slice * semesterNumber - 1));

    return {
      semesterNumber,
      startDate: start,
      endDate: end,
      yearNumber: yearNumberForSemester(semesterNumber, totalSemesters, durationYears),
      isFirstYear: semesterNumber <= perYear,
    };
  });
}
