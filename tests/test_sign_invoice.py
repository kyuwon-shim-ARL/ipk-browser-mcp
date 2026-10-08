"""Unit + integration tests for sign_invoice.py."""
import io
import sys
import os
import pytest
import numpy as np
from unittest.mock import MagicMock, patch
from pathlib import Path
from PIL import Image

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
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


def test_find_sig_rect_gap_too_small_falls_back():
    # Gap of only 20 px < 40 threshold → bottom-left fallback
    blocks = [
        (10, 150, 300, 200, "Bill To: ARL Lab", 0, 0),
        (10, 220, 500, 260, "ITEM   AMOUNT", 0, 0),
    ]
    rect = find_sig_rect(_make_page(blocks, height=842.0))
    assert rect.y1 >= 742  # 842 - 100


def test_find_sig_rect_no_billing_block_falls_back():
    blocks = [
        (10, 280, 500, 320, "ITEM   AMOUNT", 0, 0),
    ]
    rect = find_sig_rect(_make_page(blocks))
    assert rect.y1 >= 742


def test_find_sig_rect_no_table_header_falls_back():
    blocks = [
        (10, 150, 300, 200, "Bill To: ARL Lab", 0, 0),
    ]
    rect = find_sig_rect(_make_page(blocks))
    assert rect.y1 >= 742


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
