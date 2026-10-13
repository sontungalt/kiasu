export interface Clock {
  now(): Date;
}

export const HOUR_MS = 3_600_000;
const SGT_OFFSET_MS = 8 * HOUR_MS; // Singapore has no DST
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export const systemClock: Clock = { now: () => new Date() };

export class FakeClock implements Clock {
  private t: number;
  constructor(iso: string) {
    this.t = parse(iso).getTime();
  }
  now(): Date {
    return new Date(this.t);
  }
  set(iso: string): void {
    this.t = parse(iso).getTime();
  }
  advance(ms: number): void {
    this.t += ms;
  }
}

function parse(input: string | Date): Date {
  const d = input instanceof Date ? new Date(input.getTime()) : new Date(input);
  if (Number.isNaN(d.getTime())) throw new Error(`Invalid date: ${String(input)}`);
  return d;
}

/** Shift so that the UTC getters read Singapore wall-clock values. */
function shifted(d: Date): Date {
  return new Date(d.getTime() + SGT_OFFSET_MS);
}

export function toUtcIso(input: string | Date): string {
  return parse(input).toISOString();
}

export function sgtDateKey(d: Date): string {
  return shifted(d).toISOString().slice(0, 10);
}

export function sgtTimeHHMM(d: Date): string {
  return shifted(d).toISOString().slice(11, 16);
}

export function sgtAt(dateKey: string, hhmm: string): Date {
  return parse(`${dateKey}T${hhmm}:00+08:00`);
}

export function addDaysToKey(dateKey: string, days: number): string {
  const d = new Date(`${dateKey}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function startOfSgtDay(d: Date): Date {
  return sgtAt(sgtDateKey(d), "00:00");
}

export function formatSgt(d: Date, style: "time" | "dayDate" | "dayDateTime"): string {
  const s = shifted(d);
  const h24 = s.getUTCHours();
  const m = s.getUTCMinutes();
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  const ampm = h24 < 12 ? "am" : "pm";
  const time = m === 0 ? `${h12}${ampm}` : `${h12}:${String(m).padStart(2, "0")}${ampm}`;
  const dayDate = `${WEEKDAYS[s.getUTCDay()]} ${s.getUTCDate()} ${MONTHS[s.getUTCMonth()]}`;
  if (style === "time") return time;
  if (style === "dayDate") return dayDate;
  return `${dayDate}, ${time}`;
}

function minutesOf(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

/** True if d (SGT wall clock) is in [quietStart, quietEnd). Handles windows that wrap midnight. */
export function isQuietTime(d: Date, quietStart: string, quietEnd: string): boolean {
  const now = minutesOf(sgtTimeHHMM(d));
  const start = minutesOf(quietStart);
  const end = minutesOf(quietEnd);
  if (start === end) return false;
  return start < end ? now >= start && now < end : now >= start || now < end;
}
