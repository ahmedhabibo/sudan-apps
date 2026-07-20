/**
 * app.js — Derasa offline education pack PWA
 * Reuses kiwix-fork SW caching pattern + shared scaffold IndexedDB concepts.
 *
 * Features:
 *   - Pack system: subject+level → manifest → download → store in IndexedDB
 *   - Lesson reader: markdown rendering with Arabic RTL
 *   - Quiz engine: multiple choice, instant feedback, Arabic explanations
 *   - Progress tracking: completed lessons + quiz scores in IndexedDB
 *   - Progress sync queue: POST to backend when online
 *   - Pack download as .json.gz + import-from-file for Bluetooth share
 */

'use strict';

// ── State ────────────────────────────────────────────────────────────
const state = {
  config: null,
  selectedSubject: null,
  selectedLevel: null,
  currentManifest: null,
  currentPack: null,       // full downloaded pack (all lessons)
  currentLesson: null,
  quizState: { qIndex: 0, score: 0, answers: [] },
};

// ── IndexedDB (Dexie-free, raw IDB for zero external deps) ────────────
const DB_NAME = 'DerasaDB';
const DB_VERSION = 1;
let _db = null;

function openDB() {
  if (_db) return Promise.resolve(_db);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('packs')) {
        db.createObjectStore('packs', { keyPath: 'packId' });
      }
      if (!db.objectStoreNames.contains('progress')) {
        const store = db.createObjectStore('progress', { keyPath: 'progressId' });
        store.createIndex('packId', 'packId', { unique: false });
      }
      if (!db.objectStoreNames.contains('syncQueue')) {
        db.createObjectStore('syncQueue', { keyPath: 'id', autoIncrement: true });
      }
    };
    req.onsuccess = (e) => { _db = e.target.result; resolve(_db); };
    req.onerror = (e) => reject(e.target.error);
  });
}

async function dbPut(storeName, value) {
  const db = await openDB();
  return new Promise((res, rej) => {
    const tx = db.transaction(storeName, 'readwrite');
    tx.objectStore(storeName).put(value);
    tx.oncomplete = () => res(true);
    tx.onerror = () => rej(tx.error);
  });
}

async function dbGet(storeName, key) {
  const db = await openDB();
  return new Promise((res, rej) => {
    const tx = db.transaction(storeName, 'readonly');
    const req = tx.objectStore(storeName).get(key);
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });
}

async function dbGetAll(storeName) {
  const db = await openDB();
  return new Promise((res, rej) => {
    const tx = db.transaction(storeName, 'readonly');
    const req = tx.objectStore(storeName).getAll();
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });
}

async function dbGetByIndex(storeName, indexName, value) {
  const db = await openDB();
  return new Promise((res, rej) => {
    const tx = db.transaction(storeName, 'readonly');
    const req = tx.objectStore(storeName).index(indexName).getAll(value);
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });
}

async function dbDelete(storeName, key) {
  const db = await openDB();
  return new Promise((res, rej) => {
    const tx = db.transaction(storeName, 'readwrite');
    tx.objectStore(storeName).delete(key);
    tx.oncomplete = () => res(true);
    tx.onerror = () => rej(tx.error);
  });
}

// ── DOM helpers ──────────────────────────────────────────────────────
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

// ── Init ──────────────────────────────────────────────────────────────
async function init() {
  if ('serviceWorker' in navigator) {
    try {
      await navigator.serviceWorker.register('../service-worker.js', { scope: '../' });
      console.log('SW registered');
    } catch (err) {
      console.warn('SW registration failed:', err);
    }
  }

  try {
    const resp = await fetch('content-config.json');
    state.config = await resp.json();
    $('#content-version').textContent = 'v' + state.config.version;
  } catch (err) {
    console.error('Failed to load config:', err);
    return;
  }

  renderSubjectButtons();
  renderLevelButtons();
  bindEvents();
  showView('home');
  renderHomePacks();
  updateSyncStatus();
}

// ── Navigation ───────────────────────────────────────────────────────
function showView(viewName) {
  $$('.view').forEach(v => v.classList.remove('active'));
  $$('.nav-btn').forEach(b => b.classList.remove('active'));
  const view = $('#' + viewName + '-view');
  if (view) view.classList.add('active');
  const navBtn = $(`.nav-btn[data-view="${viewName}"]`);
  if (navBtn) navBtn.classList.add('active');
}

// ── Pack system: selectors ────────────────────────────────────────────
function renderSubjectButtons() {
  const container = $('#subject-buttons');
  container.innerHTML = '';
  (state.config.subjects || []).forEach(subj => {
    const btn = document.createElement('button');
    btn.className = 'select-btn';
    btn.dataset.id = subj.id;
    btn.innerHTML = `${subj.icon} ${subj.labelAr}`;
    btn.addEventListener('click', () => selectSubject(subj.id));
    container.appendChild(btn);
  });
}

function renderLevelButtons() {
  const container = $('#level-buttons');
  container.innerHTML = '';
  (state.config.levels || []).forEach(lvl => {
    const btn = document.createElement('button');
    btn.className = 'select-btn';
    btn.dataset.id = lvl.id;
    btn.textContent = lvl.labelAr;
    btn.addEventListener('click', () => selectLevel(lvl.id));
    container.appendChild(btn);
  });
}

function selectSubject(id) {
  state.selectedSubject = id;
  $$('#subject-buttons .select-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.id === id));
  checkAndLoadManifest();
}

function selectLevel(id) {
  state.selectedLevel = id;
  $$('#level-buttons .select-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.id === id));
  checkAndLoadManifest();
}

function checkAndLoadManifest() {
  if (state.selectedSubject && state.selectedLevel) {
    loadManifest(state.selectedSubject, state.selectedLevel);
  }
}

async function loadManifest(subject, level) {
  const packId = `${subject}-${level}`;
  const packsDir = state.config.packsDir || 'data/education/';
  const manifestPath = `${packsDir}${packId}-manifest.json`;

  try {
    const resp = await fetch(manifestPath);
    if (!resp.ok) {
      $('#pack-manifest').style.display = 'none';
      $('#pack-download-status').textContent = 'لا تتوفر حزمة لهذا الاختيار بعد.';
      return;
    }
    state.currentManifest = await resp.json();
    renderManifest();
  } catch (err) {
    $('#pack-manifest').style.display = 'none';
    $('#pack-download-status').textContent = 'تعذّر تحميل قائمة الحزمة.';
  }
}

function renderManifest() {
  const m = state.currentManifest;
  $('#manifest-title').textContent = m.title;

  const lessonsEl = $('#manifest-lessons');
  lessonsEl.innerHTML = '';
  (m.lessons || []).forEach((lesson, i) => {
    const item = document.createElement('div');
    item.className = 'lesson-item';
    item.innerHTML = `<span class="lesson-num">${i + 1}</span> <span>${lesson.title}</span>`;
    lessonsEl.appendChild(item);
  });

  $('#pack-manifest').style.display = 'block';
  $('#pack-download-status').textContent = '';
}

// ── Pack download ────────────────────────────────────────────────────
async function downloadPack() {
  if (!state.currentManifest) return;
  const packId = state.currentManifest.packId;
  const packsDir = state.config.packsDir || 'data/education/';
  const packPath = `${packsDir}${packId}.json`;

  $('#pack-download-status').textContent = 'جاري التحميل...';

  try {
    const resp = await fetch(packPath);
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    const packData = await resp.json();

    // Store in IndexedDB
    await dbPut('packs', packData);
    state.currentPack = packData;

    $('#pack-download-status').textContent = '✓ تم تحميل الحزمة بنجاح!';
    renderHomePacks();
  } catch (err) {
    $('#pack-download-status').textContent = 'فشل التحميل: ' + err.message;
  }
}

// ── Pack import from file (Bluetooth) ─────────────────────────────────
async function importPackFromFile(file) {
  $('#import-status').textContent = 'جاري الاستيراد...';

  try {
    let jsonText;
    if (file.name.endsWith('.gz')) {
      // Decompress gzip
      const arrayBuffer = await file.arrayBuffer();
      const ds = new DecompressionStream('gzip');
      const decompressed = new Response(new Blob([arrayBuffer]).stream().pipeThrough(ds));
      jsonText = await decompressed.text();
    } else {
      jsonText = await file.text();
    }

    const packData = JSON.parse(jsonText);
    if (!packData.packId || !packData.lessons) {
      throw new Error('ملف غير صالح: بنية الحزمة غير صحيحة');
    }

    await dbPut('packs', packData);
    $('#import-status').textContent = `✓ تم استيراد الحزمة: ${packData.title || packData.packId}`;
    renderHomePacks();
  } catch (err) {
    $('#import-status').textContent = 'فشل الاستيراد: ' + err.message;
  }
}

// ── Pack export for Bluetooth sharing ──────────────────────────────────
async function exportPackToFile() {
  const packs = await dbGetAll('packs');
  if (!packs || packs.length === 0) {
    $('#export-status').textContent = 'لا توجد حزم محمّلة للتصدير.';
    return;
  }

  // If only one pack, export it; if multiple, export the first one
  // (future: show a pack picker)
  const pack = packs[0];
  const packJson = JSON.stringify(pack);
  const packId = pack.packId || 'pack';

  try {
    // Compress with gzip using CompressionStream
    const blob = new Blob([packJson], { type: 'application/json' });
    const cs = new CompressionStream('gzip');
    const compressedStream = blob.stream().pipeThrough(cs);
    const compressedBlob = new Response(compressedStream).blob();
    const compressedArrayBuffer = await (await compressedBlob).arrayBuffer();

    // Create download link
    const url = URL.createObjectURL(new Blob([compressedArrayBuffer], { type: 'application/gzip' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `${packId}.json.gz`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    const sizeKB = (compressedArrayBuffer.byteLength / 1024).toFixed(1);
    $('#export-status').textContent = `✓ تم تصدير ${packId}.json.gz (${sizeKB}KB) — شاركه عبر Bluetooth`;
  } catch (err) {
    $('#export-status').textContent = 'فشل التصدير: ' + err.message;
  }
}

// ── Home: downloaded packs overview ──────────────────────────────────
async function renderHomePacks() {
  const packs = await dbGetAll('packs');
  const grid = $('#packs-grid');
  const emptyState = $('#home-empty');

  if (!packs || packs.length === 0) {
    grid.innerHTML = '';
    emptyState.style.display = 'block';
    return;
  }

  emptyState.style.display = 'none';
  grid.innerHTML = '';

  for (const pack of packs) {
    // Get progress for this pack
    const progress = await dbGetByIndex('progress', 'packId', pack.packId);
    const completedLessons = progress.filter(p => p.type === 'lesson').length;
    const quizScores = progress.filter(p => p.type === 'quiz');
    const avgScore = quizScores.length > 0
      ? Math.round(quizScores.reduce((s, p) => s + p.score, 0) / quizScores.length)
      : 0;

    const card = document.createElement('div');
    card.className = 'pack-card';
    card.innerHTML = `
      <h3>${pack.title || pack.packId}</h3>
      <div class="pack-stats">
        <span>📚 ${pack.lessons.length} دروس</span>
        <span>✓ ${completedLessons}/${pack.lessons.length} مكتملة</span>
        ${avgScore > 0 ? `<span>📝 متوسط ${avgScore}%</span>` : ''}
      </div>
    `;
    card.addEventListener('click', () => openPack(pack));
    grid.appendChild(card);
  }
}

// ── Open a downloaded pack → lesson list ──────────────────────────────
async function openPack(pack) {
  state.currentPack = pack;
  $('#lesson-list-title').textContent = pack.title || pack.packId;

  const listEl = $('#lesson-list');
  listEl.innerHTML = '';

  const progress = await dbGetByIndex('progress', 'packId', pack.packId);
  const completedSet = new Set(progress.filter(p => p.type === 'lesson').map(p => p.lessonId));

  (pack.lessons || []).forEach((lesson, i) => {
    const item = document.createElement('div');
    const isDone = completedSet.has(lesson.id);
    item.className = 'lesson-item' + (isDone ? ' completed' : '');
    item.innerHTML = `
      <span class="lesson-num">${i + 1}</span>
      <span class="lesson-title">${lesson.title}</span>
      ${isDone ? '<span class="done-badge">✓</span>' : ''}
    `;
    item.addEventListener('click', () => openLesson(lesson));
    listEl.appendChild(item);
  });

  showView('lesson-list');
}

// ── Lesson reader ─────────────────────────────────────────────────────
function openLesson(lesson) {
  state.currentLesson = lesson;
  $('#lesson-title').textContent = lesson.title;

  const contentEl = $('#lesson-content');
  if (typeof marked !== 'undefined') {
    contentEl.innerHTML = marked.parse(lesson.content);
  } else {
    contentEl.textContent = lesson.content;
  }

  showView('reader');
  updateProgressBar();
}

async function markLessonComplete() {
  if (!state.currentLesson || !state.currentPack) return;

  const progressId = `${state.currentPack.packId}:${state.currentLesson.id}:lesson`;
  await dbPut('progress', {
    progressId,
    packId: state.currentPack.packId,
    lessonId: state.currentLesson.id,
    type: 'lesson',
    completedAt: Date.now(),
    synced: false,
  });

  // Enqueue sync
  await enqueueSync(progressId);

  $('#mark-complete-btn').textContent = '✓ تم الإكمال';
  setTimeout(() => {
    $('#mark-complete-btn').textContent = '✓ إكمال الدرس';
  }, 1500);
}

function startQuiz() {
  if (!state.currentLesson || !state.currentLesson.quiz) {
    alert('لا يوجد اختبار لهذا الدرس');
    return;
  }

  state.quizState = { qIndex: 0, score: 0, answers: [] };
  $('#quiz-title').textContent = `اختبار: ${state.currentLesson.title}`;
  $('#quiz-result').style.display = 'none';
  $('#quiz-finish-btn').style.display = 'none';
  $('#quiz-next-btn').style.display = 'none';
  renderQuizQuestion();
  showView('quiz');
}

function renderQuizQuestion() {
  const quiz = state.currentLesson.quiz;
  const questions = quiz.questions;
  const qi = state.quizState.qIndex;
  const q = questions[qi];

  $('#quiz-progress').textContent = `سؤال ${qi + 1} من ${questions.length}`;
  $('#quiz-next-btn').style.display = 'none';

  const contentEl = $('#quiz-content');
  contentEl.innerHTML = '';

  const questionEl = document.createElement('div');
  questionEl.className = 'quiz-question';
  questionEl.innerHTML = `<h3>${q.question}</h3>`;

  const optionsEl = document.createElement('div');
  optionsEl.className = 'quiz-options';

  q.options.forEach((opt, i) => {
    const btn = document.createElement('button');
    btn.className = 'quiz-option';
    btn.innerHTML = `<span class="opt-letter">${['أ', 'ب', 'ج', 'د'][i]}</span> ${opt}`;
    btn.addEventListener('click', () => answerQuizQuestion(i, q));
    optionsEl.appendChild(btn);
  });

  questionEl.appendChild(optionsEl);
  contentEl.appendChild(questionEl);
}

function answerQuizQuestion(selectedIndex, q) {
  const isCorrect = selectedIndex === q.correctIndex;

  // Disable all options, highlight correct/wrong
  $$('.quiz-option').forEach((btn, i) => {
    btn.disabled = true;
    if (i === q.correctIndex) {
      btn.classList.add('correct');
    } else if (i === selectedIndex && !isCorrect) {
      btn.classList.add('wrong');
    }
  });

  // Feedback + explanation
  const feedback = document.createElement('div');
  feedback.className = 'quiz-feedback ' + (isCorrect ? 'correct' : 'wrong');
  feedback.innerHTML = `
    <p class="feedback-result">${isCorrect ? '✓ إجابة صحيحة!' : '✗ إجابة خاطئة'}</p>
    <p class="feedback-explanation">${q.explanation}</p>
  `;
  $('#quiz-content').appendChild(feedback);

  if (isCorrect) state.quizState.score++;

  state.quizState.answers.push({
    questionId: q.id,
    selectedIndex,
    correct: isCorrect,
  });

  // Show next button or finish button
  const quiz = state.currentLesson.quiz;
  if (state.quizState.qIndex < quiz.questions.length - 1) {
    $('#quiz-next-btn').style.display = 'block';
  } else {
    $('#quiz-finish-btn').style.display = 'block';
  }
}

function nextQuizQuestion() {
  state.quizState.qIndex++;
  renderQuizQuestion();
}

async function finishQuiz() {
  const quiz = state.currentLesson.quiz;
  const total = quiz.questions.length;
  const score = state.quizState.score;
  const percentage = Math.round((score / total) * 100);

  $('#quiz-finish-btn').style.display = 'none';
  $('#quiz-next-btn').style.display = 'none';
  $('#quiz-progress').textContent = '';

  const resultEl = $('#quiz-result');
  resultEl.style.display = 'block';
  resultEl.innerHTML = `
    <h3>نتيجة الاختبار</h3>
    <div class="quiz-score ${percentage >= 50 ? 'pass' : 'fail'}">
      ${score} / ${total} (${percentage}%)
    </div>
    <p>${percentage >= 50 ? 'أحسنت! لقد نجحت.' : 'تحتاج إلى مراجعة الدرس مرة أخرى.'}</p>
  `;

  // Store quiz score in IndexedDB
  if (state.currentPack && state.currentLesson) {
    const progressId = `${state.currentPack.packId}:${state.currentLesson.id}:quiz`;
    await dbPut('progress', {
      progressId,
      packId: state.currentPack.packId,
      lessonId: state.currentLesson.id,
      type: 'quiz',
      score: percentage,
      correctCount: score,
      totalCount: total,
      completedAt: Date.now(),
      synced: false,
    });

    await enqueueSync(progressId);
  }
}

// ── Progress view ────────────────────────────────────────────────────
async function renderProgress() {
  const allProgress = await dbGetAll('progress');

  const summaryEl = $('#progress-summary');
  const listEl = $('#progress-list');

  if (!allProgress || allProgress.length === 0) {
    summaryEl.innerHTML = '<p class="empty-state">لا يوجد تقدم مسجل بعد.</p>';
    listEl.innerHTML = '';
    return;
  }

  const lessonsDone = allProgress.filter(p => p.type === 'lesson').length;
  const quizzesDone = allProgress.filter(p => p.type === 'quiz');
  const avgScore = quizzesDone.length > 0
    ? Math.round(quizzesDone.reduce((s, p) => s + p.score, 0) / quizzesDone.length)
    : 0;

  summaryEl.innerHTML = `
    <div class="progress-summary-grid">
      <div class="progress-card"><span class="big">${lessonsDone}</span> دروس مكتملة</div>
      <div class="progress-card"><span class="big">${quizzesDone.length}</span> اختبارات</div>
      <div class="progress-card"><span class="big">${avgScore}%</span> متوسط الدرجات</div>
    </div>
  `;

  listEl.innerHTML = '<h3>التفاصيل</h3>';
  allProgress.sort((a, b) => (b.completedAt || 0) - (a.completedAt || 0));
  allProgress.forEach(p => {
    const item = document.createElement('div');
    item.className = 'progress-item';
    const date = new Date(p.completedAt || 0).toLocaleDateString('ar');
    if (p.type === 'lesson') {
      item.innerHTML = `📚 ${p.lessonId} <span class="muted">${date}</span> ${p.synced ? '✓ مُزامن' : '⏳ بانتظار المزامنة'}`;
    } else {
      item.innerHTML = `📝 ${p.lessonId} <span class="score-badge">${p.score}%</span> <span class="muted">${date}</span> ${p.synced ? '✓ مُزامن' : '⏳ بانتظار المزامنة'}`;
    }
    listEl.appendChild(item);
  });
}

// ── Sync queue ────────────────────────────────────────────────────────
async function enqueueSync(progressId) {
  const db = await openDB();
  return new Promise((res, rej) => {
    const tx = db.transaction('syncQueue', 'readwrite');
    tx.objectStore('syncQueue').add({
      progressId,
      createdAt: Date.now(),
      status: 'pending',
    });
    tx.oncomplete = () => { updateSyncStatus(); res(true); };
    tx.onerror = () => rej(tx.error);
  });
}

async function updateSyncStatus() {
  const queue = await dbGetAll('syncQueue');
  const pending = queue.filter(q => q.status === 'pending');
  const online = navigator.onLine;

  const statusEl = $('#sync-status');
  if (pending.length === 0) {
    statusEl.innerHTML = '<p class="success">✓ كل التقدم مُزامن</p>';
  } else {
    statusEl.innerHTML = `<p>${pending.length} عنصر بانتظار المزامنة ${online ? '(متصل)' : '(غير متصل)'}</p>`;
  }

  // Render sync queue list
  const listEl = $('#sync-queue-list');
  listEl.innerHTML = '';
  if (pending.length > 0) {
    pending.forEach(item => {
      const el = document.createElement('div');
      el.className = 'progress-item';
      const date = new Date(item.createdAt || 0).toLocaleDateString('ar');
      el.innerHTML = `⏳ ${item.progressId} <span class="muted">${date}</span>`;
      listEl.appendChild(el);
    });
  }
}

async function syncNow() {
  const queue = await dbGetAll('syncQueue');
  const pending = queue.filter(q => q.status === 'pending');

  if (pending.length === 0) {
    $('#sync-status').innerHTML = '<p class="success">✓ لا يوجد شيء للمزامنة</p>';
    return;
  }

  if (!navigator.onLine) {
    $('#sync-status').innerHTML = '<p class="error">✗ غير متصل بالإنترنت. المزامنة غير ممكنة.</p>';
    return;
  }

  const backendUrl = state.config.backendUrl || 'http://localhost:8461';
  let synced = 0, failed = 0;

  for (const item of pending) {
    const progress = await dbGet('progress', item.progressId);
    if (!progress) continue;

    try {
      const resp = await fetch(`${backendUrl}/api/progress`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(progress),
      });

      if (resp.ok) {
        // Mark as synced in progress store
        progress.synced = true;
        await dbPut('progress', progress);

        // Remove from sync queue
        await dbDelete('syncQueue', item.id);
        synced++;
      } else {
        failed++;
      }
    } catch (err) {
      console.warn('Sync failed for', item.progressId, err);
      failed++;
    }
  }

  updateSyncStatus();
  renderProgress();
  $('#sync-status').innerHTML = `<p class="${failed === 0 ? 'success' : 'error'}">مُزامن: ${synced}، فشل: ${failed}</p>`;
}

// ── Aggregate dashboard view ─────────────────────────────────────────
async function renderDashboard() {
  const statusEl = $('#dashboard-status');
  const contentEl = $('#dashboard-content');

  if (!navigator.onLine) {
    statusEl.innerHTML = '<p class="error">✗ لوحة الإحصائيات تتطلب اتصالاً بالإنترنت.</p>';
    contentEl.innerHTML = '';
    return;
  }

  statusEl.innerHTML = '<p class="hint">جاري تحميل الإحصائيات...</p>';
  contentEl.innerHTML = '';

  const backendUrl = state.config.backendUrl || 'https://derasa-backend.vercel.app';

  try {
    // Fetch aggregate data
    const [aggResp, packsResp] = await Promise.all([
      fetch(`${backendUrl}/api/progress/aggregate`),
      fetch(`${backendUrl}/api/packs`)
    ]);

    if (!aggResp.ok || !packsResp.ok) {
      throw new Error('فشل تحميل البيانات');
    }

    const aggData = await aggResp.json();
    const packsData = await packsResp.json();

    statusEl.innerHTML = '';

    if (!aggData.aggregates || aggData.aggregates.length === 0) {
      contentEl.innerHTML = '<div class="empty-state"><p>لا توجد بيانات تقدم مُزامنة بعد.</p><p class="hint">سينشر التقدم تلقائياً عند المزامنة.</p></div>';
      return;
    }

    // Build lookup from packs catalog
    const packMap = {};
    (packsData.packs || []).forEach(p => {
      packMap[p.packId] = p;
    });

    // Render aggregate cards
    let html = '<div class="dashboard-grid">';

    // Total summary
    const totalLessons = aggData.aggregates.reduce((s, a) => s + a.lessonsCompleted, 0);
    const totalQuizzes = aggData.aggregates.reduce((s, a) => s + a.quizzesCompleted, 0);
    const allScores = aggData.aggregates.filter(a => a.avgQuizScore > 0);
    const overallAvg = allScores.length > 0
      ? Math.round(allScores.reduce((s, a) => s + a.avgQuizScore, 0) / allScores.length)
      : 0;

    html += `
      <div class="dashboard-summary">
        <div class="progress-card"><span class="big">${aggData.aggregates.length}</span> حزم نشطة</div>
        <div class="progress-card"><span class="big">${totalLessons}</span> دروس مكتملة</div>
        <div class="progress-card"><span class="big">${totalQuizzes}</span> اختبارات</div>
        <div class="progress-card"><span class="big">${overallAvg}%</span> متوسط الدرجات</div>
      </div>
    `;

    // Per-pack breakdown
    html += '<h3>تفاصيل الحزم</h3>';
    html += '<table class="dashboard-table">';

    // Table header — RTL
    html += '<thead><tr><th>الحزمة</th><th>دروس</th><th>اختبارات</th><th>المتوسط</th></tr></thead>';
    html += '<tbody>';

    aggData.aggregates.forEach(a => {
      const packInfo = packMap[a.packId] || {};
      const titleAr = packInfo.title || packInfo.titleEn || a.packId;
      html += `<tr>
        <td>${titleAr}</td>
        <td class="num">${a.lessonsCompleted}</td>
        <td class="num">${a.quizzesCompleted}</td>
        <td class="num">${a.avgQuizScore > 0 ? a.avgQuizScore + '%' : '—'}</td>
      </tr>`;
    });

    html += '</tbody></table>';

    // Last updated
    html += `<p class="hint" style="margin-top:1rem">آخر تحديث: ${new Date().toLocaleString('ar')}</p>`;

    html += '</div>';
    contentEl.innerHTML = html;

  } catch (err) {
    statusEl.innerHTML = `<p class="error">✗ تعذّر تحميل الإحصائيات: ${err.message}</p>`;
    contentEl.innerHTML = '';
  }
}

// ── Progress bar ──────────────────────────────────────────────────────
async function updateProgressBar() {
  if (!state.currentPack || !state.currentLesson) return;

  const allProgress = await dbGetByIndex('progress', 'packId', state.currentPack.packId);
  const totalLessons = state.currentPack.lessons.length;
  const completedLessons = allProgress.filter(p => p.type === 'lesson').length;
  const pct = Math.round((completedLessons / totalLessons) * 100);

  $('#lesson-progress-bar').innerHTML = `
    <div class="progress-bar-container">
      <div class="progress-bar-fill" style="width:${pct}%"></div>
      <span class="progress-bar-text">${completedLessons}/${totalLessons} (${pct}%)</span>
    </div>
  `;
}

// ── Event bindings ────────────────────────────────────────────────────
function bindEvents() {
  // Nav buttons
  $$('.nav-btn').forEach(btn => {
    btn.addEventListener('click', () => showView(btn.dataset.view));
  });

  // Back buttons
  $$('.back-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const target = btn.dataset.target;
      if (target === 'home') {
        renderHomePacks();
        showView('home');
      } else if (target === 'lesson-list') {
        if (state.currentPack) openPack(state.currentPack);
        else { renderHomePacks(); showView('home'); }
      } else if (target === 'reader') {
        showView('reader');
      }
    });
  });

  // Pack selectors
  $('#download-pack-btn').addEventListener('click', downloadPack);

  // Import from file
  $('#import-pack-btn').addEventListener('click', () => {
    $('#import-file-input').click();
  });
  $('#import-file-input').addEventListener('change', (e) => {
    if (e.target.files.length > 0) {
      importPackFromFile(e.target.files[0]);
    }
  });

  // Export pack for Bluetooth sharing
  $('#export-pack-btn').addEventListener('click', exportPackToFile);

  // Lesson actions
  $('#mark-complete-btn').addEventListener('click', markLessonComplete);
  $('#start-quiz-btn').addEventListener('click', startQuiz);

  // Quiz navigation
  $('#quiz-next-btn').addEventListener('click', nextQuizQuestion);
  $('#quiz-finish-btn').addEventListener('click', finishQuiz);

  // Progress view
  $$('.nav-btn[data-view="progress"]').forEach(btn => {
    btn.addEventListener('click', renderProgress);
  });

  // Sync
  $('#sync-now-btn').addEventListener('click', syncNow);
  $$('.nav-btn[data-view="sync"]').forEach(btn => {
    btn.addEventListener('click', updateSyncStatus);
  });

  // Dashboard
  $$('.nav-btn[data-view="dashboard"]').forEach(btn => {
    btn.addEventListener('click', renderDashboard);
  });

  // Online/offline events → auto-sync when back online
  window.addEventListener('online', () => {
    console.log('Back online — auto-syncing');
    syncNow();
  });
  window.addEventListener('offline', () => {
    updateSyncStatus();
  });
}

// ── Boot ─────────────────────────────────────────────────────────────
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
