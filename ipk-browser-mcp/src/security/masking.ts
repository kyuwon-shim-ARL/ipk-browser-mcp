/**
 * PII masking for MCP responses.
 * Masks personal data before sending to LLM.
 */

/** Mask Korean name: 홍길동 → 홍*동 */
export function maskKoreanName(name: string): string {
  if (!name || name.length < 2) return name;

  // Korean names: 2-4 characters
  if (/^[\uAC00-\uD7AF]{2,4}$/.test(name)) {
    if (name.length === 2) return name[0] + "*";
    if (name.length === 3) return name[0] + "*" + name[2];
    return name[0] + "*".repeat(name.length - 2) + name[name.length - 1];
  }

  // English names: keep first and last parts
  const parts = name.split(/\s+/);
  if (parts.length >= 2) {
    return parts[0][0] + "." + " " + parts[parts.length - 1];
  }

  return name[0] + "*".repeat(Math.max(1, name.length - 2)) + name[name.length - 1];
}

/** Mask phone number: 010-1234-5678 → 010-****-5678 */
export function maskPhone(phone: string): string {
  if (!phone) return phone;
  // Korean phone format: 010-XXXX-XXXX or 01012345678
  return phone.replace(
    /(\d{2,3})[-.]?(\d{3,4})[-.]?(\d{4})/,
    "$1-****-$3"
  );
}

/** Mask email: user@example.com → u***@example.com */
export function maskEmail(email: string): string {
  if (!email || !email.includes("@")) return email;
  const [local, domain] = email.split("@");
  if (local.length <= 1) return email;
  return local[0] + "***@" + domain;
}

/** Mask address: only keep city/region level */
export function maskAddress(address: string): string {
  if (!address) return address;
  // Keep only the first part (city/region)
  const parts = address.split(/[,\s]+/);
  return parts[0] + " [MASKED]";
}

/** Known PII field names in IPK groupware */
const PII_FIELDS: Record<string, (value: string) => string> = {
  substitute_name: maskKoreanName,
  emergency_telephone: maskPhone,
  emergency_address: maskAddress,
  report_name: maskKoreanName,
  report_leader: maskKoreanName,
  ov_member: (v) => v.split(/[,;]/).map((n) => maskKoreanName(n.trim())).join(", "),
};

/**
 * Apply PII masking to a key-value record.
 * Only masks known PII fields.
 */
export function maskPiiFields(data: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(data)) {
    const maskFn = PII_FIELDS[key];
    result[key] = maskFn ? maskFn(value) : value;
  }
  return result;
}

/**
 * Mask PII in free text content.
 * Applies phone, email, and Korean name pattern matching.
 */
export function maskPiiInText(text: string): string {
  // Mask phone numbers
  let result = text.replace(
    /\d{2,3}[-.]?\d{3,4}[-.]?\d{4}/g,
    (match) => maskPhone(match)
  );

  // Mask email addresses
  result = result.replace(
    /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g,
    (match) => maskEmail(match)
  );

  // Mask standalone Korean names (2-4 chars surrounded by whitespace/punctuation)
  result = result.replace(
    /(?<=[\s,;:(]|^)([\uAC00-\uD7AF]{2,4})(?=[\s,;:)]|$)/g,
    (match) => maskKoreanName(match)
  );

  return result;
}
