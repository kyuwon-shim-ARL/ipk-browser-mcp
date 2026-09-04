import * as fs from "fs";

/** Allowed directories for attachment file uploads. Prevents arbitrary file reads. */
export const ALLOWED_ATTACHMENT_DIRS = [
  "/tmp",
  `${process.env.HOME}/Downloads`,
  `${process.env.HOME}/Documents`,
  `${process.env.HOME}/Desktop`,
];

/** Validate that an attachment path is safe to upload. */
export function validateAttachmentPath(filePath: string): string | null {
  // Block path traversal before resolving
  if (filePath.includes("..")) {
    return "Attachment path contains path traversal (..)";
  }
  // Resolve symlinks to get the real filesystem path (security: prevents symlink-to-sensitive-file attacks)
  let resolved: string;
  try {
    resolved = fs.realpathSync(filePath);
  } catch {
    return `Attachment path does not exist or is not accessible: ${filePath}`;
  }
  // Block dotfiles and sensitive directories
  if (/\/\./.test(resolved)) {
    return "Attachment path points to a hidden file/directory";
  }
  // Block system directories
  if (resolved.startsWith("/etc") || resolved.startsWith("/proc") || resolved.startsWith("/sys")) {
    return "Attachment path points to a system directory";
  }
  // Must be in an allowed directory (checked against real path, not symlink path)
  const inAllowed = ALLOWED_ATTACHMENT_DIRS.some((dir) => resolved.startsWith(dir));
  if (!inAllowed) {
    return `Attachment must be in one of: ${ALLOWED_ATTACHMENT_DIRS.join(", ")}`;
  }
  return null;
}

