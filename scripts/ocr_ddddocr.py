"""
Long-lived OCR worker. Stays alive across many captcha solves so we pay the
~1-3s `import ddddocr` cost once instead of per-request.

Protocol (line-oriented, both directions):
  Stdin:  each request is a single line of JSON: {"id": "<reqId>", "img": "<base64>"}
  Stdout:
    On startup, once ddddocr is loaded, emit: __BZXZ_OCR_READY__
    For each request, emit one line: {"id": "<reqId>", "text": "<result>"}

Reading line-by-line and using compact JSON avoids the heavy stdin.read()
pattern of the old per-invocation script.
"""
import sys
import json
import base64
import traceback

sys.stdin.reconfigure(encoding='utf-8')
sys.stdout.reconfigure(encoding='utf-8')


def emit(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def main():
    try:
        import ddddocr
    except Exception as e:
        sys.stderr.write(f"[ocr-worker] failed to import ddddocr: {e}\n")
        sys.stderr.flush()
        sys.exit(2)

    ocr = ddddocr.DdddOcr(show_ad=False)
    sys.stdout.write("__BZXZ_OCR_READY__\n")
    sys.stdout.flush()

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
            req_id = req.get("id", "")
            img_b64 = req.get("img", "")
            if not img_b64:
                emit({"id": req_id, "text": ""})
                continue
            try:
                image_bytes = base64.b64decode(img_b64)
            except Exception:
                emit({"id": req_id, "text": "", "error": "bad_base64"})
                continue
            try:
                text = ocr.classification(image_bytes) or ""
            except Exception as e:
                emit({"id": req_id, "text": "", "error": f"ocr_failed:{e}"})
                continue
            emit({"id": req_id, "text": text.strip()})
        except Exception as e:
            # Never let one bad input crash the worker.
            sys.stderr.write(f"[ocr-worker] line handler error: {e}\n{traceback.format_exc()}\n")
            sys.stderr.flush()


if __name__ == '__main__':
    main()
