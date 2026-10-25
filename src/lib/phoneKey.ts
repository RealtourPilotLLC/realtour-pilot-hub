// THE ONE PHONE KEY (audit Oct 25 2026, F13): a phone number's last 10
// digits, the key every phone match in the hub compares on ("+1 (610)
// 555-0100" and "6105550100" are one number). It lived in the OpenPhone
// integration (server-only), so client components and plain libs kept their
// own copies; it lives here now, with no imports, and openphone.ts re-exports
// it under the same name.
export function phoneKey(p?: string | null): string {
  return (p ?? "").replace(/\D/g, "").slice(-10);
}
