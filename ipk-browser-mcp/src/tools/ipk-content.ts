import { z } from "zod";
import { SessionManager } from "../browser/session.js";
import { getMainFrame } from "../browser/iframe-helper.js";
import { Config, PageContent } from "../types.js";
import { sanitizeWebContent, isolateContent, truncateContent } from "../security/sanitizer.js";
import { maskPiiInText } from "../security/masking.js";
import { textResult } from "../util.js";

export const ipkGetContentSchema = {
  max_chars: z.number().default(2000).describe("Maximum characters to return (default 2000)"),
  include_forms: z.boolean().default(false).describe("Include form field names and values"),
  frame: z
    .enum(["main_menu", "page"])
    .default("main_menu")
    .describe("Which frame to extract content from"),
};

export const ipkGetContentDescription =
  "Extract text content from the current page or main_menu iframe in IPK groupware. " +
  "Returns structured text, sanitized and truncated. Use include_forms=true to see form fields.";

export async function handleIpkGetContent(
  sessionManager: SessionManager,
  config: Config,
  params: { max_chars?: number; include_forms?: boolean; frame?: string }
) {
  if (!sessionManager.isLoggedIn()) {
    return textResult({ error: true, code: "NOT_LOGGED_IN", message: "Call ipk_login first" });
  }

  const page = sessionManager.getPage()!;
  const maxChars = params.max_chars || 2000;

  try {
    const target = params.frame === "page" ? page : getMainFrame(page);
    if (!target) {
      return textResult({
        error: true,
        code: "FRAME_NOT_FOUND",
        message: "main_menu frame not found. Navigate first.",
      });
    }

    // Extract text content - PARAMETERIZED
    const rawContent = await target.evaluate(
      (opts: { includeForms: boolean }) => {
        let text = document.body?.innerText || "";

        if (opts.includeForms) {
          const formFields: string[] = [];
          const inputs = document.querySelectorAll("input, select, textarea");
          inputs.forEach((el: any) => {
            const name = el.getAttribute("name");
            if (!name) return;
            const type = el.tagName.toLowerCase();
            const value = el.value || "";
            formFields.push(`[${type}] ${name} = ${value}`);
          });

          if (formFields.length > 0) {
            text += "\n\n--- Form Fields ---\n" + formFields.join("\n");
          }
        }

        return {
          text,
          url: window.location.href,
          title: document.title,
        };
      },
      { includeForms: params.include_forms || false }
    );

    // Sanitize and mask PII
    let processedText = sanitizeWebContent(rawContent.text);
    processedText = maskPiiInText(processedText);
    const { text: truncatedText, truncated } = truncateContent(processedText, maxChars);

    const content: PageContent = {
      url: rawContent.url,
      title: rawContent.title,
      text: truncatedText,
      truncated,
    };

    return textResult({
      error: false,
      data: {
        url: content.url,
        title: content.title,
        truncated: content.truncated,
        content: isolateContent(content.text),
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return textResult({ error: true, code: "CONTENT_ERROR", message: msg });
  }
}

