#!/usr/bin/env python3
"""Reusable email screenshot utility using Gmail API + Playwright."""

import argparse
import base64
import json
import os
import re
import sys
from pathlib import Path

from google.oauth2.credentials import Credentials
from googleapiclient.discovery import build
from playwright.sync_api import sync_playwright

TOKEN_PATH = "/home/kyuwon/projects/email_agent/token.json"
SCOPES = ["https://www.googleapis.com/auth/gmail.readonly"]


# ---------------------------------------------------------------------------
# Gmail API helpers
# ---------------------------------------------------------------------------

def _get_gmail_service():
    creds = Credentials.from_authorized_user_file(TOKEN_PATH, SCOPES)
    return build("gmail", "v1", credentials=creds)


def search_emails(query: str, user_email: str, max_results: int = 10) -> list[dict]:
    """Search Gmail and return a list of message metadata dicts."""
    service = _get_gmail_service()
    result = (
        service.users()
        .messages()
        .list(userId="me", q=query, maxResults=max_results)
        .execute()
    )
    messages = result.get("messages", [])
    if not messages:
        return []

    out = []
    for m in messages:
        msg = service.users().messages().get(userId="me", id=m["id"], format="metadata").execute()
        headers = {h["name"]: h["value"] for h in msg.get("payload", {}).get("headers", [])}
        out.append(
            {
                "id": m["id"],
                "threadId": msg.get("threadId"),
                "subject": headers.get("Subject", "(no subject)"),
                "from": headers.get("From", ""),
                "to": headers.get("To", ""),
                "date": headers.get("Date", ""),
                "snippet": msg.get("snippet", ""),
            }
        )
    return out


def get_email_content(message_id: str, user_email: str) -> dict:
    """Fetch full email content (plain text + HTML) for a given message ID."""
    service = _get_gmail_service()
    msg = service.users().messages().get(userId="me", id=message_id, format="full").execute()

    headers = {h["name"]: h["value"] for h in msg.get("payload", {}).get("headers", [])}

    def _decode_part(part) -> tuple[str, str]:
        """Return (mime_type, decoded_text) for a message part."""
        mime = part.get("mimeType", "")
        body = part.get("body", {})
        data = body.get("data", "")
        if data:
            text = base64.urlsafe_b64decode(data + "==").decode("utf-8", errors="replace")
            return mime, text
        # recurse into sub-parts
        for sub in part.get("parts", []):
            result = _decode_part(sub)
            if result[1]:
                return result
        return mime, ""

    payload = msg.get("payload", {})
    html_body = ""
    plain_body = ""

    if payload.get("mimeType", "").startswith("multipart"):
        for part in payload.get("parts", []):
            mime, text = _decode_part(part)
            if mime == "text/html" and not html_body:
                html_body = text
            elif mime == "text/plain" and not plain_body:
                plain_body = text
    else:
        mime, text = _decode_part(payload)
        if mime == "text/html":
            html_body = text
        else:
            plain_body = text

    return {
        "id": message_id,
        "subject": headers.get("Subject", "(no subject)"),
        "from": headers.get("From", ""),
        "to": headers.get("To", ""),
        "cc": headers.get("Cc", ""),
        "date": headers.get("Date", ""),
        "html_body": html_body,
        "plain_body": plain_body,
        "snippet": msg.get("snippet", ""),
    }


# ---------------------------------------------------------------------------
# HTML rendering
# ---------------------------------------------------------------------------

def _plain_to_html(text: str) -> str:
    """Convert plain text to simple HTML, collapsing quoted blocks."""
    lines = text.splitlines()
    out_lines = []
    in_quote = False
    for line in lines:
        if line.startswith(">"):
            if not in_quote:
                out_lines.append('<div class="quoted">[Quoted text hidden]</div>')
                in_quote = True
        else:
            in_quote = False
            out_lines.append(line.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;"))
    return "<br>\n".join(out_lines)


def _sanitize_html(html: str) -> str:
    """Remove script tags and hide quoted reply blocks."""
    # Remove scripts
    html = re.sub(r"<script[^>]*>.*?</script>", "", html, flags=re.DOTALL | re.IGNORECASE)
    # Hide Gmail-style quoted text
    html = re.sub(
        r'<div class="gmail_quote".*?</div>',
        '<div class="quoted">[Quoted text hidden]</div>',
        html,
        flags=re.DOTALL | re.IGNORECASE,
    )
    return html


def render_email_html(messages: list[dict], account_email: str = "") -> str:
    """Render a list of email message dicts as a Gmail-style HTML thread."""
    if not messages:
        return "<p>No messages found.</p>"

    subject = messages[0].get("subject", "(no subject)")
    msg_count = len(messages)

    message_blocks = []
    for msg in messages:
        body_html = ""
        if msg.get("html_body"):
            body_html = _sanitize_html(msg["html_body"])
        elif msg.get("plain_body"):
            body_html = f"<pre style='font-family:Arial,sans-serif;white-space:pre-wrap'>{_plain_to_html(msg['plain_body'])}</pre>"
        else:
            body_html = f"<p><em>{msg.get('snippet','')}</em></p>"

        cc_row = ""
        if msg.get("cc"):
            cc_row = f'<tr><td class="lbl">Cc:</td><td>{msg["cc"]}</td></tr>'

        message_blocks.append(f"""
<div class="message-card">
  <table class="msg-header">
    <tr><td class="lbl">From:</td><td>{msg.get("from","")}</td></tr>
    <tr><td class="lbl">To:</td><td>{msg.get("to","")}</td></tr>
    {cc_row}
    <tr><td class="lbl">Date:</td><td>{msg.get("date","")}</td></tr>
  </table>
  <div class="msg-body">{body_html}</div>
</div>
""")

    blocks_html = "\n".join(message_blocks)

    return f"""<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  body {{
    font-family: Arial, sans-serif;
    font-size: 13px;
    color: #202124;
    background: #ffffff;
    margin: 0;
    padding: 24px;
  }}
  .account-header {{
    font-size: 11px;
    color: #5f6368;
    margin-bottom: 16px;
  }}
  h2.subject {{
    font-size: 22px;
    font-weight: 400;
    color: #202124;
    margin: 0 0 4px 0;
  }}
  .msg-count {{
    font-size: 11px;
    color: #5f6368;
    margin-bottom: 20px;
  }}
  .message-card {{
    border: 1px solid #e0e0e0;
    border-radius: 4px;
    margin-bottom: 16px;
    padding: 16px;
  }}
  .msg-header {{
    font-size: 12px;
    color: #5f6368;
    border-collapse: collapse;
    margin-bottom: 12px;
  }}
  .msg-header td {{
    padding: 2px 8px 2px 0;
    vertical-align: top;
  }}
  .lbl {{
    font-weight: 600;
    white-space: nowrap;
    color: #202124;
  }}
  .msg-body {{
    font-size: 13px;
    line-height: 1.6;
    color: #202124;
  }}
  .quoted {{
    font-size: 11px;
    color: #5f6368;
    font-style: italic;
    margin: 8px 0;
  }}
  pre {{
    margin: 0;
  }}
</style>
</head>
<body>
  <div class="account-header">{account_email}</div>
  <h2 class="subject">{subject}</h2>
  <div class="msg-count">{msg_count} message{"s" if msg_count != 1 else ""}</div>
  {blocks_html}
</body>
</html>"""


# ---------------------------------------------------------------------------
# Playwright screenshot
# ---------------------------------------------------------------------------

def screenshot_email(html: str, output_path: str, fit_single_page: bool = True) -> str:
    """Render HTML and save a screenshot. Returns the output path."""
    A4_HEIGHT = 1273  # pixels at 900px width (A4 ratio: 1:1.414 -> 900*1.414)
    MIN_SCALE = 0.7

    with sync_playwright() as p:
        browser = p.chromium.launch()

        # First pass: measure content height
        page = browser.new_page(viewport={"width": 900, "height": 1200})
        page.set_content(html)
        page.wait_for_timeout(500)

        if fit_single_page:
            content_height = page.evaluate("document.body.scrollHeight")

            if content_height > A4_HEIGHT:
                scale = max(MIN_SCALE, A4_HEIGHT / content_height)
                # Inject CSS transform scale on body
                scaled_html = html.replace(
                    "<body>",
                    f'<body style="transform:scale({scale:.4f});transform-origin:top left;'
                    f'width:{int(900/scale)}px;">',
                )
                page.set_content(scaled_html)
                page.wait_for_timeout(500)

        page.screenshot(path=output_path, full_page=True)
        browser.close()

    print(f"Screenshot saved: {output_path}")
    return output_path


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(
        description="Search Gmail and screenshot the results as a Gmail-style HTML thread."
    )
    parser.add_argument("query", help="Gmail search query (e.g. 'subject:invoice from:finance')")
    parser.add_argument("output", help="Output PNG path (e.g. output.png)")
    parser.add_argument(
        "--email",
        default="kyuwon.shim@ip-korea.org",
        help="Gmail account email address (default: kyuwon.shim@ip-korea.org)",
    )
    parser.add_argument(
        "--max-results",
        type=int,
        default=10,
        help="Maximum number of messages to fetch (default: 10)",
    )
    parser.add_argument(
        "--no-fit",
        action="store_true",
        help="Disable single-page auto-scale (screenshot full content height)",
    )
    parser.add_argument(
        "--save-html",
        metavar="PATH",
        help="Also save rendered HTML to this path",
    )
    args = parser.parse_args()

    print(f"Searching: {args.query!r}  (max {args.max_results})")
    messages_meta = search_emails(args.query, args.email, max_results=args.max_results)

    if not messages_meta:
        print("No messages found.")
        sys.exit(1)

    print(f"Found {len(messages_meta)} message(s). Fetching full content...")
    messages = [get_email_content(m["id"], args.email) for m in messages_meta]

    html = render_email_html(messages, account_email=args.email)

    if args.save_html:
        Path(args.save_html).write_text(html, encoding="utf-8")
        print(f"HTML saved: {args.save_html}")

    screenshot_email(html, args.output, fit_single_page=not args.no_fit)


if __name__ == "__main__":
    main()
