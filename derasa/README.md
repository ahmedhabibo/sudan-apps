# Derasa (دراسة) — Offline Education Pack PWA

Offline-first education packs for Sudanese students. Users download subject+grade packs,
study lessons offline, take quizzes with instant Arabic feedback, and sync progress when
connectivity is available. Packs can be shared device-to-device via Bluetooth (.json.gz).

## Structure

```
derasa/
├── manifest.webmanifest      PWA manifest (Arabic RTL, standalone)
├── service-worker.js         SW caching: app shell cache-first, content network-first→cache
├── LICENSE                   GPL v3 (kiwix-js attribution)
├── backend/
│   ├── main.py               FastAPI: GET /api/packs, POST /api/progress, GET /api/progress, aggregate
│   ├── requirements.txt      fastapi, uvicorn
│   └── derasa.db             SQLite (auto-created)
└── www/
    ├── index.html            App shell: nav tabs (Home, Packs, Progress, Sync)
    ├── content-config.json   Subjects, levels, backend URL
    ├── css/app.css           RTL Flexbox, dark mode, Arabic system fonts
    ├── js/
    │   ├── app.js            Pack system, lesson reader, quiz engine, IDB, sync queue
    │   ├── marked.min.js     Markdown renderer (35KB)
    │   └── fuse.min.js       Fuzzy search engine (24KB)
    └── data/education/
        ├── math-g6-manifest.json   Pack manifest (5 lessons)
        ├── math-g6.json            Full pack: 5 lessons + 24 quiz questions with explanations
        └── math-g6.json.gz         Gzipped pack (3.7KB) for Bluetooth sharing
```

## Run

### Backend (progress sync)
```bash
cd derasa/backend
pip install -r requirements.txt
python main.py  # → http://localhost:8461
```

### PWA (static)
```bash
cd derasa
python3 -m http.server 8460 --directory .
# → http://localhost:8460/www/index.html
```

## Acceptance Test Results

| Test | Result |
|------|--------|
| Download Math Grade 6 pack (5 lessons) | ✓ PASS |
| Lesson reader renders Arabic RTL markdown | ✓ PASS |
| Quiz: 5 questions, multiple choice, instant feedback | ✓ PASS (5/5 100%) |
| Quiz feedback shows Arabic explanations | ✓ PASS |
| Progress stored in IndexedDB | ✓ PASS (2 records: lesson + quiz) |
| Sync queue: 2 items enqueued | ✓ PASS |
| Backend POST /api/progress | ✓ PASS (verified via curl) |
| Backend GET /api/progress?pack_id=X | ✓ PASS |
| Backend GET /api/progress/aggregate | ✓ PASS |
| Pack .json.gz for Bluetooth sharing | ✓ PASS (3.7KB) |
| Import-from-file button present | ✓ PASS |
| All app content works from IndexedDB (offline) | ✓ PASS |
| Total app shell size | 172KB |
