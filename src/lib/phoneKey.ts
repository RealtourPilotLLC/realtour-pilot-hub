// THE ONE PHONE KEY (audit Oct 25 2026, F13): a phone number's last 10
// digits, the key every phone match in the hub compares on ("+1 (610)
// 555-0100" and "6105550100" are one number). It lived in the OpenPhone
// integration (server-only), so client components and plain libs kept their
// own copies; it lives here now, with no imports, and openphone.ts re-exports
// it under the same name.
export function phoneKey(p?: string | null): string {
  return (p ?? "").replace(/\D/g, "").slice(-10);
}

/** A teammate's number as their card stores it (E.164): 10 digits are a US
 *  number, anything longer needs its country code. Null when it can't be a
 *  phone number. People → Logins and /profile both save through this. */
export function cleanTeamPhone(raw: string): string | null {
  const digits = raw.replace(/\D/g, "");
  if (digits.length < 10 || digits.length > 15) return null;
  if (raw.trim().startsWith("+")) return `+${digits}`;
  return digits.length === 10 ? `+1${digits}` : `+${digits}`;
}

/** Is this an IANA time zone the runtime knows ("Asia/Manila")? */
export function isTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}
