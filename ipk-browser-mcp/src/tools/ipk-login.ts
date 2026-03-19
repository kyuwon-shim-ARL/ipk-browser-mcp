import { z } from "zod";
import { SessionManager } from "../browser/session.js";
import { textResult } from "../util.js";

export const ipkLoginSchema = {
  username: z.string().optional().describe("IPK groupware username. Falls back to IPK_USERNAME env var."),
  password: z.string().optional().describe("IPK groupware password. Falls back to IPK_PASSWORD env var."),
};

export const ipkLoginDescription =
  "Log in to IPK groupware (gw.ip-korea.org). Returns a session for subsequent tool calls. " +
  "Credentials can be provided as parameters or via IPK_USERNAME/IPK_PASSWORD environment variables.";

export async function handleIpkLogin(
  sessionManager: SessionManager,
  params: { username?: string; password?: string }
) {
  const username = params.username || process.env.IPK_USERNAME || "";
  const password = params.password || process.env.IPK_PASSWORD || "";

  const result = await sessionManager.login(username, password);

  if (result.error) {
    return textResult({ error: true, code: result.code, message: result.message });
  }

  // Never include credentials in response
  return textResult({
    error: false,
    data: {
      sessionId: result.data.sessionId,
      loggedIn: result.data.loggedIn,
      userInfo: {
        username: result.data.userInfo.username,
        name: result.data.userInfo.name,
      },
    },
  });
}
