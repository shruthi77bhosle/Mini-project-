# Review Summarizer (Chrome Extension + Python Flask Backend)

A small Chrome extension that scrapes reviews visible on any product page (Amazon/Flipkart/others) and sends them to a Python backend which uses an AI (Gemini if provided) or a local fallback to compute:
- Pros (list), Cons (list)
- Overall sentiment and one-line conclusion

## What you get in this repo
- `extension/` — Chrome extension (HTML/CSS/JS). Popup UI is polished and responsive.
- `backend/` — Flask app that accepts reviews and returns a structured summary.

## Prerequisites
- Python 3.8+
- Chrome (or Chromium-based browser)
- pip

## Backend setup
1. Create and activate a virtual environment (recommended):
   ```bash
   python -m venv venv
   source venv/bin/activate    # Linux/macOS
   venv\Scripts\activate     # Windows