"""
Derasa FastAPI backend — Vercel serverless entry point.
All /api/* routes are routed here by vercel.json.

Persistence: uses a JSON file in /tmp (survives warm invocations,
resets on cold start). For production, upgrade to Vercel KV/Postgres.
"""

import sys
import os

# Ensure the parent directory is on the path so we can import the app
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from main import app

# Vercel serverless handler
handler = app
