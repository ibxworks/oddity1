import os
import tempfile

from fastapi import FastAPI, File, UploadFile
from fastapi.responses import JSONResponse
from markitdown import MarkItDown

app = FastAPI()

ALLOWED_EXTENSIONS = {"pdf", "docx", "pptx", "txt", "md"}
MAX_FILE_SIZE = 10 * 1024 * 1024  # 10MB


@app.post("/api/convert")
async def convert(file: UploadFile = File(...)):
    # Validate extension
    ext = ""
    if file.filename and "." in file.filename:
        ext = file.filename.rsplit(".", 1)[1].lower()
    if ext not in ALLOWED_EXTENSIONS:
        return JSONResponse(
            content={"error": f"Unsupported file type: .{ext}"},
            status_code=400,
        )

    # Read and validate size
    data = await file.read()
    if len(data) > MAX_FILE_SIZE:
        return JSONResponse(
            content={"error": "File exceeds 10MB limit"},
            status_code=400,
        )

    tmp_path = None
    try:
        # Write to temp file with correct extension (markitdown uses it to pick converter)
        with tempfile.NamedTemporaryFile(delete=False, suffix=f".{ext}") as tmp:
            tmp.write(data)
            tmp_path = tmp.name

        result = MarkItDown().convert(tmp_path)
        return JSONResponse(content={"markdown": result.text_content})

    except Exception as e:
        return JSONResponse(
            content={"error": f"Conversion failed: {str(e)}"},
            status_code=500,
        )
    finally:
        if tmp_path and os.path.exists(tmp_path):
            os.remove(tmp_path)
