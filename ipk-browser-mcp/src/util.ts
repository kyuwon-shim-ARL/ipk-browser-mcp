/**
 * Build a compact MCP text response. No pretty-printing to save tokens.
 */
export function textResult(data: any) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data) }],
  };
}
