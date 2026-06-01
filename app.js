'use strict';

const CATEGORIES = ['learn', 'research', 'try', 'create', 'buy', 'visit', 'read'];

const CAT_COLORS = {
  learn:    '#2563eb',
  research: '#7c3aed',
  try:      '#059669',
  create:   '#d97706',
  buy:      '#dc2626',
  visit:    '#ea580c',
  read:     '#0891b2',
};

const PRI_COLORS = {
  low:    '#059669',
  medium: '#d97706',
  high:   '#dc2626',
};

// ── State ──────────────────────────────────────────────────────────────────

const state = {
  items: [],
  view: 'inbox',          // inbox | recent | favorites | categories
  selectedCategory: null,
  selectedTag: null,
  searchQuery: '',
  editingId: null,
  formCategory: CATEGORIES[0],
  formPriority: 'medium',
};

// ── Persistence ────────────────────────────────────────────────────────────

function loadItems() {
  try {
    const raw = localStorage.getItem('interests_v1');
    if (raw) state.items = JSON.parse(raw);
  } catch { state.items = []; }
}

function saveItems() {
  localStorage.setItem('interests_v1', JSON.stringify(state.items));
}

// ── CRUD ───────────────────────────────────────────────────────────────────

function generateId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0;
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
  });
}

function createItem({ title, note, category, tags, priority }) {
  const item = {
    id: generateId(),
    title: title.trim(),
    note: note.trim(),
    category,
    tags,
    priority,
    favorited: false,
    created_at: new Date().toISOString(),
  };
  state.items.unshift(item);
  saveItems();
  return item;
}

function updateItem(id, fields) {
  const idx = state.items.findIndex(i => i.id === id);
  if (idx === -1) return;
  state.items[idx] = { ...state.items[idx], ...fields };
  saveItems();
}

function deleteItem(id) {
  state.items = state.items.filter(i => i.id !== id);
  saveItems();
}

function toggleFavorite(id) {
  const item = state.items.find(i => i.id === id);
  if (item) { item.favorited = !item.favorited; saveItems(); }
}

// ── Queries ────────────────────────────────────────────────────────────────

function getFilteredItems() {
  let list = state.items;

  if (state.view === 'favorites') {
    list = list.filter(i => i.favorited);
  } else if (state.view === 'recent') {
    const cutoff = Date.now() - 7 * 86_400_000;
    list = list.filter(i => new Date(i.created_at).getTime() > cutoff);
  } else if (state.view === 'categories' && state.selectedCategory) {
    list = list.filter(i => i.category === state.selectedCategory);
  }

  if (state.selectedTag) {
    list = list.filter(i => i.tags.includes(state.selectedTag));
  }

  if (state.searchQuery) {
    const q = state.searchQuery.toLowerCase();
    list = list.filter(i =>
      i.title.toLowerCase().includes(q) ||
      i.note.toLowerCase().includes(q) ||
      i.tags.some(t => t.toLowerCase().includes(q))
    );
  }

  return list;
}

function getNavCounts() {
  const cutoff = Date.now() - 7 * 86_400_000;
  return {
    inbox:     state.items.length,
    recent:    state.items.filter(i => new Date(i.created_at).getTime() > cutoff).length,
    favorites: state.items.filter(i => i.favorited).length,
  };
}

function getCategoryCounts() {
  const counts = Object.fromEntries(CATEGORIES.map(c => [c, 0]));
  for (const item of state.items) counts[item.category]++;
  return counts;
}

function getAllTags() {
  const map = new Map();
  for (const item of state.items)
    for (const tag of item.tags)
      map.set(tag, (map.get(tag) || 0) + 1);
  return [...map.entries()].sort((a, b) => b[1] - a[1]);
}

// ── Helpers ────────────────────────────────────────────────────────────────

function esc(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function relativeTime(iso) {
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60_000)        return 'just now';
  if (diff < 3_600_000)     return Math.floor(diff / 60_000) + 'm ago';
  if (diff < 86_400_000)    return Math.floor(diff / 3_600_000) + 'h ago';
  if (diff < 7 * 86_400_000) return Math.floor(diff / 86_400_000) + 'd ago';
  return new Date(iso).toLocaleDateString('en', { month: 'short', day: 'numeric' });
}

function parseTags(raw) {
  return raw.split(',').map(t => t.trim().toLowerCase()).filter(Boolean);
}

// ── Render: sidebar ────────────────────────────────────────────────────────

function renderSidebar() {
  const counts = getNavCounts();

  // Nav counts
  document.getElementById('count-inbox').textContent     = counts.inbox     || '';
  document.getElementById('count-recent').textContent    = counts.recent    || '';
  document.getElementById('count-favorites').textContent = counts.favorites || '';

  // Active nav item
  document.querySelectorAll('.nav-item[data-view]').forEach(el => {
    el.classList.toggle('active', el.dataset.view === state.view);
  });

  // Category nav
  const catCounts = getCategoryCounts();
  const catNav = document.getElementById('category-nav');
  catNav.innerHTML = CATEGORIES.map(cat => `
    <button class="nav-item ${state.view === 'categories' && state.selectedCategory === cat ? 'active' : ''}"
            data-cat="${cat}">
      <span class="cat-dot" style="background:${CAT_COLORS[cat]}"></span>
      ${cat}
      <span class="cat-count">${catCounts[cat] || ''}</span>
    </button>
  `).join('');

  catNav.querySelectorAll('[data-cat]').forEach(btn => {
    btn.addEventListener('click', () => {
      state.view = 'categories';
      state.selectedCategory = btn.dataset.cat;
      state.selectedTag = null;
      render();
    });
  });

  // Tag cloud
  const tagCloud = document.getElementById('tag-cloud');
  const tags = getAllTags();
  if (tags.length === 0) {
    tagCloud.innerHTML = '<span style="font-size:11px;color:var(--text-light);padding:2px 4px">No tags yet</span>';
  } else {
    tagCloud.innerHTML = tags.map(([tag]) => `
      <button class="tag-pill ${state.selectedTag === tag ? 'active' : ''}" data-tag="${esc(tag)}">#${esc(tag)}</button>
    `).join('');
    tagCloud.querySelectorAll('.tag-pill').forEach(pill => {
      pill.addEventListener('click', () => {
        state.selectedTag = state.selectedTag === pill.dataset.tag ? null : pill.dataset.tag;
        render();
      });
    });
  }
}

// ── Render: items ──────────────────────────────────────────────────────────

function viewLabel() {
  if (state.searchQuery)                                      return `"${state.searchQuery}"`;
  if (state.selectedTag)                                      return `#${state.selectedTag}`;
  if (state.view === 'inbox')                                 return 'Inbox';
  if (state.view === 'recent')                                return 'Recent';
  if (state.view === 'favorites')                             return 'Favorites';
  if (state.view === 'categories' && state.selectedCategory)  return state.selectedCategory[0].toUpperCase() + state.selectedCategory.slice(1);
  return 'Inbox';
}

function emptyMessage() {
  if (state.searchQuery)  return 'No matches found.';
  if (state.selectedTag)  return `No items tagged #${state.selectedTag}.`;
  if (state.view === 'favorites') return 'No favorites yet.';
  if (state.view === 'recent')    return 'Nothing added in the last 7 days.';
  if (state.view === 'categories' && state.selectedCategory)
    return `No "${state.selectedCategory}" interests yet.`;
  return 'Nothing here yet.';
}

function renderItems() {
  const items = getFilteredItems();
  const container = document.getElementById('items-container');
  const empty = document.getElementById('empty-state');

  document.getElementById('view-title').textContent = viewLabel();

  if (items.length === 0) {
    container.innerHTML = '';
    container.style.display = 'none';
    document.getElementById('empty-message').textContent = emptyMessage();
    empty.classList.remove('hidden');
    return;
  }

  container.style.display = 'flex';
  empty.classList.add('hidden');

  container.innerHTML = items.map(itemCardHTML).join('');

  container.querySelectorAll('.item-card').forEach(card => {
    const id = card.dataset.id;

    card.querySelector('.btn-fav').addEventListener('click', e => {
      e.stopPropagation();
      toggleFavorite(id);
      render();
    });

    card.querySelector('.btn-edit').addEventListener('click', e => {
      e.stopPropagation();
      openEditModal(id);
    });

    card.querySelector('.btn-delete').addEventListener('click', e => {
      e.stopPropagation();
      if (confirm('Delete this interest?')) {
        deleteItem(id);
        render();
      }
    });

    card.querySelectorAll('.item-tag').forEach(tagEl => {
      tagEl.addEventListener('click', e => {
        e.stopPropagation();
        state.selectedTag = tagEl.dataset.tag;
        render();
      });
    });

    card.querySelector('.item-cat-badge')?.addEventListener('click', e => {
      e.stopPropagation();
      state.view = 'categories';
      state.selectedCategory = card.dataset.category;
      state.selectedTag = null;
      render();
    });
  });
}

function itemCardHTML(item) {
  const color    = CAT_COLORS[item.category] || '#888';
  const priColor = PRI_COLORS[item.priority]  || '#888';
  const tags = item.tags.map(t =>
    `<span class="item-tag" data-tag="${esc(t)}">#${esc(t)}</span>`
  ).join('');
  const note = item.note
    ? `<div class="item-note">${esc(item.note)}</div>`
    : '';

  return `
    <div class="item-card" data-id="${esc(item.id)}" data-category="${esc(item.category)}">
      <div class="item-cat-bar" style="background:${color}"></div>
      <div class="item-pri-dot" style="background:${priColor}" title="Priority: ${item.priority}"></div>
      <div class="item-body">
        <div class="item-title">${esc(item.title)}</div>
        <div class="item-meta">
          <span class="item-cat-badge" style="background:${color}" title="Filter by ${item.category}">${item.category}</span>
          ${tags}
          <span class="item-date">${relativeTime(item.created_at)}</span>
        </div>
        ${note}
      </div>
      <div class="item-actions">
        <button class="item-action-btn btn-fav ${item.favorited ? 'favorited' : ''}"
                title="${item.favorited ? 'Remove from favorites' : 'Add to favorites'}">
          ${item.favorited ? '★' : '☆'}
        </button>
        <button class="item-action-btn btn-edit" title="Edit">✎</button>
        <button class="item-action-btn btn-delete" title="Delete">✕</button>
      </div>
    </div>`;
}

// ── Render: combined ───────────────────────────────────────────────────────

function render() {
  renderSidebar();
  renderItems();
}

// ── Modal: add / edit ──────────────────────────────────────────────────────

function openAddModal() {
  state.editingId    = null;
  state.formCategory = CATEGORIES[0];
  state.formPriority = 'medium';

  document.getElementById('modal-title').textContent = 'Add Interest';
  document.getElementById('form-title').value = '';
  document.getElementById('form-tags').value  = '';
  document.getElementById('form-note').value  = '';

  renderCategoryButtons();
  syncPriorityButtons();
  document.getElementById('modal-overlay').classList.remove('hidden');
  setTimeout(() => document.getElementById('form-title').focus(), 40);
}

function openEditModal(id) {
  const item = state.items.find(i => i.id === id);
  if (!item) return;

  state.editingId    = id;
  state.formCategory = item.category;
  state.formPriority = item.priority;

  document.getElementById('modal-title').textContent = 'Edit Interest';
  document.getElementById('form-title').value = item.title;
  document.getElementById('form-tags').value  = item.tags.join(', ');
  document.getElementById('form-note').value  = item.note;

  renderCategoryButtons();
  syncPriorityButtons();
  document.getElementById('modal-overlay').classList.remove('hidden');
  setTimeout(() => document.getElementById('form-title').focus(), 40);
}

function closeModal() {
  document.getElementById('modal-overlay').classList.add('hidden');
  state.editingId = null;
}

function renderCategoryButtons() {
  const el = document.getElementById('form-category');
  el.innerHTML = CATEGORIES.map(cat => `
    <button type="button" class="cat-btn ${state.formCategory === cat ? 'active' : ''}"
            data-cat="${cat}" style="--cat-color:${CAT_COLORS[cat]}">${cat}</button>
  `).join('');

  el.querySelectorAll('.cat-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      state.formCategory = btn.dataset.cat;
      renderCategoryButtons();
    });
  });
}

function syncPriorityButtons() {
  document.querySelectorAll('.priority-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.priority === state.formPriority);
  });
}

// ── Modal: random ──────────────────────────────────────────────────────────

function showRandom() {
  if (state.items.length === 0) return;
  const item  = state.items[Math.floor(Math.random() * state.items.length)];
  const color = CAT_COLORS[item.category];

  document.getElementById('random-content').innerHTML = `
    <div class="random-item" style="border-left:3px solid ${color}">
      <div class="random-cat-label" style="color:${color}">${item.category}</div>
      <div class="random-title">${esc(item.title)}</div>
      ${item.note ? `<div class="random-note">${esc(item.note)}</div>` : ''}
      ${item.tags.length ? `<div class="random-tags">${item.tags.map(t => `<span class="random-tag">#${esc(t)}</span>`).join('')}</div>` : ''}
    </div>`;

  document.getElementById('random-overlay').classList.remove('hidden');
}

function closeRandom() {
  document.getElementById('random-overlay').classList.add('hidden');
}

// ── Init ───────────────────────────────────────────────────────────────────

function init() {
  loadItems();

  // Sidebar view navigation
  document.querySelectorAll('.nav-item[data-view]').forEach(el => {
    el.addEventListener('click', () => {
      state.view = el.dataset.view;
      state.selectedCategory = null;
      state.selectedTag = null;
      render();
    });
  });

  // Add button
  document.getElementById('add-btn').addEventListener('click', openAddModal);

  // Random button
  document.getElementById('random-btn').addEventListener('click', showRandom);

  // Modal: close
  document.getElementById('modal-close').addEventListener('click', closeModal);
  document.getElementById('form-cancel').addEventListener('click', closeModal);
  document.getElementById('modal-overlay').addEventListener('click', e => {
    if (e.target === document.getElementById('modal-overlay')) closeModal();
  });

  // Random modal: close
  document.getElementById('random-close').addEventListener('click', closeRandom);
  document.getElementById('random-done').addEventListener('click', closeRandom);
  document.getElementById('random-again').addEventListener('click', showRandom);
  document.getElementById('random-overlay').addEventListener('click', e => {
    if (e.target === document.getElementById('random-overlay')) closeRandom();
  });

  // Priority buttons (bound once)
  document.querySelectorAll('.priority-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      state.formPriority = btn.dataset.priority;
      syncPriorityButtons();
    });
  });

  // Form submit
  document.getElementById('item-form').addEventListener('submit', e => {
    e.preventDefault();
    const title = document.getElementById('form-title').value.trim();
    if (!title) return;

    const data = {
      title,
      note:     document.getElementById('form-note').value,
      category: state.formCategory,
      tags:     parseTags(document.getElementById('form-tags').value),
      priority: state.formPriority,
    };

    if (state.editingId) {
      updateItem(state.editingId, data);
    } else {
      createItem(data);
    }

    closeModal();
    render();
  });

  // Search
  document.getElementById('search-input').addEventListener('input', e => {
    state.searchQuery = e.target.value.trim();
    render();
  });

  // Keyboard shortcuts
  document.addEventListener('keydown', e => {
    const tag = document.activeElement.tagName;
    const inInput = tag === 'INPUT' || tag === 'TEXTAREA';

    if (e.key === 'Escape') {
      closeModal();
      closeRandom();
    }

    if (!inInput && !e.ctrlKey && !e.metaKey) {
      if (e.key === 'n' || e.key === 'N') {
        e.preventDefault();
        openAddModal();
      }
      if (e.key === '/') {
        e.preventDefault();
        document.getElementById('search-input').focus();
      }
    }
  });

  render();
}

document.addEventListener('DOMContentLoaded', init);
