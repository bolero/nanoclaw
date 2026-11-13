#!/usr/bin/env python3
"""Linux stand-in for the macOS `doctext` helper used by scripts/google-broker.ts.

Same contract: `doctext <file> [--page N] [--ocr]` prints one JSON line
{kind, page, page_count, method, text, error?}. `page` is 1-based.
PDFs use the text layer (pdftotext) and fall back to OCR (pdftoppm + tesseract)
when the page has no usable text or --ocr is given. Images are OCRed directly;
HEIC is converted with heif-convert first.

Needs: poppler-utils, tesseract-ocr, libheif-examples (apt).
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile

MAX_BYTES = 25 * 1024 * 1024
MIN_TEXT_CHARS = 20
IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".heic", ".tiff", ".tif"}


def out(kind, page, page_count, method, text, error=None):
    obj = {"kind": kind, "page": page, "page_count": page_count, "method": method, "text": text}
    if error:
        obj["error"] = error
    print(json.dumps(obj))
    sys.exit(0)


def run(cmd, timeout=80):
    return subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)


def ocr_image(path):
    r = run(["tesseract", path, "stdout", "--psm", "3"])
    return r.stdout.strip() if r.returncode == 0 else None


def main(argv):
    args = argv[1:]
    if not args:
        out("unknown", 0, 0, "none", "", "missing, empty or larger than 25 MB")
    path = args[0]
    page = 1
    force_ocr = "--ocr" in args
    if "--page" in args:
        try:
            page = max(1, int(args[args.index("--page") + 1]))
        except (IndexError, ValueError):
            page = 1
    if not os.path.isfile(path) or os.path.getsize(path) == 0 or os.path.getsize(path) > MAX_BYTES:
        out("unknown", 0, 0, "none", "", "missing, empty or larger than 25 MB")

    ext = os.path.splitext(path)[1].lower()
    with open(path, "rb") as f:
        head = f.read(5)

    tmp = tempfile.mkdtemp(prefix="doctext-")
    try:
        if head == b"%PDF-":
            info = run(["pdfinfo", path])
            count = 0
            for line in info.stdout.splitlines():
                if line.startswith("Pages:"):
                    count = int(line.split()[1])
            if count == 0:
                out("pdf", 0, 0, "none", "", "could not read the PDF")
            if page > count:
                out("pdf", page, count, "none", "", f"page {page} is past the last page ({count})")
            if not force_ocr:
                t = run(["pdftotext", "-layout", "-f", str(page), "-l", str(page), path, "-"])
                text = t.stdout.strip()
                if t.returncode == 0 and len(text) >= MIN_TEXT_CHARS:
                    out("pdf", page, count, "text", text)
            prefix = os.path.join(tmp, "p")
            r = run(["pdftoppm", "-r", "300", "-png", "-f", str(page), "-l", str(page), "-singlefile", path, prefix])
            if r.returncode != 0:
                out("pdf", page, count, "none", "", "could not render the page for OCR")
            text = ocr_image(prefix + ".png")
            if text is None:
                out("pdf", page, count, "none", "", "OCR failed")
            out("pdf", page, count, "ocr", text)

        if ext in IMAGE_EXTS:
            src = path
            if ext == ".heic":
                src = os.path.join(tmp, "img.png")
                if run(["heif-convert", path, src]).returncode != 0:
                    out("image", 1, 1, "none", "", "could not convert HEIC")
            text = ocr_image(src)
            if text is None:
                out("image", 1, 1, "none", "", "OCR failed")
            out("image", 1, 1, "ocr", text)

        out("unknown", 0, 0, "none", "", "not a pdf or supported image")
    except subprocess.TimeoutExpired:
        out("unknown", page, 0, "none", "", "text extraction timed out")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    main(sys.argv)
