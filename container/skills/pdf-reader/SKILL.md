# PDF Reader

Read text from PDF files using the `pdf-reader` CLI (powered by `pdftotext` from poppler-utils).

## When a PDF arrives via Telegram

The file is automatically saved to `/workspace/group/attachments/` and the message will say something like:

```
[PDF: /workspace/group/attachments/tg_doc_12345_report.pdf]
```

Extract the text:

```bash
pdf-reader /workspace/group/attachments/tg_doc_12345_report.pdf
```

## Commands

```bash
# Extract text from a local file
pdf-reader /workspace/group/attachments/document.pdf

# Fetch and extract a PDF from a URL
pdf-reader fetch https://example.com/report.pdf

# Show metadata (pages, title, author, creation date)
pdf-reader info /workspace/group/attachments/document.pdf
```

## Notes

- Only works on text-based PDFs. Scanned/image PDFs return empty output.
- For image-based PDFs, use the browser skill to open and view the PDF visually.
- Telegram's Bot API limits file downloads to 20 MB. PDFs larger than that cannot be downloaded automatically; ask the user to share a download link instead.
