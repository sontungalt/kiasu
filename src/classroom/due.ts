import { sgtAt } from "../lib/clock.js";

/** google.type.Date. Proto3 JSON omits zero/default fields, so treat every field as optional. */
export interface ClassroomDate {
  year?: number | null;
  month?: number | null;
  day?: number | null;
}

/** google.type.TimeOfDay. Proto3 JSON omits zero fields, so midnight UTC arrives as {}. */
export interface ClassroomTimeOfDay {
  hours?: number | null;
  minutes?: number | null;
  seconds?: number | null;
  nanos?: number | null;
}

const pad = (n: number) => String(n).padStart(2, "0");

/**
 * Classroom documents both `dueDate` and `dueTime` as UTC, so together they form one UTC instant.
 * The Singapore calendar day can differ from `dueDate` (for example 15 Oct 23:00Z is 16 Oct 07:00 SGT).
 * The API says `dueTime` is always set when `dueDate` is. If it isn't, we treat `dueDate`
 * as a Singapore day ending at 23:59, which is the safest end-of-day guess.
 */
export function classroomDueAt(date?: ClassroomDate | null, time?: ClassroomTimeOfDay | null): string | null {
  const y = date?.year;
  const m = date?.month;
  const d = date?.day;
  if (!y || !m || !d) return null;
  const check = new Date(Date.UTC(y, m - 1, d));
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== m - 1 || check.getUTCDate() !== d) return null;
  if (!time) return sgtAt(`${y}-${pad(m)}-${pad(d)}`, "23:59").toISOString();
  return new Date(Date.UTC(y, m - 1, d, time.hours ?? 0, time.minutes ?? 0, time.seconds ?? 0)).toISOString();
}
