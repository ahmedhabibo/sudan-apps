"""
FastAPI backend for Derasa — packs catalog + progress sync.

Endpoints:
  GET  /api/packs                     — list available packs
  GET  /api/packs/{pack_id}           — download a full pack (JSON)
  POST /api/progress                  — submit progress (lesson/quiz)
  GET  /api/progress?pack_id=X        — get progress for a pack
  GET  /api/progress/aggregate        — aggregate progress dashboard
  GET  /api/health                    — health check

Persistence: SQLite at /tmp/derasa.db (Vercel) or local derasa.db (dev).
Pack data: embedded as static JSON in the backend directory for Vercel.
"""

import sqlite3
import json
import os
from datetime import datetime
from pathlib import Path
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

# ── Setup ────────────────────────────────────────────────────────────
BACKEND_DIR = Path(__file__).parent

# Use /tmp on Vercel (serverless), local dir on dev
if os.environ.get("VERCEL"):
    DB_PATH = Path("/tmp/derasa.db")
    PACKS_DIR = BACKEND_DIR / "data" / "education"
else:
    DB_PATH = BACKEND_DIR / "derasa.db"
    PACKS_DIR = BACKEND_DIR.parent / "www" / "data" / "education"

app = FastAPI(title="Derasa Backend", version="1.0.0")

# CORS — allow the PWA from any origin
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["*"],
)

# ── SQLite schema ─────────────────────────────────────────────────────
def init_db():
    conn = sqlite3.connect(str(DB_PATH))
    conn.execute("""
        CREATE TABLE IF NOT EXISTS packs (
            pack_id     TEXT PRIMARY KEY,
            subject     TEXT NOT NULL,
            level       TEXT NOT NULL,
            title       TEXT,
            title_en    TEXT,
            version     TEXT DEFAULT '1.0.0',
            lessons     TEXT,
            created_at  TEXT DEFAULT (datetime('now'))
        )
    """)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS progress_records (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            progress_id     TEXT UNIQUE NOT NULL,
            pack_id         TEXT NOT NULL,
            lesson_id       TEXT,
            type            TEXT NOT NULL,
            score           INTEGER,
            correct_count   INTEGER,
            total_count     INTEGER,
            completed_at    INTEGER,
            synced_at       TEXT DEFAULT (datetime('now')),
            device_id       TEXT
        )
    """)
    conn.execute("CREATE INDEX IF NOT EXISTS idx_progress_pack ON progress_records(pack_id)")
    conn.commit()
    conn.close()

init_db()

# ── Pack catalog (auto-scan the education dir) ─────────────────────────
def scan_packs():
    packs = []
    if not PACKS_DIR.exists():
        return packs
    for f in sorted(PACKS_DIR.glob("*-manifest.json")):
        try:
            with open(f, encoding="utf-8") as fh:
                m = json.load(fh)
            packs.append({
                "packId": m["packId"],
                "subject": m["subject"],
                "subjectAr": m.get("subjectAr", ""),
                "level": m["level"],
                "levelAr": m.get("levelAr", ""),
                "title": m.get("title", m["packId"]),
                "titleEn": m.get("titleEn", ""),
                "version": m.get("version", "1.0.0"),
                "lessons": m.get("lessons", [])
            })
        except Exception as e:
            print(f"Error reading manifest {f}: {e}")
    return packs

def upsert_pack_catalog():
    packs = scan_packs()
    conn = sqlite3.connect(str(DB_PATH))
    for p in packs:
        conn.execute("""
            INSERT OR REPLACE INTO packs (pack_id, subject, level, title, title_en, version, lessons)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        """, (
            p["packId"], p["subject"], p["level"],
            p["title"], p["titleEn"], p["version"],
            json.dumps(p["lessons"], ensure_ascii=False)
        ))
    conn.commit()
    conn.close()
    return packs

upsert_pack_catalog()

# ── Pydantic models ───────────────────────────────────────────────────
class ProgressRecord(BaseModel):
    progressId: str
    packId: str
    lessonId: str | None = None
    type: str = "lesson"
    score: int | None = None
    correctCount: int | None = None
    totalCount: int | None = None
    completedAt: int | None = None
    synced: bool = False
    deviceId: str | None = None

# ── Endpoints ─────────────────────────────────────────────────────────
@app.get("/api/packs")
async def list_packs():
    conn = sqlite3.connect(str(DB_PATH))
    conn.row_factory = sqlite3.Row
    rows = conn.execute("SELECT * FROM packs ORDER BY subject, level").fetchall()
    conn.close()
    packs = []
    for r in rows:
        packs.append({
            "packId": r["pack_id"],
            "subject": r["subject"],
            "level": r["level"],
            "title": r["title"],
            "titleEn": r["title_en"],
            "version": r["version"],
            "lessons": json.loads(r["lessons"]) if r["lessons"] else []
        })
    return {"packs": packs, "count": len(packs)}

@app.get("/api/packs/{pack_id}")
async def get_pack(pack_id: str):
    pack_file = PACKS_DIR / f"{pack_id}.json"
    if not pack_file.exists():
        raise HTTPException(status_code=404, detail=f"Pack '{pack_id}' not found")
    with open(pack_file, encoding="utf-8") as f:
        return json.load(f)

@app.post("/api/progress")
async def submit_progress(record: ProgressRecord):
    conn = sqlite3.connect(str(DB_PATH))
    try:
        conn.execute("""
            INSERT OR REPLACE INTO progress_records
                (progress_id, pack_id, lesson_id, type, score, correct_count, total_count, completed_at, device_id)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (
            record.progressId, record.packId, record.lessonId,
            record.type, record.score, record.correctCount,
            record.totalCount, record.completedAt, record.deviceId
        ))
        conn.commit()
    finally:
        conn.close()
    return {"status": "ok", "progressId": record.progressId}

@app.get("/api/progress")
async def get_progress(pack_id: str = Query(None)):
    conn = sqlite3.connect(str(DB_PATH))
    conn.row_factory = sqlite3.Row
    if pack_id:
        rows = conn.execute(
            "SELECT * FROM progress_records WHERE pack_id = ? ORDER BY completed_at DESC",
            (pack_id,)
        ).fetchall()
    else:
        rows = conn.execute(
            "SELECT * FROM progress_records ORDER BY completed_at DESC"
        ).fetchall()
    conn.close()
    records = []
    for r in rows:
        records.append({
            "progressId": r["progress_id"],
            "packId": r["pack_id"],
            "lessonId": r["lesson_id"],
            "type": r["type"],
            "score": r["score"],
            "correctCount": r["correct_count"],
            "totalCount": r["total_count"],
            "completedAt": r["completed_at"],
            "syncedAt": r["synced_at"],
            "deviceId": r["device_id"]
        })
    return {"records": records, "count": len(records)}

@app.get("/api/progress/aggregate")
async def aggregate_progress():
    conn = sqlite3.connect(str(DB_PATH))
    conn.row_factory = sqlite3.Row
    rows = conn.execute("""
        SELECT
            pack_id,
            COUNT(CASE WHEN type='lesson' THEN 1 END) as lessons_completed,
            COUNT(CASE WHEN type='quiz' THEN 1 END) as quizzes_completed,
            AVG(CASE WHEN type='quiz' AND score IS NOT NULL THEN score END) as avg_quiz_score
        FROM progress_records
        GROUP BY pack_id
    """, ()).fetchall()
    conn.close()
    aggregates = []
    for r in rows:
        aggregates.append({
            "packId": r["pack_id"],
            "lessonsCompleted": r["lessons_completed"],
            "quizzesCompleted": r["quizzes_completed"],
            "avgQuizScore": round(r["avg_quiz_score"], 1) if r["avg_quiz_score"] else 0
        })
    return {"aggregates": aggregates, "count": len(aggregates)}

@app.get("/api/health")
async def health():
    return {"status": "ok", "service": "derasa-backend", "db": str(DB_PATH), "vercel": bool(os.environ.get("VERCEL"))}

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8461)
