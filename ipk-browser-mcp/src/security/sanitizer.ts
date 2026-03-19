/**
 * Content sanitizer for MCP responses.
 * Prevents prompt injection by isolating web content.
 */

/** Wrap content in isolation tags */
export function isolateContent(content: string): string {
  return `[CONTENT_START]\n${content}\n[CONTENT_END]`;
}

/** Remove potential prompt injection patterns from scraped content */
export function sanitizeWebContent(text: string): string {
  // Remove common prompt injection patterns
  const patterns = [
    // Direct instruction injection
    /\b(ignore|disregard|forget)\s+(all\s+)?(previous|prior|above)\s+(instructions?|prompts?|rules?)/gi,
    // System prompt extraction
    /\b(show|reveal|print|output|display)\s+(your|the|system)\s+(prompt|instructions?|rules?)/gi,
    // Role manipulation
    /\byou\s+are\s+now\s+(a|an)\s+/gi,
    // Tool abuse
    /\b(execute|run|call)\s+(tool|function|command)\s/gi,
  ];

  let sanitized = text;
  for (const pattern of patterns) {
    sanitized = sanitized.replace(pattern, "[FILTERED]");
  }

  return sanitized;
}

/** Truncate content to max chars */
export function truncateContent(text: string, maxChars: number = 2000): { text: string; truncated: boolean } {
  if (text.length <= maxChars) {
    return { text, truncated: false };
  }
  return {
    text: text.slice(0, maxChars) + "\n... [TRUNCATED]",
    truncated: true,
  };
}

/** Fail-closed: if content looks suspicious, return warning instead */
export function validateContent(content: string): { safe: boolean; warning?: string } {
  const suspiciousPatterns = [
    /<script[^>]*>/i,
    /javascript:/i,
    /on\w+\s*=/i,
  ];

  for (const pattern of suspiciousPatterns) {
    if (pattern.test(content)) {
      return {
        safe: false,
        warning: "Content contains potentially unsafe elements. Returning sanitized version.",
      };
    }
  }

  return { safe: true };
}
