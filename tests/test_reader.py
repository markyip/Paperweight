#!/usr/bin/env python3
"""PDF / EPUB reader: ultrawide layout, EPUB parse, optional PDFium, signatures."""
from __future__ import annotations

import io
import os
import sys
import tempfile
import zipfile

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

FAILURES = []


def check(name, ok, detail=""):
    print(f"{'PASS' if ok else 'FAIL'}  {name}{('  ' + detail) if detail else ''}")
    if not ok:
        FAILURES.append(name)


def _minimal_epub_bytes() -> bytes:
    """EPUB 2 with a spine, NCX TOC, and a JPEG cover."""
    from PIL import Image

    buf = io.BytesIO()
    Image.new("RGB", (32, 48), (40, 80, 120)).save(buf, format="JPEG")
    cover = buf.getvalue()
    chapter = (
        "<?xml version='1.0' encoding='utf-8'?>"
        "<html xmlns='http://www.w3.org/1999/xhtml'>"
        "<head><title>One</title></head>"
        "<body><h1>Chapter One</h1><p>Hello EPUB.</p></body></html>"
    )
    ncx = """<?xml version='1.0' encoding='utf-8'?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <navMap>
    <navPoint id="np1">
      <navLabel><text>Chapter One</text></navLabel>
      <content src="OEBPS/ch1.xhtml"/>
    </navPoint>
  </navMap>
</ncx>
"""
    opf = """<?xml version='1.0' encoding='utf-8'?>
<package xmlns="http://www.idpf.org/2007/opf" unique-identifier="bid" version="2.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>Test Book</dc:title>
    <dc:creator>Test Author</dc:creator>
    <dc:language>en</dc:language>
    <meta name="cover" content="cover"/>
  </metadata>
  <manifest>
    <item id="ch1" href="ch1.xhtml" media-type="application/xhtml+xml"/>
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
    <item id="cover" href="cover.jpg" media-type="image/jpeg" properties="cover-image"/>
  </manifest>
  <spine toc="ncx">
    <itemref idref="ch1"/>
  </spine>
</package>
"""
    container = """<?xml version='1.0' encoding='utf-8'?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>
"""
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w") as zf:
        zf.writestr("mimetype", "application/epub+zip", compress_type=zipfile.ZIP_STORED)
        zf.writestr("META-INF/container.xml", container)
        zf.writestr("OEBPS/content.opf", opf)
        zf.writestr("OEBPS/toc.ncx", ncx)
        zf.writestr("OEBPS/ch1.xhtml", chapter)
        zf.writestr("OEBPS/cover.jpg", cover)
    return out.getvalue()


def main() -> int:
    from document_layout import (
        DEFAULT_PAGE_ASPECT,
        MAX_COLUMNS,
        clamp_zoom,
        fit_scale,
        next_spread_index,
        page_label,
        prev_spread_index,
        recommended_columns,
        resolve_columns,
        spread_pages,
        spread_start,
        zoom_in,
        zoom_out,
    )
    from document_types import (
        get_document_extensions,
        get_openable_extensions,
        is_document_file,
    )
    from pdf_backend import pdf_has_signatures

    check("pdf and epub are documents", is_document_file("a.PDF") and is_document_file("b.epub"))
    check("jpeg is not a document", not is_document_file("shot.ARW"))
    check("document ext list", get_document_extensions() == [".pdf", ".epub"])
    openable = get_openable_extensions()
    check("openable is pdf and epub", openable == [".pdf", ".epub"])

    # 32:9 ≈ 3.556; A4 portrait 0.707 → ~5 pages.
    ultra = recommended_columns(5120, 1440, DEFAULT_PAGE_ASPECT)
    wide = recommended_columns(2560, 1080, DEFAULT_PAGE_ASPECT)
    hd = recommended_columns(1920, 1080, DEFAULT_PAGE_ASPECT)
    check("32:9 recommends 5 pages", ultra == 5, f"got {ultra}")
    check("21:9 recommends 3 pages", wide == 3, f"got {wide}")
    check("16:9 recommends 2 pages", hd == 2, f"got {hd}")
    check("auto columns is 32:9 five", resolve_columns(0, 5120, 1440) == 5)
    check("explicit 4 wins over auto", resolve_columns(4, 5120, 1440) == 4)
    check("columns clamp 9→6", resolve_columns(9, 5120, 1440) == MAX_COLUMNS)

    check("spread start aligns", spread_start(7, 3) == 6)
    check("spread pages clip", spread_pages(6, 3, 8) == (6, 7))
    check("next spread", next_spread_index(0, 3, 10) == 3)
    check("prev spread floors at 0", prev_spread_index(1, 3) == 0)
    check("page label range", page_label((2, 3, 4), 20) == "3–5 of 20")
    check("zoom clamps", clamp_zoom(99) == 4.0 and clamp_zoom(0) == 0.4)
    check("zoom in/out move", zoom_in(1.0) > 1.0 and zoom_out(1.0) < 1.0)

    fit = fit_scale(3000, 1000, [(700, 1000), (700, 1000), (700, 1000)])
    check("fit scale is positive", fit > 0.2)

    with tempfile.NamedTemporaryFile(suffix=".pdf", delete=False) as fh:
        fh.write(b"%PDF-1.1\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n")
        unsigned_path = fh.name
    try:
        check("unsigned pdf has no signature badge", not pdf_has_signatures(unsigned_path))
    finally:
        os.unlink(unsigned_path)

    fake_signed = b"%PDF-1.4\n1 0 obj << /Type /Sig /Filter /Adobe.PPKLite >> endobj\n"
    with tempfile.NamedTemporaryFile(suffix=".pdf", delete=False) as fh:
        fh.write(fake_signed)
        signed_path = fh.name
    try:
        check("signature marker detected", pdf_has_signatures(signed_path))
    finally:
        os.unlink(signed_path)

    # EPUB
    from epub_backend import epub_cover_rgb, open_epub

    with tempfile.NamedTemporaryFile(suffix=".epub", delete=False) as fh:
        fh.write(_minimal_epub_bytes())
        epub_path = fh.name
    try:
        book = open_epub(epub_path)
        check("epub title", book.title == "Test Book")
        check("epub creator", book.creator == "Test Author")
        check("epub spine has chapter", len(book.spine) == 1 and "Hello EPUB" in book.spine[0].html)
        check("epub toc from ncx", any(e.title == "Chapter One" for e in book.toc))
        check("epub toc points at spine 0", book.toc[0].spine_index == 0)
        cover = epub_cover_rgb(epub_path, max_edge=64)
        check("epub cover rgb", cover is not None and cover.ndim == 3 and cover.shape[2] == 3)
        from document_cover import render_document_cover_rgb

        tile = render_document_cover_rgb(epub_path, max_edge=64)
        check("epub gallery cover", tile is not None and tile.shape[0] >= 32)
    finally:
        os.unlink(epub_path)

    # PDF via pypdfium2 when present.
    try:
        import pypdfium2 as pdfium
    except Exception:
        print("SKIP  pypdfium2 not installed — PDF raster tests skipped")
        pdfium = None
    if pdfium is not None:
        pdf_path = None
        try:
            doc = pdfium.PdfDocument.new()
            doc.new_page(612, 792)
            doc.new_page(612, 792)
            with tempfile.NamedTemporaryFile(suffix=".pdf", delete=False) as fh:
                pdf_path = fh.name
            doc.save(pdf_path)
            doc.close()
            from pdf_backend import open_pdf, render_pdf_cover_rgb

            handle = open_pdf(pdf_path)
            try:
                check("pdf page count", handle.page_count == 2, f"got {handle.page_count}")
                check("pdf page size portrait", handle.page_sizes[0][1] > handle.page_sizes[0][0])
            finally:
                handle.close()
            cover = render_pdf_cover_rgb(pdf_path, max_edge=128)
            check("pdf cover rgb", cover is not None and cover.ndim == 3)
        except Exception as exc:
            check("pdfium create/render", False, str(exc))
        finally:
            if pdf_path and os.path.isfile(pdf_path):
                os.unlink(pdf_path)

    if FAILURES:
        print(f"\n{len(FAILURES)} failed: {FAILURES}")
        return 1
    print("\nAll document-reader checks passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
