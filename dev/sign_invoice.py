#!/usr/bin/env python3
"""
sign_invoice.py - Auto-place electronic signature on invoice PDFs.

Usage:
    python sign_invoice.py <invoice.pdf> [output.pdf]
    python sign_invoice.py                          # process all detected invoices in data/

Detection: PDF text-content based (INVOICE + TOTAL/AMOUNT + BILL TO/FROM keywords).
Signature position: auto-calculated from text block layout (gap between billing info and item table).
"""

import sys
import io
import fitz
import numpy as np
from PIL import Image
from pathlib import Path

SIG_PATH = Path("/home/kyuwon/projects/심규원싸인.png")
DATA_DIR = Path("data/attachments")

INVOICE_KEYWORDS = {"invoice", "total paid", "total amount", "bill to", "invoice id", "invoice #", "invoice no"}
INVOICE_THRESHOLD = 3  # must match at least 3 distinct keywords


def is_invoice(pdf_path: Path) -> bool:
    """Detect invoice by text content, not filename."""
    try:
        doc = fitz.open(str(pdf_path))
        text = doc[0].get_text().lower()
        doc.close()
        matched = sum(1 for kw in INVOICE_KEYWORDS if kw in text)
        return matched >= INVOICE_THRESHOLD
    except Exception:
        return False


def find_sig_rect(page: fitz.Page) -> fitz.Rect:
    """
    Find the best gap for signature placement:
    - Between billing info block (BILL TO / email) and item table (ITEM/AMOUNT header)
    - Prefer left column of that gap
    Falls back to bottom-left if no gap found.
    """
    blocks = page.get_text("blocks")
    page_w = page.rect.width

    billing_end_y = None
    table_start_y = None

    for b in blocks:
        x0, y0, x1, y1, text, *_ = b
        t = text.strip().lower()
        if any(kw in t for kw in ("bill to", "invoice id", "invoice #", "@", "arl.")):
            billing_end_y = max(billing_end_y or 0, y1)
        if t.startswith("item") and "amount" in t:
            table_start_y = y0

    if billing_end_y and table_start_y and (table_start_y - billing_end_y) > 40:
        gap_top = billing_end_y + 4
        gap_bot = table_start_y - 4
        sig_h = gap_bot - gap_top
        sig_w = min(sig_h * 2.2, page_w * 0.35)
        return fitz.Rect(40, gap_top, 40 + sig_w, gap_bot)

    # Fallback: bottom-left
    return fitz.Rect(40, page.rect.height - 100, 210, page.rect.height - 20)


def load_sig_transparent(max_height: int = 300) -> bytes:
    """Load signature PNG, make white background transparent, resize to max_height."""
    sig = Image.open(SIG_PATH).convert("RGBA")
    ratio = max_height / sig.height
    sig = sig.resize((int(sig.width * ratio), max_height), Image.LANCZOS)
    data = np.array(sig)
    white = (data[:, :, 0] > 220) & (data[:, :, 1] > 220) & (data[:, :, 2] > 220)
    data[white, 3] = 0
    buf = io.BytesIO()
    Image.fromarray(data).save(buf, format="PNG", optimize=True)
    return buf.getvalue()


def sign_pdf(src: Path, dst: Path | None = None) -> Path:
    """Place signature on invoice PDF. Overwrites in-place if dst is None."""
    import shutil, tempfile
    in_place = dst is None or dst == src
    if in_place:
        tmp = Path(tempfile.mktemp(suffix=".pdf"))
    else:
        tmp = dst
    sig_bytes = load_sig_transparent()
    doc = fitz.open(str(src))
    page = doc[0]
    rect = find_sig_rect(page)
    print(f"  Signature rect: {rect}")
    page.insert_image(rect, stream=sig_bytes)
    doc.save(str(tmp), garbage=4, deflate=True, clean=True)
    doc.close()
    if in_place:
        shutil.move(str(tmp), str(src))
        return src
    return dst


def main():
    if len(sys.argv) >= 2:
        src = Path(sys.argv[1])
        dst = Path(sys.argv[2]) if len(sys.argv) >= 3 else None
        if not src.exists():
            print(f"ERROR: {src} not found"); sys.exit(1)
        if not is_invoice(src):
            print(f"WARNING: {src.name} does not look like an invoice (low keyword match). Proceeding anyway.")
        out = sign_pdf(src, dst)
        print(f"Signed: {out}")
    else:
        # Batch: scan DATA_DIR for unsigned invoices
        pdfs = list(DATA_DIR.rglob("*.pdf"))
        print(f"Scanning {len(pdfs)} PDFs in {DATA_DIR}...")
        for pdf in pdfs:
            if is_invoice(pdf):
                # Skip already-signed (heuristic: check if signature image already embedded)
                doc = fitz.open(str(pdf))
                has_img = len(doc[0].get_images()) > 0
                doc.close()
                if has_img:
                    print(f"  SKIP (already has image): {pdf.name}")
                    continue
                print(f"  Signing: {pdf}")
                sign_pdf(pdf)
                print(f"    Done.")


if __name__ == "__main__":
    main()
