/**
 * app.js - Main application logic for Sudan Reader
 * Based on kiwix-js PWA pattern, adapted for JSON-based content
 */

'use strict';

// State management
const state = {
  config: null,
  articles: [],           // all loaded articles
  fuseIndex: null,        // Fuse.js search index
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
      const reg = await navigator.serviceWorker.register('../service-worker.js', { scope: '../' });
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

  // Load all content sources
  await loadAllContent();

  // Build search index
  buildSearchIndex();

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
      // Tag each article with its source
      articles.forEach(a => a.source = source.id);
      state.articles = state.articles.concat(articles);
    } catch (err) {
      console.warn('Failed to load', source.path, err);
    }
  }
}

// ---- Hash verification ----
async function verifyHash(article) {
  // In production, this computes SHA-256 of content and compares to article.hash
  // For now, check if hash field exists and is non-empty
  if (!article.hash || !article.hash.startsWith('sha256:')) {
    showHashWarning('تنبيه: لم يتم التحقق من سلامة المحتوى (لا يوجد رمز)');
    return false;
  }
  // Compute actual hash for verification
  try {
    const encoder = new TextEncoder();
    const data = encoder.encode(article.content);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
    const expected = article.hash.replace('sha256:', '');
    if (hashHex.substring(0, expected.length) !== expected) {
      showHashWarning('تنبيه: المحتوى لا يطابق الرمز الأصلي! قد يكون تم تعديله.');
      return false;
    }
    return true;
  } catch (err) {
    console.warn('Hash verification skipped:', err);
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

function searchArticles(query) {
  if (!query || query.trim().length === 0) return [];
  return state.fuseIndex.search(query.trim());
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
      <span class="icon">${getCategoryIcon(cat.id)}</span>
      <span class="label">${cat.labelAr || cat.label}</span>
      <span class="count">${count} مقالة</span>
    `;
    card.addEventListener('click', () => openCategory(cat.id));
    grid.appendChild(card);
  });
}

function getCategoryIcon(catId) {
  const icons = {
    trauma: '🩹',
    malnutrition: '🍎',
    pregnancy: '🤰',
    infections: '🦠',
    drugs: '💊',
    firstaid: '🚑',
    education: '📚'
  };
  return icons[catId] || '📄';
}

function renderCategoryNav() {
  const nav = $('#category-nav');
  // Keep "all" button, add category buttons
  const existing = nav.querySelectorAll('.category-btn:not([data-category="all"])');
  existing.forEach(b => b.remove());
  
  (state.config.categories || []).forEach(cat => {
    const btn = document.createElement('button');
    btn.className = 'category-btn';
    btn.dataset.category = cat.id;
    btn.textContent = cat.labelAr || cat.label;
    btn.addEventListener('click', () => openCategory(cat.id));
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
  
  // Update active category button
  $$('.category-btn').forEach(b => b.classList.remove('active'));
  $$('.category-btn[data-category="' + catId + '"]').forEach(b => b.classList.add('active'));
}

async function openArticle(article) {
  state.currentArticle = article;
  const contentEl = $('#article-content');
  
  // Render markdown with marked.js
  if (typeof marked !== 'undefined') {
    contentEl.innerHTML = marked.parse(article.content);
  } else {
    // Fallback: basic rendering
    contentEl.textContent = article.content;
  }
  
  // Show article meta
  const metaEl = $('#article-meta');
  metaEl.innerHTML = `
    <div>تاريخ المراجعة: ${article.lastReviewed || 'غير معروف'}</div>
    <div>المُراجع: ${article.reviewer || 'غير معروف'}</div>
  `;
  
  // Set RTL direction
  contentEl.setAttribute('dir', 'rtl');
  
  showView('reader-view');
  
  // Verify content hash in background
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
      
      // Build snippet with highlighting
      let snippet = article.content.substring(0, 100) + '...';
      if (result.matches) {
        result.matches.forEach(m => {
          if (m.key === 'title' || m.key === 'titleEn') {
            // Already shown in title
          } else if (m.key === 'content') {
            // Find first match position for snippet
            const idx = article.content.toLowerCase().indexOf(query.toLowerCase());
            if (idx >= 0) {
              const start = Math.max(0, idx - 30);
              snippet = '...' + article.content.substring(start, start + 120) + '...';
            }
          }
        });
      }
      
      item.innerHTML = `<h3>${article.title}</h3><div class="snippet">${stripMarkdown(snippet)}</div>`;
      item.addEventListener('click', () => openArticle(article));
      resultsEl.appendChild(item);
    });
  }
  
  showView('search-view');
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
  
  // Enter key in search
  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const query = e.target.value;
      if (query.trim().length >= 1) showSearchResults(query);
    }
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
        } else {
          renderHome();
          showView('home-view');
        }
      } else {
        renderHome();
        showView('home-view');
      }
      
      // Reset category nav active state
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
}

// ---- Boot ----
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
