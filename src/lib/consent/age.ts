/**
 * Age rules for sign-up (PRD 6.4, P6-16). A learner under 13 needs a parent or guardian to
 * agree before their account is active. The database makes the same decision when the account
 * is created (supabase/migrations/..._consent.sql); this module lets the form check and explain
 * it first. Both compare calendar dates, not durations, so the day someone turns 13 is exact.
 */

export const CONSENT_AGE = 13;
const EARLIEST_YEAR = 1900;

/** A real calendar date written YYYY-MM-DD, so not 31 February. */
export function isRealDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

/** The date `years` before `today`. 29 February becomes 1 March in a year that has no 29th. */
function yearsBefore(today: string, years: number): string {
  const [y, m, d] = today.split("-").map(Number);
  const date = new Date(Date.UTC(y - years, m - 1, d));
  return date.toISOString().slice(0, 10);
}

export function todayIso(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

/** Whether this date of birth is possible: real, not in the future, not before 1900. */
export function isPlausibleBirthDate(birthDate: string, today: string): boolean {
  return (
    isRealDate(birthDate) && birthDate <= today && Number(birthDate.slice(0, 4)) >= EARLIEST_YEAR
  );
}

/** True while the person has not yet had their 13th birthday. */
export function needsGuardianConsent(birthDate: string, today: string): boolean {
  return birthDate > yearsBefore(today, CONSENT_AGE);
}
