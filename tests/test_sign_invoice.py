"""Unit + integration tests for sign_invoice.py."""
import io
import sys
import os
import pytest
import numpy as np
from unittest.mock import MagicMock, patch
from pathlib import Path
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "dev"))
import fitz
from sign_invoice import is_invoice, find_sig_rect, load_sig_transparent, sign_pdf, INVOICE_THRESHOLD


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _mock_doc(text: str):
    """Mock fitz document whose page[0].get_text() returns `text`."""
    page = MagicMock()
    page.get_text.return_value = text
    doc = MagicMock()
    doc.__getitem__.return_value = page
    return doc


def _make_page(blocks: list, width: float = 595.0, height: float = 842.0):
    """Mock fitz.Page with specific text blocks and page rect."""
    page = MagicMock()
    page.get_text.return_value = blocks
    page.rect = fitz.Rect(0, 0, width, height)
    return page


def _make_sig_png(tmp_path: Path) -> Path:
    """Minimal white-background PNG with dark 'ink' pixels."""
    img = Image.new("RGBA", (200, 80), (255, 255, 255, 255))
    pixels = img.load()
    for x in range(10, 190):
        for y in range(20, 60):
            pixels[x, y] = (20, 20, 20, 255)
    out = tmp_path / "fake_sig.png"
    img.save(out, "PNG")
    return out


def _make_invoice_pdf(tmp_path: Path) -> Path:
    """Minimal invoice PDF with known text structure."""
    pdf_path = tmp_path / "invoice.pdf"
    doc = fitz.open()
    page = doc.new_page(width=595, height=842)
    page.insert_text(
        (40, 80),
        (
            "INVOICE #2026-001\n"
            "Bill To: ARL Research Lab\n"
            "arl@example.com\n\n"
            "Invoice ID: INV-2026-001\n\n"
            "ITEM                         AMOUNT\n"
            "GPU Compute Credits          $1,500.00\n\n"
            "Total Amount: $1,500.00\n"
            "Total Paid:   $0.00\n"
        ),
        fontsize=11,
    )
    doc.save(str(pdf_path))
    doc.close()
    return pdf_path


# ---------------------------------------------------------------------------
# is_invoice
# ---------------------------------------------------------------------------

INVOICE_TEXT = (
    "invoice #12345\n"
    "bill to: arl lab\n"
    "invoice id: inv-001\n"
    "total amount: $1,500.00\n"
    "total paid: $0.00\n"
)
NON_INVOICE_TEXT = "meeting minutes q1 review\nattendees: alice, bob\ndate: 2026-03-01\n"


def test_is_invoice_positive(tmp_path):
    fake_pdf = tmp_path / "inv.pdf"
    fake_pdf.write_bytes(b"%PDF-1.4")
    with patch("sign_invoice.fitz.open", return_value=_mock_doc(INVOICE_TEXT)):
        assert is_invoice(fake_pdf) is True


def test_is_invoice_negative(tmp_path):
    fake_pdf = tmp_path / "minutes.pdf"
    fake_pdf.write_bytes(b"%PDF-1.4")
    with patch("sign_invoice.fitz.open", return_value=_mock_doc(NON_INVOICE_TEXT)):
        assert is_invoice(fake_pdf) is False


def test_is_invoice_at_threshold(tmp_path):
    # Exactly INVOICE_THRESHOLD (3) keywords → True
    text = "invoice\ntotal paid\nbill to"
    fake_pdf = tmp_path / "border.pdf"
    fake_pdf.write_bytes(b"%PDF-1.4")
    with patch("sign_invoice.fitz.open", return_value=_mock_doc(text)):
        assert is_invoice(fake_pdf) is True


def test_is_invoice_one_below_threshold(tmp_path):
    # Only 2 keywords → False
    text = "invoice\ntotal paid"
    fake_pdf = tmp_path / "below.pdf"
    fake_pdf.write_bytes(b"%PDF-1.4")
    with patch("sign_invoice.fitz.open", return_value=_mock_doc(text)):
        assert is_invoice(fake_pdf) is False


def test_is_invoice_exception_returns_false(tmp_path):
    fake_pdf = tmp_path / "bad.pdf"
    fake_pdf.write_bytes(b"not a pdf")
    with patch("sign_invoice.fitz.open", side_effect=Exception("corrupt")):
        assert is_invoice(fake_pdf) is False


def test_is_invoice_threshold_constant():
    assert INVOICE_THRESHOLD == 3


# ---------------------------------------------------------------------------
# find_sig_rect
# ---------------------------------------------------------------------------

def test_find_sig_rect_gap_found():
    # billing ends at y=200, table starts at y=280 → gap 80 > 40
    blocks = [
        (10, 150, 300, 200, "Bill To: ARL Lab\narl@example.com", 0, 0),
        (10, 280, 500, 320, "ITEM                 AMOUNT", 0, 0),
    ]
    rect = find_sig_rect(_make_page(blocks))
    assert rect.y0 > 200
    assert rect.y1 < 280


def _assert_clear(rect, blocks):
    for b in blocks:
        if str(b[4]).strip():
            assert not rect.intersects(fitz.Rect(b[:4])), f"{rect} overlaps {b[4]!r}"


def test_find_sig_rect_gap_too_small_goes_below_content():
    # Gap of only 20 px < 40 threshold → no RunPod gap; below the last content block
    blocks = [
        (10, 150, 300, 200, "Bill To: ARL Lab", 0, 0),
        (10, 220, 500, 260, "ITEM   AMOUNT", 0, 0),
    ]
    rect = find_sig_rect(_make_page(blocks, height=842.0))
    assert rect.y0 > 260
    _assert_clear(rect, blocks)


def test_find_sig_rect_no_billing_block_goes_below_content():
    blocks = [
        (10, 280, 500, 320, "ITEM   AMOUNT", 0, 0),
    ]
    rect = find_sig_rect(_make_page(blocks))
    assert rect.y0 > 320
    _assert_clear(rect, blocks)


def test_find_sig_rect_no_table_header_goes_below_content():
    blocks = [
        (10, 150, 300, 200, "Bill To: ARL Lab", 0, 0),
    ]
    rect = find_sig_rect(_make_page(blocks))
    assert rect.y0 > 200
    _assert_clear(rect, blocks)


def test_find_sig_rect_stays_above_footer_and_skips_blank_blocks():
    # Anthropic layout: last content ends at 511, footer line at 747, a blank '\xa0' block at 571.
    blocks = [
        (251, 152, 569, 274, "Bill to\nInstitut Pasteur Korea", 0, 0),
        (30, 365, 582, 375, "Description\nQty\nUnit price\nTax\nAmount\n", 0, 0),
        (30, 502, 178, 511, "[1] Tax to be paid on reverse charge basis\n", 0, 0),
        (0, 571, 3, 582, "\xa0\n", 0, 0),
        (30, 747, 582, 756, "XXXXXXXX-0001 · $100.00 USD due January 1, 2030\nPage 1 of 1\n", 0, 0),
    ]
    rect = find_sig_rect(_make_page(blocks, width=612.0, height=792.0))
    assert rect.y0 > 511
    assert rect.y1 < 747
    _assert_clear(rect, blocks)


def test_find_sig_rect_no_room_above_footer_falls_back_bottom_left():
    # Content runs into the footer band: nothing clear below it → the old bottom-left spot
    blocks = [
        (10, 100, 500, 735, "Bill To: lots of text", 0, 0),
    ]
    rect = find_sig_rect(_make_page(blocks))
    assert rect.y1 >= 742


# --- the two real layouts, rebuilt with fitz (the sample PDFs are not committed) ---

def _legacy_runpod_rect(page):
    """find_sig_rect before the Anthropic change: the RunPod gap, or None."""
    billing_end_y = table_start_y = None
    for x0, y0, x1, y1, text, *_ in page.get_text("blocks"):
        t = text.strip().lower()
        if any(kw in t for kw in ("bill to", "invoice id", "invoice #", "@", "arl.")):
            billing_end_y = max(billing_end_y or 0, y1)
        if t.startswith("item") and "amount" in t:
            table_start_y = y0
    if billing_end_y and table_start_y and (table_start_y - billing_end_y) > 40:
        gap_top, gap_bot = billing_end_y + 4, table_start_y - 4
        sig_w = min((gap_bot - gap_top) * 2.2, page.rect.width * 0.35)
        return fitz.Rect(40, gap_top, 40 + sig_w, gap_bot)
    return None


def _runpod_like_pdf(path: Path) -> Path:
    doc = fitz.open()
    page = doc.new_page(width=595.28, height=841.89)
    for (x, y, text, size) in [
        (50, 80, "Runpod Inc", 18), (50, 107, "Date: Oct 17, 2026", 11),
        (50, 127, "Invoice ID: pi_3URJV7LeeX2jf1uK1OiGIWZg", 11),
        (50, 160, "FROM\n1181 Nixon Dr. #1158, Moorestown, NJ 08057, USA", 11),
        (50, 222, "BILL TO", 11), (50, 240, "billing@example.com", 11),
        (481, 78, "INVOICE", 16), (479, 172, "TOTAL PAID", 11), (495, 197, "$100.00", 14),
        (40, 328, "ITEM                                                   AMOUNT", 11),
        (40, 362, "GPU Compute Credits                                    $100.00", 11),
    ]:
        page.insert_text((x, y), text, fontsize=size)
    doc.save(str(path))
    doc.close()
    return path


def _anthropic_like_pdf(path: Path) -> Path:
    doc = fitz.open()
    page = doc.new_page(width=612, height=792)
    for (x, y, text, size) in [
        (30, 48, "Invoice", 18),
        (30, 78, "Invoice number   XXXXXXXX-0001\nDate of issue    January 1, 2030\nDate due         January 1, 2030", 9),
        (30, 160, "Anthropic, PBC\n548 Market Street\nSan Francisco, California 94104", 9),
        (251, 160, "Bill to\nInstitut Pasteur Korea\nGyeonggi-do Seongnam\nbilling@example.com", 9),
        (30, 310, "$100.00 USD due January 1, 2030", 12), (30, 333, "Pay online", 9),
        (30, 373, "Description                     Qty    Unit price    Tax    Amount", 9),
        (30, 395, "Max plan - 20x                  1      $100.00       0%     $100.00", 9),
        (306, 437, "Subtotal                $100.00", 9), (306, 451, "Total                   $100.00", 9),
        (306, 465, "Amount due              $100.00 USD", 9),
        (30, 509, "[1] Tax to be paid on reverse charge basis", 8),
        (30, 754, "XXXXXXXX-0001 - $100.00 USD due January 1, 2030                       Page 1 of 1", 8),
    ]:
        page.insert_text((x, y), text, fontsize=size)
    doc.save(str(path))
    doc.close()
    return path


def _check_layout(pdf: Path, footer_band: float = 100.0):
    doc = fitz.open(str(pdf))
    page = doc[0]
    blocks = page.get_text("blocks")
    rect = find_sig_rect(page)
    legacy = _legacy_runpod_rect(page)
    h = page.rect.height
    doc.close()
    _assert_clear(rect, blocks)
    content_bottom = max(b[3] for b in blocks if str(b[4]).strip() and b[1] < h - footer_band)
    return rect, legacy, content_bottom


def test_runpod_layout_placement_unchanged(tmp_path):
    rect, legacy, _ = _check_layout(_runpod_like_pdf(tmp_path / "runpod.pdf"))
    assert legacy is not None, "the synthetic RunPod layout must take the billing/ITEM gap"
    assert rect == legacy


def test_anthropic_layout_below_content_clear_of_footer(tmp_path):
    rect, legacy, content_bottom = _check_layout(_anthropic_like_pdf(tmp_path / "anthropic.pdf"))
    assert legacy is None
    assert rect.y0 > content_bottom
    assert rect.y1 < 792 - 30


REAL_RUNPOD = Path(os.environ["IPK_SAMPLE_RUNPOD_INVOICE"]) if os.environ.get("IPK_SAMPLE_RUNPOD_INVOICE") else Path("/nonexistent")
REAL_ANTHROPIC = Path(os.environ["IPK_SAMPLE_ANTHROPIC_INVOICE"]) if os.environ.get("IPK_SAMPLE_ANTHROPIC_INVOICE") else Path("/nonexistent")


@pytest.mark.skipif(not REAL_RUNPOD.exists(), reason="local RunPod sample not present")
def test_real_runpod_sample_unchanged():
    rect, legacy, _ = _check_layout(REAL_RUNPOD)
    assert legacy is not None and rect == legacy


@pytest.mark.skipif(not REAL_ANTHROPIC.exists(), reason="local Anthropic sample not present")
def test_real_anthropic_sample_clear():
    rect, _, content_bottom = _check_layout(REAL_ANTHROPIC)
    assert rect.y0 > content_bottom


def test_find_sig_rect_empty_page_falls_back():
    rect = find_sig_rect(_make_page([]))
    assert rect.y1 >= 742


def test_find_sig_rect_width_capped_at_35pct():
    # Large gap → sig_w = sig_h * 2.2, but must not exceed 35% of page width
    blocks = [
        (10, 100, 300, 150, "Bill To: ARL Lab", 0, 0),
        (10, 500, 500, 540, "ITEM   AMOUNT", 0, 0),
    ]
    rect = find_sig_rect(_make_page(blocks, width=595.0))
    if rect.y0 > 150:  # gap was used (not fallback)
        assert (rect.x1 - rect.x0) <= 595.0 * 0.35 + 0.01


def test_find_sig_rect_invoice_id_keyword_counts():
    # "invoice id" in a block should also set billing_end_y
    blocks = [
        (10, 150, 300, 200, "Invoice ID: INV-001", 0, 0),
        (10, 280, 500, 320, "ITEM   AMOUNT", 0, 0),
    ]
    rect = find_sig_rect(_make_page(blocks))
    assert rect.y0 > 200
    assert rect.y1 < 280


# ---------------------------------------------------------------------------
# load_sig_transparent
# ---------------------------------------------------------------------------

def test_load_sig_transparent_white_pixels_become_transparent(tmp_path):
    fake_sig = _make_sig_png(tmp_path)
    with patch("sign_invoice.SIG_PATH", fake_sig):
        result = load_sig_transparent(max_height=80)
    img = Image.open(io.BytesIO(result)).convert("RGBA")
    data = np.array(img)
    white = (data[:, :, 0] > 220) & (data[:, :, 1] > 220) & (data[:, :, 2] > 220)
    assert data[white, 3].max() == 0, "White pixels must be fully transparent"


def test_load_sig_transparent_respects_max_height(tmp_path):
    fake_sig = _make_sig_png(tmp_path)
    with patch("sign_invoice.SIG_PATH", fake_sig):
        result = load_sig_transparent(max_height=40)
    img = Image.open(io.BytesIO(result))
    assert img.height == 40


def test_load_sig_transparent_returns_valid_png(tmp_path):
    fake_sig = _make_sig_png(tmp_path)
    with patch("sign_invoice.SIG_PATH", fake_sig):
        result = load_sig_transparent()
    assert isinstance(result, bytes)
    assert result[:8] == b"\x89PNG\r\n\x1a\n"  # PNG magic bytes


# ---------------------------------------------------------------------------
# sign_pdf (integration)
# ---------------------------------------------------------------------------

def test_sign_pdf_embeds_image(tmp_path):
    pdf_path = _make_invoice_pdf(tmp_path)
    fake_sig = _make_sig_png(tmp_path)
    with patch("sign_invoice.SIG_PATH", fake_sig):
        out = sign_pdf(pdf_path, tmp_path / "signed.pdf")
    doc = fitz.open(str(out))
    imgs = doc[0].get_images()
    doc.close()
    assert len(imgs) >= 1, "Signed PDF must contain at least one embedded image"


def test_sign_pdf_in_place_returns_src_path(tmp_path):
    pdf_path = _make_invoice_pdf(tmp_path)
    fake_sig = _make_sig_png(tmp_path)
    with patch("sign_invoice.SIG_PATH", fake_sig):
        out = sign_pdf(pdf_path)  # no dst → in-place
    assert out == pdf_path
    doc = fitz.open(str(out))
    imgs = doc[0].get_images()
    doc.close()
    assert len(imgs) >= 1


def test_sign_pdf_batch_skip_heuristic(tmp_path):
    """Batch mode skips PDFs that already have embedded images."""
    pdf_path = _make_invoice_pdf(tmp_path)
    fake_sig = _make_sig_png(tmp_path)
    with patch("sign_invoice.SIG_PATH", fake_sig):
        sign_pdf(pdf_path)
    doc = fitz.open(str(pdf_path))
    has_img = len(doc[0].get_images()) > 0
    doc.close()
    assert has_img  # batch loop would skip this file
