/**
 * app.js — Main application logic for Sihhati (صحتي)
 * Offline medical reference PWA
 * Based on kiwix-js PWA pattern, adapted for JSON-based content
 * Uses shared verify-hash.js from T1 scaffold for content integrity
 */

'use strict';

// Import shared hash verification utility
import VerifyHash from './verify-hash.js';

// State management
const state = {
  config: null,
  articles: [],
  fuseIndex: null,       // general search index (all articles)
  drugFuseIndex: null,   // drug-only search index
  currentView: 'home',
  currentCategory: null,
  currentArticle: null
};

// DOM helpers
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

// ---- Init ----
async function init() {
  // Register Service Worker
  if ('serviceWorker' in navigator) {
    try {
      const reg = await navigator.serviceWorker.register('service-worker.js', { scope: './' });
      console.log('SW registered:', reg.scope);
    } catch (err) {
      console.warn('SW registration failed:', err);
    }
  }

  // Load content-config.json
  try {
    const resp = await fetch('content-config.json');
    state.config = await resp.json();
    updateVersionIndicator();
  } catch (err) {
    console.error('Failed to load config:', err);
    showError('فشل تحميل التكوين. تأكد من توفر الملفات.');
    return;
  }

  // Load all content
  await loadAllContent();

  // Build search indexes
  buildSearchIndex();
  buildDrugSearchIndex();

  // Render UI
  renderCategoryNav();
  renderHome();

  // Wire up events
  bindEvents();
}

function updateVersionIndicator() {
  const el = $('#content-version');
  if (el && state.config) {
    el.textContent = 'v' + state.config.version;
  }
}

// ---- Content loading ----
async function loadAllContent() {
  const sources = state.config.contentSources || [];
  for (const source of sources) {
    try {
      const resp = await fetch(source.path);
      const articles = await resp.json();
      articles.forEach(a => a.source = source.id);
      state.articles = state.articles.concat(articles);
    } catch (err) {
      console.warn('Failed to load', source.path, err);
    }
  }
}

// ---- Hash verification using shared verify-hash.js ----
async function verifyHash(article) {
  if (!article.hash || article.hash.length !== 64) {
    showHashWarning('تنبيه: لم يتم التحقق من سلامة المحتوى (لا يوجد رمز)');
    return false;
  }
  try {
    const ok = await VerifyHash.verify(article.content, article.hash);
    if (!ok) {
      showHashWarning('تنبيه: المحتوى لا يطابق الرمز الأصلي! قد يكون تم تعديله.');
      return false;
    }
    return true;
  } catch (err) {
    console.warn('Hash verification error:', err);
    showHashWarning('تنبيه: تعذر التحقق من سلامة المحتوى.');
    return false;
  }
}

function showHashWarning(msg) {
  let warn = $('.hash-warning');
  if (warn) warn.remove();
  warn = document.createElement('div');
  warn.className = 'hash-warning';
  warn.textContent = msg;
  $('#article-content').prepend(warn);
}

// ---- Search via Fuse.js ----
function buildSearchIndex() {
  const options = {
    includeScore: true,
    includeMatches: true,
    threshold: 0.3,
    keys: [
      { name: 'title', weight: 0.5 },
      { name: 'titleEn', weight: 0.3 },
      { name: 'content', weight: 0.2 }
    ]
  };
  state.fuseIndex = new Fuse(state.articles, options);
}

// ---- Drug-only search index ----
function buildDrugSearchIndex() {
  const drugs = state.articles.filter(a => a.type === 'drug');
  const options = {
    includeScore: true,
    includeMatches: true,
    threshold: 0.4,
    keys: [
      { name: 'title', weight: 0.4 },      // Arabic name
      { name: 'titleEn', weight: 0.4 },     // English name
      { name: 'content', weight: 0.2 }
    ]
  };
  state.drugFuseIndex = new Fuse(drugs, options);
}

function searchArticles(query) {
  if (!query || query.trim().length === 0) return [];
  return state.fuseIndex.search(query.trim());
}

function searchDrugs(query) {
  if (!query || query.trim().length === 0) return [];
  return state.drugFuseIndex.search(query.trim());
}

// ---- Views ----
function showView(viewId) {
  $$('.view').forEach(v => v.classList.remove('active'));
  $('#' + viewId).classList.add('active');
  state.currentView = viewId;
}

function renderHome() {
  const grid = $('#category-grid');
  grid.innerHTML = '';
  
  const categories = state.config.categories || [];
  categories.forEach(cat => {
    const count = state.articles.filter(a => a.category === cat.id).length;
    const card = document.createElement('div');
    card.className = 'category-card';
    card.dataset.categoryId = cat.id;
    card.innerHTML = `
      <span class="icon">${cat.icon || '📄'}</span>
      <span class="label">${cat.labelAr || cat.label}</span>
      <span class="count">${count} عنصر</span>
    `;
    if (cat.id === 'drugs') {
      card.addEventListener('click', () => openDrugLookup());
    } else {
      card.addEventListener('click', () => openCategory(cat.id));
    }
    grid.appendChild(card);
  });
}

function renderCategoryNav() {
  const nav = $('#category-nav');
  const existing = nav.querySelectorAll('.category-btn:not([data-category="all"])');
  existing.forEach(b => b.remove());
  
  (state.config.categories || []).forEach(cat => {
    const btn = document.createElement('button');
    btn.className = 'category-btn';
    btn.dataset.category = cat.id;
    btn.textContent = cat.labelAr || cat.label;
    btn.addEventListener('click', () => {
      if (cat.id === 'drugs') {
        openDrugLookup();
      } else {
        openCategory(cat.id);
      }
    });
    nav.appendChild(btn);
  });
}

function openCategory(catId) {
  state.currentCategory = catId;
  const articles = state.articles.filter(a => a.category === catId);
  const cat = state.config.categories.find(c => c.id === catId);
  
  $('#article-list-title').textContent = cat ? (cat.labelAr || cat.label) : catId;
  const listEl = $('#article-list');
  listEl.innerHTML = '';
  
  if (articles.length === 0) {
    listEl.innerHTML = '<p class="loading">لا توجد مقالات في هذه الفئة</p>';
  } else {
    articles.forEach(article => {
      const item = document.createElement('div');
      item.className = 'article-item';
      const snippet = stripMarkdown(article.content).substring(0, 80) + '...';
      item.innerHTML = `<h3>${article.title}</h3><div class="snippet">${snippet}</div>`;
      item.addEventListener('click', () => openArticle(article));
      listEl.appendChild(item);
    });
  }
  
  showView('article-list-view');
  
  $$('.category-btn').forEach(b => b.classList.remove('active'));
  $$(`.category-btn[data-category="${catId}"]`).forEach(b => b.classList.add('active'));
}

// ---- Drug lookup ----
function openDrugLookup() {
  showView('drug-lookup-view');
  $$('.category-btn').forEach(b => b.classList.remove('active'));
  $$('.category-btn[data-category="drugs"]').forEach(b => b.classList.add('active'));

  // Show all drugs initially
  renderDrugResults('');

  // Focus the search input
  setTimeout(() => $('#drug-search-input').focus(), 100);
}

function renderDrugResults(query) {
  const resultsEl = $('#drug-results');
  resultsEl.innerHTML = '';

  let results;
  if (query.trim().length === 0) {
    // Show all drugs
    results = state.articles.filter(a => a.type === 'drug').map(item => ({ item }));
  } else {
    results = searchDrugs(query);
  }

  if (results.length === 0) {
    resultsEl.innerHTML = '<p class="loading">لا توجد نتائج</p>';
    return;
  }

  results.forEach(result => {
    const drug = result.item;
    const item = document.createElement('div');
    item.className = 'drug-result-item';

    // Extract dosage snippet from content
    const dosageMatch = drug.content.match(/## الجرعات\s*\n([^\n#]+)/);
    const dosageSnippet = dosageMatch ? dosageMatch[1].substring(0, 80) + '...' : '';

    item.innerHTML = `
      <div class="drug-name-ar">${drug.title}</div>
      <div class="drug-name-en">${drug.titleEn}</div>
      ${dosageSnippet ? `<div class="drug-dosage">${dosageSnippet}</div>` : ''}
    `;
    item.addEventListener('click', () => openArticle(drug));
    resultsEl.appendChild(item);
  });
}

// ---- Article reader ----
async function openArticle(article) {
  state.currentArticle = article;
  const contentEl = $('#article-content');
  
  // Render markdown with marked.js
  if (typeof marked !== 'undefined') {
    contentEl.innerHTML = marked.parse(article.content);
  } else {
    contentEl.textContent = article.content;
  }
  
  // Display last_reviewed date and reviewer
  $('#meta-reviewed').textContent = 'تاريخ المراجعة: ' + (article.lastReviewed || 'غير معروف');
  $('#meta-reviewer').textContent = 'المُراجع: ' + (article.reviewer || 'غير معروف');
  
  // Set RTL direction
  contentEl.setAttribute('dir', 'rtl');
  
  showView('reader-view');
  
  // Verify content hash
  await verifyHash(article);
}

function showSearchResults(query) {
  const results = searchArticles(query);
  const resultsEl = $('#search-results');
  resultsEl.innerHTML = '';
  
  if (results.length === 0) {
    resultsEl.innerHTML = '<p class="loading">لا توجد نتائج</p>';
  } else {
    results.forEach(result => {
      const article = result.item;
      const item = document.createElement('div');
      item.className = 'search-result-item';
      
      let snippet = article.content.substring(0, 100) + '...';
      if (result.matches) {
        result.matches.forEach(m => {
          if (m.key === 'content') {
            const idx = article.content.toLowerCase().indexOf(query.toLowerCase());
            if (idx >= 0) {
              const start = Math.max(0, idx - 30);
              snippet = '...' + article.content.substring(start, start + 120) + '...';
            }
          }
        });
      }
      
      const typeLabel = article.type === 'drug' ? '💊 ' : '';
      item.innerHTML = `<h3>${typeLabel}${article.title}</h3><div class="snippet">${stripMarkdown(snippet)}</div>`;
      item.addEventListener('click', () => openArticle(article));
      resultsEl.appendChild(item);
    });
  }
  
  showView('search-view');
}

// ---- Bluetooth export/import ----
async function exportContent() {
  const statusEl = $('#export-status');
  try {
    const response = await fetch('data/medical-content.json.gz');
    if (!response.ok) throw new Error('file not found');
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'sihati-medical-content.json.gz';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    statusEl.textContent = 'تم تصدير المحتوى بنجاح. يمكنك مشاركته عبر البلوتوث.';
    statusEl.className = 'status-success';
  } catch (err) {
    console.error('Export failed:', err);
    statusEl.textContent = 'فشل التصدير: ' + err.message;
    statusEl.className = 'status-error';
  }
}

async function importContent(file) {
  const statusEl = $('#import-status');
  try {
    statusEl.textContent = 'جاري الاستيراد...';
    statusEl.className = 'status-progress';

    let jsonText;
    if (file.name.endsWith('.gz') || file.name.endsWith('.json.gz')) {
      // Decompress gzip
      const arrayBuffer = await file.arrayBuffer();
      const ds = new DecompressionStream('gzip');
      const decompressed = new Response(arrayBuffer.slice(0).stream().pipeThrough(ds));
      jsonText = await decompressed.text();
    } else {
      jsonText = await file.text();
    }

    const importedArticles = JSON.parse(jsonText);

    if (!Array.isArray(importedArticles) || importedArticles.length === 0) {
      throw new Error('ملف غير صالح أو فارغ');
    }

    // Verify hashes of imported content
    let verified = 0;
    let failed = 0;
    for (const article of importedArticles) {
      if (article.hash && article.hash.length === 64) {
        const ok = await VerifyHash.verify(article.content, article.hash);
        if (ok) verified++;
        else failed++;
      }
    }

    // Replace or merge content
    state.articles = importedArticles;
    buildSearchIndex();
    buildDrugSearchIndex();
    renderHome();

    statusEl.textContent = `تم استيراد ${importedArticles.length} عنصر. تم التحقق من ${verified} عنصر.${failed > 0 ? ' ' + failed + ' عنصر فشل التحقق.' : ''}`;
    statusEl.className = failed > 0 ? 'status-warning' : 'status-success';

  } catch (err) {
    console.error('Import failed:', err);
    statusEl.textContent = 'فشل الاستيراد: ' + err.message;
    statusEl.className = 'status-error';
  }
}

// ---- Utilities ----
function stripMarkdown(md) {
  return md
    .replace(/^#+\s+/gm, '')
    .replace(/\*\*/g, '')
    .replace(/\*/g, '')
    .replace(/`/g, '')
    .replace(/\[(.*?)\]\(.*?\)/g, '$1')
    .replace(/^>\s+/gm, '')
    .replace(/\|/g, ' ')
    .replace(/[-_]/g, ' ')
    .replace(/^\s*--\s*$/gm, '')
    .trim();
}

function showError(msg) {
  const err = document.createElement('div');
  err.className = 'hash-warning';
  err.textContent = msg;
  $('#main-content').prepend(err);
}

// ---- Event bindings ----
function bindEvents() {
  // Search input
  const searchInput = $('#search-input');
  let searchTimeout;
  searchInput.addEventListener('input', (e) => {
    clearTimeout(searchTimeout);
    const query = e.target.value;
    if (query.trim().length >= 2) {
      searchTimeout = setTimeout(() => showSearchResults(query), 300);
    } else if (query.trim().length === 0) {
      renderHome();
      showView('home-view');
    }
  });
  
  $('#search-btn').addEventListener('click', () => {
    const query = $('#search-input').value;
    if (query.trim().length >= 1) showSearchResults(query);
  });
  
  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const query = e.target.value;
      if (query.trim().length >= 1) showSearchResults(query);
    }
  });

  // Drug search input
  const drugSearchInput = $('#drug-search-input');
  let drugSearchTimeout;
  drugSearchInput.addEventListener('input', (e) => {
    clearTimeout(drugSearchTimeout);
    const query = e.target.value;
    drugSearchTimeout = setTimeout(() => renderDrugResults(query), 200);
  });
  
  // Back buttons
  $$('.back-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      if (state.currentView === 'search-view') {
        searchInput.value = '';
        renderHome();
        showView('home-view');
      } else if (state.currentView === 'reader-view') {
        if (state.currentCategory) {
          openCategory(state.currentCategory);
        } else if (state.currentView === 'drug-lookup-view') {
          openDrugLookup();
        } else {
          renderHome();
          showView('home-view');
        }
      } else {
        renderHome();
        showView('home-view');
      }
      
      $$('.category-btn').forEach(b => b.classList.remove('active'));
      $('.category-btn[data-category="all"]').classList.add('active');
    });
  });
  
  // "All" category button
  $('.category-btn[data-category="all"]').addEventListener('click', () => {
    renderHome();
    showView('home-view');
    $$('.category-btn').forEach(b => b.classList.remove('active'));
    $('.category-btn[data-category="all"]').classList.add('active');
  });

  // Share/export/import
  $('#share-btn').addEventListener('click', () => {
    showView('share-view');
    $$('.category-btn').forEach(b => b.classList.remove('active'));
  });

  $('#export-btn').addEventListener('click', exportContent);

  $('#import-btn').addEventListener('click', () => {
    $('#import-file').click();
  });

  $('#import-file').addEventListener('change', (e) => {
    if (e.target.files.length > 0) {
      importContent(e.target.files[0]);
    }
  });
}

// ---- Boot ----
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
