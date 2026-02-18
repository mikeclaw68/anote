import { invoke } from '@tauri-apps/api/core';
import { save } from '@tauri-apps/plugin-dialog';
import { icons } from './icons.js';
import { state, DataLayer, loadTheme, saveTheme, generateId, formatDate, escapeHtml, rebuildIndexes } from './state.js';
import { createEditor, destroyEditor, focusEditor, getEditorView, updateFindHighlights } from './editor.js';
import { TextSelection } from '@milkdown/prose/state';

// Track which note the editor is currently showing
let currentEditorNoteId = null;
// Track whether we need a full rebuild (layout changed) vs partial update
let currentFolderId = null;
const MAX_COMMAND_RESULTS = 80;

// Dirty flags — when set, render() updates only the flagged sections.
// When all are false, render() updates everything (default for backwards compat).
const dirty = { sidebar: false, notesHeader: false, notesList: false };
function markAllDirty() { dirty.sidebar = true; dirty.notesHeader = true; dirty.notesList = true; }
function clearDirty() { dirty.sidebar = false; dirty.notesHeader = false; dirty.notesList = false; }
function isDirtySet() { return dirty.sidebar || dirty.notesHeader || dirty.notesList; }

function getChildFolders(parentId) {
  return state.data.folders.filter(f => f.parentId === parentId);
}

function hasChildren(folderId) {
  return state.data.folders.some(f => f.parentId === folderId);
}

function toggleFolderExpanded(folderId) {
  if (state.expandedFolders.has(folderId)) {
    state.expandedFolders.delete(folderId);
  } else {
    state.expandedFolders.add(folderId);
  }
  dirty.sidebar = true;
  render();
}

function renderFolderTree(parentId, depth) {
  const { activeFolderId, editingFolderId, expandedFolders } = state;
  const children = getChildFolders(parentId);
  
  return children.map(folder => {
    const count = state.notesCountByFolder.get(folder.id) || 0;
    const isEditing = editingFolderId === folder.id;
    const isActive = activeFolderId === folder.id;
    const hasKids = hasChildren(folder.id);
    const isExpanded = expandedFolders.has(folder.id);
    const indent = depth * 16;
    
    let html = `
      <li class="folder-item ${isActive ? 'active' : ''}" style="padding-left: ${indent}px"
          onclick="selectFolder('${folder.id}')"
          oncontextmenu="showFolderContextMenu(event, '${folder.id}')">
        ${hasKids ? `
          <span class="folder-chevron ${isExpanded ? 'expanded' : ''}" 
                onclick="event.stopPropagation(); toggleFolderExpanded('${folder.id}')">
            ${icons.chevron}
          </span>
        ` : '<span class="folder-chevron-spacer"></span>'}
        <div class="folder-icon">${icons.folder}</div>
        ${isEditing ? `
          <input class="folder-name-input"
                 type="text"
                 value="${escapeHtml(folder.name)}"
                 onclick="event.stopPropagation()"
                 onblur="finishEditingFolder('${folder.id}', this.value)"
                 onkeydown="handleFolderKeydown(event, '${folder.id}', this.value)"
                 id="folder-edit-${folder.id}" />
        ` : `
          <span class="folder-name">${escapeHtml(folder.name)}</span>
        `}
        <span class="folder-count">${count}</span>
        <div class="folder-actions">
          <button class="folder-action-btn folder-menu-btn" onclick="event.stopPropagation(); toggleFolderMenu('${folder.id}')" title="More">
            ${icons.dots}
          </button>
        </div>
        <div class="folder-menu" id="folder-menu-${folder.id}">
          <div class="folder-menu-item" onclick="event.stopPropagation(); addFolder('${folder.id}'); closeFolderMenus()">
            ${icons.plus}
            <span>Add subfolder</span>
          </div>
          <div class="folder-menu-item" onclick="event.stopPropagation(); startEditingFolder('${folder.id}'); closeFolderMenus()">
            ${icons.edit}
            <span>Rename</span>
          </div>
          <div class="folder-menu-item danger" onclick="event.stopPropagation(); deleteFolder('${folder.id}'); closeFolderMenus()">
            ${icons.trash}
            <span>Delete</span>
          </div>
        </div>
      </li>
    `;
    
    if (hasKids && isExpanded) {
      html += renderFolderTree(folder.id, depth + 1);
    }
    
    return html;
  }).join('');
}

const strippedPreviewCache = new Map();
const SAFE_ID_RE = /^[A-Za-z0-9]+$/;

function stripMarkdown(md) {
  return md
    .replace(/^#{1,6}\s+/gm, '')                    // headings
    .replace(/(\*{1,2}|_{1,2}|~~)(.+?)\1/g, '$2')   // bold, italic, strikethrough
    .replace(/`(.+?)`/g, '$1')                       // inline code
    .replace(/^>\s+/gm, '')                           // blockquotes
    .replace(/^(?:[-*+]|\d+\.|- \[[ x]\])\s+/gm, '') // all list types
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')          // links
    .replace(/^---+$/gm, '')                          // horizontal rules
    .replace(/\|/g, ' ')                              // table pipes
    .replace(/\n+/g, ' ')                             // collapse newlines
    .trim();
}

function getStrippedPreview(raw) {
  if (!raw) return '';
  let result = strippedPreviewCache.get(raw);
  if (result !== undefined) return result;
  if (strippedPreviewCache.size >= 2000) strippedPreviewCache.clear();
  result = stripMarkdown(raw);
  strippedPreviewCache.set(raw, result);
  return result;
}

function isSafeId(value) {
  return typeof value === 'string' && SAFE_ID_RE.test(value);
}

function isMacPlatform() {
  return /mac|iphone|ipad|ipod/i.test(navigator.platform || navigator.userAgent || '');
}

function getShortcutLabel() {
  return isMacPlatform() ? 'Cmd+K' : 'Ctrl+K';
}

function getShortcutHint() {
  return isMacPlatform() ? '⌘K' : 'Ctrl K';
}

function getCommandResults() {
  const query = state.commandQuery.trim().toLowerCase();
  const results = state.data.notes
    .map((note) => {
      const folder = state.foldersById.get(note.folderId);
      const folderName = folder ? folder.name : 'Untitled folder';
      const title = note.title || 'Untitled';
      const preview = getStrippedPreview(note.preview || '') || 'Empty note';
      const titleMatch = title.toLowerCase().includes(query);
      const previewMatch = preview.toLowerCase().includes(query);
      const folderMatch = folderName.toLowerCase().includes(query);
      const matches = !query || titleMatch || previewMatch || folderMatch;
      const matchBucket = !query
        ? 0
        : titleMatch
          ? 0
          : previewMatch
            ? 1
            : 2;

      return {
        noteId: note.id,
        folderId: note.folderId,
        title,
        preview,
        folderName,
        updatedAt: note.updatedAt,
        matchBucket,
        matches,
      };
    })
    .filter(result => result.matches)
    .sort((a, b) => (a.matchBucket - b.matchBucket) || (b.updatedAt - a.updatedAt));

  return results.slice(0, MAX_COMMAND_RESULTS);
}

let ftsSearchTimeout = null;
let cachedFtsResults = null;

function ftsResultToCommand(n) {
  const folder = state.foldersById.get(n.folder_id);
  return {
    noteId: n.id,
    folderId: n.folder_id,
    title: n.title || 'Untitled',
    preview: getStrippedPreview(n.preview || '') || 'Empty note',
    folderName: folder ? folder.name : 'Untitled folder',
    updatedAt: n.updated_at,
  };
}

function getFolderNameMatches(query, excludedIds = new Set()) {
  const normalizedQuery = query.toLowerCase();
  const matches = [];
  for (const note of state.data.notes) {
    if (excludedIds.has(note.id)) continue;
    const folder = state.foldersById.get(note.folderId);
    const folderName = folder ? folder.name : 'Untitled folder';
    if (!folderName.toLowerCase().includes(normalizedQuery)) continue;
    matches.push({
      noteId: note.id,
      folderId: note.folderId,
      title: note.title || 'Untitled',
      preview: getStrippedPreview(note.preview || '') || 'Empty note',
      folderName,
      updatedAt: note.updatedAt,
    });
  }
  // Keep local folder-name matches ordered like other command results.
  matches.sort((a, b) => b.updatedAt - a.updatedAt);
  return matches;
}

function triggerFtsSearch(query) {
  if (ftsSearchTimeout) clearTimeout(ftsSearchTimeout);
  ftsSearchTimeout = setTimeout(async () => {
    ftsSearchTimeout = null;
    try {
      const raw = await invoke('search_notes', { query });
      // Guard: user may have changed query or closed palette during await
      if (!state.commandPaletteOpen || state.commandQuery.trim() !== query) return;
      cachedFtsResults = raw.map(ftsResultToCommand);
    } catch {
      // FTS query syntax error (e.g. unmatched quotes) — fall back to JS search
      cachedFtsResults = null;
    }
    state.commandSelectedIndex = 0;
    updateCommandResultsUI({ ensureActiveVisible: true });
  }, 150);
}

function focusCommandPaletteInput() {
  const input = document.getElementById('command-palette-input');
  if (!input) return;
  input.focus();
  const caret = input.value.length;
  input.setSelectionRange(caret, caret);
}

function normalizeCommandSelection(results) {
  if (results.length === 0) {
    state.commandSelectedIndex = 0;
    return;
  }
  if (state.commandSelectedIndex >= results.length || state.commandSelectedIndex < 0) {
    state.commandSelectedIndex = 0;
  }
}

function renderCommandResultsMarkup(results) {
  if (results.length === 0) return '<div class="command-palette-empty">No matching notes</div>';
  return results.map((result, index) => `
    <button
      class="command-result-item ${index === state.commandSelectedIndex ? 'active' : ''}"
      data-command-index="${index}"
      onclick="selectCommandResult(${index})">
      <div class="command-result-text">
        <div class="command-result-title">${escapeHtml(result.title)}</div>
        <div class="command-result-preview">${escapeHtml(result.preview.slice(0, 120))}</div>
      </div>
      <div class="command-result-meta">
        <span class="command-result-folder">${escapeHtml(result.folderName)}</span>
        <span class="command-result-date">${formatDate(result.updatedAt)}</span>
      </div>
    </button>
  `).join('');
}

function updateCommandResultsUI({ ensureActiveVisible = false } = {}) {
  const overlay = document.getElementById('command-palette-overlay');
  if (!overlay || !state.commandPaletteOpen) return;
  const resultsEl = overlay.querySelector('.command-palette-results');
  if (!resultsEl) return;

  const results = getActiveResults();
  normalizeCommandSelection(results);
  resultsEl.innerHTML = renderCommandResultsMarkup(results);

  if (ensureActiveVisible && results.length > 0) {
    const activeEl = resultsEl.querySelector('.command-result-item.active');
    if (activeEl) activeEl.scrollIntoView({ block: 'nearest' });
  }
}

function renderCommandPalette({ focusInput = false } = {}) {
  const existing = document.getElementById('command-palette-overlay');
  if (existing) existing.remove();
  if (!state.commandPaletteOpen) return;

  const overlay = document.createElement('div');
  overlay.id = 'command-palette-overlay';
  overlay.className = 'command-palette-overlay';
  overlay.onclick = () => closeCommandPalette();
  overlay.innerHTML = `
    <div class="command-palette" onclick="event.stopPropagation()">
      <div class="command-palette-input-wrap">
        <input
          id="command-palette-input"
          class="command-palette-input"
          type="text"
          value="${escapeHtml(state.commandQuery)}"
          placeholder="Search notes, previews, and folders..."
          oninput="setCommandQuery(this.value)" />
      </div>
      <div class="command-palette-results"></div>
    </div>
  `;
  document.body.appendChild(overlay);
  updateCommandResultsUI();

  if (focusInput) {
    focusCommandPaletteInput();
  }
}

function openCommandPalette() {
  if (state.commandPaletteOpen) {
    focusCommandPaletteInput();
    return;
  }
  state.commandPaletteOpen = true;
  state.commandQuery = '';
  state.commandSelectedIndex = 0;
  closeContextMenu();
  renderCommandPalette({ focusInput: true });
}

function closeCommandPalette() {
  if (!state.commandPaletteOpen) return;
  state.commandPaletteOpen = false;
  state.commandQuery = '';
  state.commandSelectedIndex = 0;
  cachedFtsResults = null;
  if (ftsSearchTimeout) { clearTimeout(ftsSearchTimeout); ftsSearchTimeout = null; }
  renderCommandPalette();
}

function setCommandQuery(value) {
  state.commandQuery = value;
  state.commandSelectedIndex = 0;
  const query = value.trim();
  if (query) {
    cachedFtsResults = null;
    triggerFtsSearch(query);
  } else {
    cachedFtsResults = null;
    if (ftsSearchTimeout) { clearTimeout(ftsSearchTimeout); ftsSearchTimeout = null; }
  }
  updateCommandResultsUI({ ensureActiveVisible: true });
}

function getActiveResults() {
  const query = state.commandQuery.trim();
  if (!query || cachedFtsResults === null) return getCommandResults();
  // FTS currently indexes title/body only. Merge folder-name matches from local state
  // so folder queries still work after async FTS results arrive.
  const seen = new Set(cachedFtsResults.map(result => result.noteId));
  const merged = cachedFtsResults.slice();
  for (const folderMatch of getFolderNameMatches(query, seen)) {
    merged.push(folderMatch);
    if (merged.length >= MAX_COMMAND_RESULTS) break;
  }
  return merged;
}

function updateCommandSelectionUI(prevIndex, nextIndex) {
  const overlay = document.getElementById('command-palette-overlay');
  if (!overlay) return;
  const prevEl = overlay.querySelector(`.command-result-item[data-command-index="${prevIndex}"]`);
  if (prevEl) prevEl.classList.remove('active');
  const nextEl = overlay.querySelector(`.command-result-item[data-command-index="${nextIndex}"]`);
  if (!nextEl) return;
  nextEl.classList.add('active');
  nextEl.scrollIntoView({ block: 'nearest' });
}

function moveCommandSelection(delta) {
  const results = getActiveResults();
  if (results.length === 0) return;
  const len = results.length;
  const prevIndex = state.commandSelectedIndex;
  state.commandSelectedIndex = (prevIndex + delta + len) % len;
  updateCommandSelectionUI(prevIndex, state.commandSelectedIndex);
}

function selectCommandResult(index) {
  const results = getActiveResults();
  if (results.length === 0) return;
  const safeIndex = Math.max(0, Math.min(index, results.length - 1));
  const selected = results[safeIndex];
  if (!selected) return;
  state.activeFolderId = selected.folderId;
  state.activeNoteId = selected.noteId;
  closeCommandPalette();
  render();
}

// ===== SORT HELPER =====
function getSortedFolderNotes(folderId) {
  const notes = (state.notesByFolderId.get(folderId) || []).slice();
  if (state.sortMode === 'recent') {
    return notes.sort((a, b) => (b.pinned - a.pinned) || (b.updatedAt - a.updatedAt));
  }
  return notes.sort((a, b) => (b.pinned - a.pinned) || (a.sortOrder - b.sortOrder));
}

// ===== DRAG STATE =====
let draggedNoteId = null;
let draggedCardEl = null;
let prevDropTarget = null;

// ===== RENDER HELPERS =====
function renderSidebar() {
  const root = document.getElementById('sidebar-root');
  if (!root) return;

  const theme = loadTheme();
  const { data, activeFolderId, editingFolderId } = state;

  root.innerHTML = `
    <div class="sidebar-header">
      <div class="logo">a<span>note</span></div>
      <div class="sidebar-header-actions">
        <button class="theme-toggle" onclick="toggleTheme()" title="Toggle theme">
          ${theme === 'light' ? icons.moon : icons.sun}
        </button>
        <button class="theme-toggle" onclick="toggleSidebar()" title="Toggle sidebar">
          ${icons.panelLeft}
        </button>
      </div>
    </div>

    <div class="folders-section">
      <div class="section-label">
        <span>Folders</span>
        <button class="add-folder-btn" onclick="addFolder()" title="New folder">
          ${icons.plus}
        </button>
      </div>

      ${data.folders.length === 0 ? `
        <div class="empty-folders">
          <div class="empty-folders-icon">${icons.folder}</div>
          <p>No folders yet.<br>Create one to start writing.</p>
        </div>
      ` : `
        <ul class="folder-list">
          ${renderFolderTree(null, 0)}
        </ul>
      `}
    </div>

    <div class="sidebar-footer">
      <p>Write something worth keeping.</p>
      <button class="settings-btn" onclick="openSettingsModal()" title="Settings">
        ${icons.gear}
      </button>
    </div>
  `;

  // Auto-focus editing inputs
  if (editingFolderId) {
    const input = document.getElementById(`folder-edit-${editingFolderId}`);
    if (input) {
      input.focus();
      input.select();
    }
  }
}

function renderFindBar() {
  const editorPanel = document.querySelector('.editor-panel');
  if (!editorPanel) return;

  let findBar = document.getElementById('find-bar');

  if (!state.findBarOpen) {
    if (findBar) findBar.remove();
    return;
  }

  const { findQuery, findMatches, findCurrentMatch } = state;
  const count = findMatches.length;
  const current = count > 0 ? findCurrentMatch + 1 : 0;

  // Build once, then do targeted updates
  if (!findBar) {
    findBar = document.createElement('div');
    findBar.id = 'find-bar';
    findBar.className = 'find-bar';
    findBar.innerHTML = `
      <input type="text"
             class="find-bar-input"
             placeholder="Find in note..."
             id="find-input" />
      <span class="find-bar-count" id="find-count"></span>
      <button class="find-bar-btn" onclick="navigateFindMatch(-1)" title="Previous (Shift+Enter)">
        ${icons.chevronUp}
      </button>
      <button class="find-bar-btn" onclick="navigateFindMatch(1)" title="Next (Enter)">
        ${icons.chevronDown}
      </button>
      <button class="find-bar-btn find-bar-close" onclick="closeFindBar()" title="Close (Esc)">
        ${icons.x}
      </button>
    `;
    const input = findBar.querySelector('#find-input');
    input.addEventListener('input', (e) => setFindQuery(e.target.value));
    input.addEventListener('keydown', (e) => handleFindBarKeydown(e));
    editorPanel.appendChild(findBar);
    input.focus();
  }

  // Targeted updates: count label and input value
  const countEl = document.getElementById('find-count');
  if (countEl) {
    if (!findQuery.trim()) {
      countEl.textContent = '';
      countEl.style.display = 'none';
    } else if (count === 0) {
      countEl.textContent = 'No results';
      countEl.style.display = '';
      countEl.className = 'find-bar-count no-results';
    } else {
      countEl.textContent = `${current} / ${count}`;
      countEl.style.display = '';
      countEl.className = 'find-bar-count';
    }
  }

  const input = document.getElementById('find-input');
  if (input && input.value !== findQuery) {
    input.value = findQuery;
  }
}

function openFindBar() {
  if (state.findBarOpen) {
    document.getElementById('find-input')?.focus();
    return;
  }
  state.findBarOpen = true;
  state.findQuery = '';
  state.findMatches = [];
  state.findCurrentMatch = 0;
  renderFindBar();
  performFind('');
}

function closeFindBar() {
  if (!state.findBarOpen) return;
  state.findBarOpen = false;
  state.findQuery = '';
  state.findMatches = [];
  state.findCurrentMatch = 0;
  clearFindHighlights();
  renderFindBar();
}

function setFindQuery(value) {
  state.findQuery = value;
  performFind(value);
}

function performFind(query) {
  state.findMatches = [];
  state.findCurrentMatch = 0;

  if (!query.trim()) {
    updateFindHighlights([], 0);
    renderFindBar();
    return;
  }
  
  const editorView = getEditorView();
  if (!editorView) return;
  
  const { state: pmState } = editorView;
  const doc = pmState.doc;
  const text = query.trim().toLowerCase();
  
  let matches = [];
  
  doc.descendants((node, pos) => {
    if (node.isText && node.text) {
      const nodeText = node.text.toLowerCase();
      let start = 0;
      while ((start = nodeText.indexOf(text, start)) !== -1) {
        const from = pos + start;
        const to = from + text.length;
        matches.push({ from, to });
        start += text.length;
      }
    }
  });
  
  state.findMatches = matches;
  if (matches.length > 0) {
    state.findCurrentMatch = 0;
    updateFindHighlights(matches, 0);
    highlightFindMatch(0);
  } else {
    updateFindHighlights([], 0);
  }
  renderFindBar();
}

function navigateFindMatch(delta) {
  const { findMatches } = state;
  if (findMatches.length === 0) return;

  const newIndex = (state.findCurrentMatch + delta + findMatches.length) % findMatches.length;
  state.findCurrentMatch = newIndex;
  updateFindHighlights(findMatches, newIndex);
  highlightFindMatch(newIndex);
  renderFindBar();
}

function highlightFindMatch(index) {
  const { findMatches } = state;
  if (index < 0 || index >= findMatches.length) return;

  const editorView = getEditorView();
  if (!editorView) return;

  const { state: pmState, dispatch } = editorView;
  const match = findMatches[index];
  const resolved = pmState.doc.resolve(match.from);
  const sel = TextSelection.near(resolved);
  dispatch(pmState.tr.setSelection(sel).scrollIntoView());
}

function clearFindHighlights() {
  updateFindHighlights([], 0);
}

function handleFindBarKeydown(e) {
  if (e.key === 'Enter') {
    e.preventDefault();
    const delta = e.shiftKey ? -1 : 1;
    navigateFindMatch(delta);
  } else if (e.key === 'Escape') {
    e.preventDefault();
    closeFindBar();
    focusEditor();
  }
}

function renderNotesHeader() {
  const root = document.getElementById('notes-header-root');
  if (!root) return;
  const { activeFolderId } = state;
  const activeFolder = state.foldersById.get(activeFolderId);
  const expandBtn = state.sidebarCollapsed ? `
    <button class="sidebar-expand-btn" onclick="toggleSidebar()" title="Show sidebar">
      ${icons.panelLeft}
    </button>
  ` : '';
  const sortIcon = state.sortMode === 'manual' ? icons.gripLines : icons.clock;
  const sortTooltip = state.sortMode === 'manual'
    ? 'Manual order - click to sort by date'
    : 'Date order - click to sort manually';
  const escapedSortTooltip = escapeHtml(sortTooltip);
  const shortcutLabel = escapeHtml(getShortcutLabel());
  const shortcutHint = escapeHtml(getShortcutHint());
  root.innerHTML = `
    ${expandBtn}
    <h2 class="notes-header-title">${activeFolder ? escapeHtml(activeFolder.name) : ''}</h2>
    <button class="notes-search-trigger"
            onclick="openCommandPalette()"
            title="Search notes (${shortcutLabel})"
            aria-label="Search notes (${shortcutLabel})">
      <span class="notes-search-placeholder">Search notes...</span>
      <span class="notes-search-shortcut">${shortcutHint}</span>
    </button>
    <div class="sort-tooltip-wrap">
      <button class="sort-toggle-btn"
              onclick="toggleSortMode()"
              aria-label="${escapedSortTooltip}"
              aria-describedby="sort-tooltip">
        ${sortIcon}
      </button>
      <div class="sort-tooltip" id="sort-tooltip" role="tooltip">${escapedSortTooltip}</div>
    </div>
    <button class="add-note-btn" onclick="addNote()">
      ${icons.plus}
      <span>New note</span>
    </button>
  `;
}

function renderNotesList() {
  const root = document.getElementById('notes-list-root');
  if (!root) return;
  const { activeFolderId, activeNoteId } = state;
  const folderNotes = activeFolderId
    ? getSortedFolderNotes(activeFolderId)
    : [];
  const isManual = state.sortMode === 'manual';

  if (isManual) {
    root.setAttribute('ondragover', 'onNotesListDragOver(event)');
    root.setAttribute('ondrop', 'onNotesListDrop(event)');
  } else {
    root.removeAttribute('ondragover');
    root.removeAttribute('ondrop');
  }

  if (folderNotes.length === 0) {
    root.innerHTML = `
      <div class="empty-notes">
        <div class="empty-notes-icon">${icons.file}</div>
        <h3>No notes yet</h3>
        <p>Create a new note to begin writing in this folder.</p>
      </div>
    `;
  } else {
    let html = '';
    let addedSeparator = false;
    for (let i = 0; i < folderNotes.length; i++) {
      const note = folderNotes[i];
      // Add separator between pinned and unpinned groups
      if (!addedSeparator && !note.pinned && i > 0 && folderNotes[i - 1].pinned) {
        html += `<div class="notes-pin-separator"></div>`;
        addedSeparator = true;
      }
      const dragAttrs = isManual ? `draggable="true" ondragstart="onNoteDragStart(event, '${note.id}')" ondragover="onNoteDragOver(event, '${note.id}')" ondragleave="onNoteDragLeave(event)" ondrop="onNoteDrop(event, '${note.id}')" ondragend="onNoteDragEnd(event)"` : '';
      html += `
      <div class="note-card ${activeNoteId === note.id ? 'active' : ''} ${note.pinned ? 'pinned' : ''}"
           onclick="selectNote('${note.id}')"
           oncontextmenu="showNoteContextMenu(event, '${note.id}')"
           data-note-id="${note.id}"
           data-pinned="${note.pinned ? '1' : '0'}"
           ${dragAttrs}>
        ${note.pinned ? `<div class="note-card-pin-indicator">${icons.pin}</div>` : ''}
        <div class="note-card-title">${escapeHtml(note.title || 'Untitled')}</div>
        <div class="note-card-preview">${escapeHtml(getStrippedPreview(note.preview || '').slice(0, 80) || 'Empty note')}</div>
        <div class="note-card-date">${formatDate(note.updatedAt)}</div>
        <button class="note-card-pin" onclick="event.stopPropagation(); togglePinNote('${note.id}')" title="${note.pinned ? 'Unpin' : 'Pin to top'}">
          ${icons.pin}
        </button>
        <button class="note-card-delete" onclick="event.stopPropagation(); deleteNote('${note.id}')" title="Delete note">
          ${icons.x}
        </button>
      </div>`;
    }
    root.innerHTML = html;
  }
}

async function renderEditorPanel(focusTitle) {
  const root = document.getElementById('editor-panel-root');
  if (!root) return;
  const { activeNoteId } = state;
  const activeNote = state.notesById.get(activeNoteId);

  // Destroy old editor
  await destroyEditor();
  currentEditorNoteId = null;

  if (!activeNote) {
    root.innerHTML = `
      <div class="editor-empty">
        <div class="editor-empty-quill">${icons.quill}</div>
        <p>Select a note or create a new one</p>
      </div>
    `;
    return;
  }

  currentEditorNoteId = activeNote.id;

  // Load body on demand if not yet loaded
  if (activeNote.body === null) {
    activeNote.body = await invoke('get_note_body', { id: activeNote.id });
    // Guard: user may have switched notes during the await
    if (state.activeNoteId !== activeNote.id) return;
  }

  root.innerHTML = `
    <input class="editor-title-input"
           type="text"
           placeholder="Untitled"
           value="${escapeHtml(activeNote.title)}"
           id="editor-title" />
    <div class="editor-date">${formatDate(activeNote.updatedAt)}</div>
    <div class="editor-body" id="editor-milkdown"></div>
  `;

  // Wire up title input with addEventListener
  const titleInput = document.getElementById('editor-title');
  if (titleInput) {
    titleInput.addEventListener('input', (e) => {
      updateNoteTitle(activeNote.id, e.target.value);
    });
    titleInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        focusEditor();
      }
    });
    if (focusTitle) {
      titleInput.focus();
    }
  }

  // Create Milkdown editor
  const editorContainer = document.getElementById('editor-milkdown');
  if (editorContainer) {
    await createEditor(editorContainer, activeNote.body, (markdown) => {
      updateNoteBody(activeNote.id, markdown);
    });
  }
}

// ===== MAIN RENDER =====
// Builds the skeleton on first call or when layout changes (folder selected/deselected).
// Subsequent calls only update the parts that changed.
export async function render(options = {}) {
  const app = document.getElementById('app');
  const { activeFolderId, activeNoteId } = state;
  const layoutChanged = !app.children.length || (currentFolderId === null) !== (activeFolderId === null);

  if (layoutChanged || !app.children.length) {
    // Full skeleton rebuild
    await destroyEditor();
    currentEditorNoteId = null;

    const collapsedClass = state.sidebarCollapsed ? ' collapsed' : '';
    if (!activeFolderId) {
      app.innerHTML = `
        <aside class="sidebar${collapsedClass}" id="sidebar-root"></aside>
        <main class="main">
          <div class="no-folder-state">
            <div class="empty-notes-icon">${icons.quill}</div>
            <h2>Welcome to anote</h2>
            <p>Select a folder from the sidebar to view your notes, or create a new one to get started.</p>
          </div>
        </main>
      `;
    } else {
      app.innerHTML = `
        <aside class="sidebar${collapsedClass}" id="sidebar-root"></aside>
        <main class="main" id="main-root">
          <div class="notes-header" id="notes-header-root"></div>
          <div class="content-area">
            <div class="notes-list-panel" id="notes-list-root"></div>
            <div class="editor-panel" id="editor-panel-root"></div>
          </div>
        </main>
      `;
    }
    currentFolderId = activeFolderId;
  }

  const selective = isDirtySet();

  if (!selective || dirty.sidebar) renderSidebar();

  if (activeFolderId) {
    if (!selective || dirty.notesHeader) renderNotesHeader();
    if (!selective || dirty.notesList) renderNotesList();

    // Only rebuild editor when active note changes
    if (currentEditorNoteId !== activeNoteId) {
      await renderEditorPanel(options.focusTitle);
    }

    // Always render find bar if open (it's positioned absolutely in editor panel)
    if (state.findBarOpen) {
      renderFindBar();
    }
  }

  clearDirty();
}

// ===== THEME =====
function toggleTheme() {
  const current = loadTheme();
  const next = current === 'light' ? 'dark' : 'light';
  saveTheme(next);
  dirty.sidebar = true;
  render();
}

function toggleSidebar() {
  state.sidebarCollapsed = !state.sidebarCollapsed;
  const sidebar = document.getElementById('sidebar-root');
  if (sidebar) sidebar.classList.toggle('collapsed', state.sidebarCollapsed);
  // Re-render header to show/hide expand button inline
  renderNotesHeader();
}

// ===== FOLDER ACTIONS =====
async function addFolder(parentId = null) {
  const targetParentId = parentId ?? null;
  const folder = {
    id: generateId(),
    name: 'New folder',
    createdAt: Date.now(),
    parentId: targetParentId,
  };
  state.data.folders.push(folder);
  state.foldersById.set(folder.id, folder);
  state.notesByFolderId.set(folder.id, []);
  state.notesCountByFolder.set(folder.id, 0);
  state.activeFolderId = folder.id;
  state.activeNoteId = null;
  state.editingFolderId = folder.id;
  if (targetParentId) {
    state.expandedFolders.add(targetParentId);
  }
  dirty.sidebar = true;
  dirty.notesHeader = true;
  dirty.notesList = true;
  render();
  await invoke('create_folder', {
    id: folder.id, name: folder.name, createdAt: folder.createdAt, parentId: folder.parentId
  });
}

function selectFolder(id) {
  if (state.editingFolderId) return;
  if (state.findBarOpen) closeFindBar();
  flushPendingSaves();
  state.activeFolderId = id;
  state.activeNoteId = null;
  // Auto-select first note
  const folderNotes = getSortedFolderNotes(id);
  if (folderNotes.length > 0) {
    state.activeNoteId = folderNotes[0].id;
  }
  render();
}

function startEditingFolder(id) {
  state.editingFolderId = id;
  dirty.sidebar = true;
  render();
}

async function finishEditingFolder(id, value) {
  const folder = state.foldersById.get(id);
  const newName = value.trim() || 'Untitled folder';
  if (folder) {
    folder.name = newName;
  }
  state.editingFolderId = null;
  dirty.sidebar = true;
  dirty.notesHeader = true;
  render();
  await invoke('rename_folder', { id, name: newName });
}

function handleFolderKeydown(e, id, value) {
  if (e.key === 'Enter') {
    e.target.blur();
  } else if (e.key === 'Escape') {
    state.editingFolderId = null;
    dirty.sidebar = true;
    render();
  }
}

async function deleteFolder(id) {
  closeFolderMenus();
  const folderIdsToDelete = getDescendantFolderIds(id);
  folderIdsToDelete.push(id);
  const folderIdsSet = new Set(folderIdsToDelete);
  
  for (const folderId of folderIdsToDelete) {
    const folderNotes = state.notesByFolderId.get(folderId) || [];
    for (const n of folderNotes) {
      state.notesById.delete(n.id);
    }
    state.foldersById.delete(folderId);
    state.notesByFolderId.delete(folderId);
    state.notesCountByFolder.delete(folderId);
    state.expandedFolders.delete(folderId);
  }
  state.data.folders = state.data.folders.filter(f => !folderIdsSet.has(f.id));
  state.data.notes = state.data.notes.filter(n => !folderIdsSet.has(n.folderId));
  
  if (folderIdsSet.has(state.activeFolderId)) {
    state.activeFolderId = null;
    state.activeNoteId = null;
  }
  render();
  await invoke('delete_folder', { id });
}

async function moveFolderTo(folderId, newParentId) {
  const folder = state.foldersById.get(folderId);
  if (!folder) return;
  
  const oldParentId = folder.parentId;
  if (oldParentId === newParentId) return;
  
  folder.parentId = newParentId;
  
  // Expand the new parent so the folder is visible
  if (newParentId) {
    state.expandedFolders.add(newParentId);
  }
  
  dirty.sidebar = true;
  render();
  
  try {
    await invoke('update_folder', {
      id: folderId,
      name: null,
      parentId: newParentId
    });
  } catch (e) {
    console.error('Failed to move folder:', e);
    // Revert on error
    folder.parentId = oldParentId;
    dirty.sidebar = true;
    render();
  }
}

function getDescendantFolderIds(parentId) {
  const descendants = [];
  const children = getChildFolders(parentId);
  for (const child of children) {
    descendants.push(child.id);
    descendants.push(...getDescendantFolderIds(child.id));
  }
  return descendants;
}

function showFolderContextMenu(e, folderId) {
  e.preventDefault();
  e.stopPropagation();
  closeContextMenu();

  // Get all folders except the current one and its descendants
  const descendants = new Set();
  function collectDescendants(id) {
    descendants.add(id);
    for (const f of state.data.folders) {
      if (f.parentId === id) collectDescendants(f.id);
    }
  }
  collectDescendants(folderId);

  const availableFolders = state.data.folders
    .filter(f => f.id !== folderId && !descendants.has(f.id))
    .map(f => {
      const indent = f.parentId ? ' ' : '';
      return `<button class="context-menu-item" onclick="closeContextMenu(); moveFolderTo('${folderId}', '${f.id || ''}')">
        ${indent}${escapeHtml(f.name)}${!f.parentId ? ' (root)' : ''}
      </button>`;
    })
    .join('');

  const menu = document.createElement('div');
  menu.className = 'context-menu';
  menu.style.left = e.clientX + 'px';
  menu.style.top = e.clientY + 'px';
  menu.innerHTML = `
    <button class="context-menu-item" onclick="closeContextMenu(); startEditingFolder('${folderId}')">
      ${icons.edit} Rename
    </button>
    <div class="context-menu-item has-submenu">
      ${icons.folder} Move to...
      <div class="context-submenu">
        <button class="context-menu-item" onclick="closeContextMenu(); moveFolderTo('${folderId}', null)">
          (root)
        </button>
        ${availableFolders}
      </div>
    </div>
    <div class="context-menu-separator"></div>
    <button class="context-menu-item danger" onclick="closeContextMenu(); deleteFolder('${folderId}')">
      ${icons.trash} Delete folder
    </button>
  `;
  document.body.appendChild(menu);

  // Adjust if off-screen
  const rect = menu.getBoundingClientRect();
  if (rect.right > window.innerWidth) menu.style.left = (window.innerWidth - rect.width - 8) + 'px';
  if (rect.bottom > window.innerHeight) menu.style.top = (window.innerHeight - rect.height - 8) + 'px';

  state.contextMenu = menu;
}

function closeContextMenu() {
  if (state.contextMenu) {
    state.contextMenu.remove();
    state.contextMenu = null;
  }
}

function toggleFolderMenu(folderId) {
  const menu = document.getElementById(`folder-menu-${folderId}`);
  if (!menu) return;
  const wasOpen = menu.classList.contains('open');
  closeFolderMenus();
  if (!wasOpen) {
    menu.classList.add('open');
  }
}

function closeFolderMenus() {
  document.querySelectorAll('.folder-menu.open').forEach(m => m.classList.remove('open'));
}

// ===== NOTE ACTIONS =====
async function addNote() {
  if (!state.activeFolderId) return;
  // Shift existing unpinned notes' sortOrder by +1
  const unpinnedNotes = state.data.notes.filter(n => n.folderId === state.activeFolderId && !n.pinned);
  unpinnedNotes.forEach(n => { n.sortOrder += 1; });
  const note = {
    id: generateId(),
    folderId: state.activeFolderId,
    title: '',
    preview: '',
    body: '',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    pinned: 0,
    sortOrder: 0,
  };
  state.data.notes.push(note);
  state.notesById.set(note.id, note);
  const folderList = state.notesByFolderId.get(note.folderId);
  if (folderList) folderList.push(note);
  state.notesCountByFolder.set(note.folderId, (state.notesCountByFolder.get(note.folderId) || 0) + 1);
  state.activeNoteId = note.id;
  dirty.sidebar = true;
  dirty.notesList = true;
  await render({ focusTitle: true });
  invoke('create_note', {
    id: note.id, folderId: note.folderId, title: note.title,
    body: note.body, createdAt: note.createdAt, updatedAt: note.updatedAt,
    pinned: note.pinned, sortOrder: note.sortOrder
  });
  invoke('reorder_notes', { updates: unpinnedNotes.map(n => [n.id, n.sortOrder]) });
}

function selectNote(id) {
  if (state.findBarOpen) closeFindBar();
  flushPendingSaves();
  const prevId = state.activeNoteId;
  state.activeNoteId = id;

  // Toggle active class directly instead of full rebuild
  if (prevId) {
    const prevCard = document.querySelector(`.note-card[data-note-id="${prevId}"]`);
    if (prevCard) prevCard.classList.remove('active');
  }
  const newCard = document.querySelector(`.note-card[data-note-id="${id}"]`);
  if (newCard) newCard.classList.add('active');

  // Only rebuild the editor
  renderEditorPanel();
}

const saveTimeouts = new Map();
const lastSaved = new Map();

function persistNote(note) {
  const key = note.id;
  const prev = lastSaved.get(key);
  // Include updatedAt in dedupe so timestamp-only updates still persist to SQLite.
  if (prev && prev.title === note.title && prev.body === note.body && prev.updatedAt === note.updatedAt) return;
  lastSaved.set(key, { title: note.title, body: note.body, updatedAt: note.updatedAt });
  invoke('update_note', {
    id: note.id, title: note.title, body: note.body, updatedAt: note.updatedAt
  });
}

function scheduleSave(note) {
  const existing = saveTimeouts.get(note.id);
  if (existing) clearTimeout(existing);
  saveTimeouts.set(note.id, setTimeout(() => {
    saveTimeouts.delete(note.id);
    updateNoteCard(note);
    persistNote(note);
  }, 300));
}

function flushPendingSaves() {
  for (const [id, timeout] of saveTimeouts) {
    clearTimeout(timeout);
    const note = state.notesById.get(id);
    if (note) {
      updateNoteCard(note);
      persistNote(note);
    }
  }
  saveTimeouts.clear();
}

function updateNoteTitle(id, value) {
  const note = state.notesById.get(id);
  if (note) {
    note.title = value;
    note.updatedAt = Date.now();
    scheduleSave(note);
  }
}

function updateNoteBody(id, value) {
  const note = state.notesById.get(id);
  if (note) {
    note.body = value;
    note.preview = value.slice(0, 200);
    note.updatedAt = Date.now();
    scheduleSave(note);
  }
}

function updateNoteCard(note) {
  const card = document.querySelector(`.note-card[data-note-id="${note.id}"]`);
  if (card) {
    const titleEl = card.querySelector('.note-card-title');
    const previewEl = card.querySelector('.note-card-preview');
    const dateEl = card.querySelector('.note-card-date');
    if (titleEl) titleEl.textContent = note.title || 'Untitled';
    if (previewEl) previewEl.textContent = getStrippedPreview(note.preview || '').slice(0, 80) || 'Empty note';
    if (dateEl) dateEl.textContent = formatDate(note.updatedAt);
  }
}

async function deleteNote(id) {
  const note = state.notesById.get(id);
  state.data.notes = state.data.notes.filter(n => n.id !== id);
  if (note) {
    state.notesById.delete(id);
    const list = state.notesByFolderId.get(note.folderId);
    if (list) {
      const idx = list.indexOf(note);
      if (idx !== -1) list.splice(idx, 1);
    }
    const prev = state.notesCountByFolder.get(note.folderId) || 0;
    if (prev > 0) state.notesCountByFolder.set(note.folderId, prev - 1);
  }
  if (state.activeNoteId === id) {
    const folderNotes = getSortedFolderNotes(state.activeFolderId);
    state.activeNoteId = folderNotes.length > 0 ? folderNotes[0].id : null;
  }
  dirty.sidebar = true;
  dirty.notesList = true;
  render();
  await invoke('delete_note', { id });
}

// ===== DRAG-AND-DROP =====
function onNoteDragStart(e, id) {
  draggedNoteId = id;
  draggedCardEl = e.currentTarget;
  prevDropTarget = null;
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', id);
  if (draggedCardEl) requestAnimationFrame(() => draggedCardEl.classList.add('dragging'));
}

function onNoteDragOver(e, targetId) {
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  if (!draggedNoteId || draggedNoteId === targetId) return;
  const draggedNote = state.notesById.get(draggedNoteId);
  const targetNote = state.notesById.get(targetId);
  if (!draggedNote || !targetNote) return;
  // Reject cross-group drops
  if (!!draggedNote.pinned !== !!targetNote.pinned) return;

  const card = e.currentTarget;
  if (!card) return;
  if (prevDropTarget && prevDropTarget !== card) {
    prevDropTarget.classList.remove('drop-above', 'drop-below');
  }
  prevDropTarget = card;
  card.classList.remove('drop-above', 'drop-below');
  const rect = card.getBoundingClientRect();
  const midY = rect.top + rect.height / 2;
  if (e.clientY < midY) {
    card.classList.add('drop-above');
  } else {
    card.classList.add('drop-below');
  }
}

function onNoteDragLeave(e) {
  const card = e.currentTarget;
  if (card && !card.contains(e.relatedTarget)) {
    card.classList.remove('drop-above', 'drop-below');
  }
}

function clearDragClasses() {
  if (draggedCardEl) { draggedCardEl.classList.remove('dragging'); draggedCardEl = null; }
  if (prevDropTarget) { prevDropTarget.classList.remove('drop-above', 'drop-below'); prevDropTarget = null; }
}

function applyManualReorder(orderedNotes) {
  orderedNotes.forEach((n, i) => { n.sortOrder = i; });
  draggedNoteId = null;
  clearDragClasses();
  renderNotesList();
  invoke('reorder_notes', { updates: orderedNotes.map(n => [n.id, n.sortOrder]) });
}

function reorderByTarget(dragId, targetId, placement = 'above') {
  if (!dragId || dragId === targetId) return;
  const draggedNote = state.notesById.get(dragId);
  const targetNote = state.notesById.get(targetId);
  if (!draggedNote || !targetNote) return;
  if (!!draggedNote.pinned !== !!targetNote.pinned) return;

  const isPinned = !!draggedNote.pinned;
  const group = getSortedFolderNotes(draggedNote.folderId).filter(n => !!n.pinned === isPinned);
  const filtered = group.filter(n => n.id !== dragId);
  let targetIdx = filtered.findIndex(n => n.id === targetId);
  if (targetIdx === -1) return;
  if (placement === 'below') targetIdx += 1;

  filtered.splice(targetIdx, 0, draggedNote);
  applyManualReorder(filtered);
}

function onNoteDrop(e, targetId) {
  e.preventDefault();
  e.stopPropagation();
  if (!draggedNoteId || draggedNoteId === targetId) return;

  const targetCard = e.currentTarget;
  if (!targetCard) return;
  const rect = targetCard.getBoundingClientRect();
  const midY = rect.top + rect.height / 2;
  const placement = e.clientY >= midY ? 'below' : 'above';
  reorderByTarget(draggedNoteId, targetId, placement);
}

function onNotesListDragOver(e) {
  if (!draggedNoteId) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
}

function onNotesListDrop(e) {
  e.preventDefault();
  if (!draggedNoteId) return;
  if (e.target.closest('.note-card')) return;

  const draggedNote = state.notesById.get(draggedNoteId);
  if (!draggedNote) return;

  const isPinned = !!draggedNote.pinned;
  const reordered = getSortedFolderNotes(draggedNote.folderId)
    .filter(n => !!n.pinned === isPinned && n.id !== draggedNoteId);
  reordered.push(draggedNote);
  applyManualReorder(reordered);
}

function onNoteDragEnd() {
  draggedNoteId = null;
  clearDragClasses();
}

// ===== SORT & PIN =====
function toggleSortMode() {
  state.sortMode = state.sortMode === 'manual' ? 'recent' : 'manual';
  renderNotesHeader();
  renderNotesList();
}

async function togglePinNote(id) {
  const note = state.notesById.get(id);
  if (!note) return;
  note.pinned = note.pinned ? 0 : 1;
  // Move to top of its new group
  const folderNotes = state.data.notes.filter(n => n.folderId === note.folderId && n.id !== id);
  if (note.pinned) {
    // Newly pinned: give sortOrder 0, shift other pinned notes
    const pinnedNotes = folderNotes.filter(n => n.pinned).sort((a, b) => a.sortOrder - b.sortOrder);
    pinnedNotes.forEach((n, i) => { n.sortOrder = i + 1; });
    note.sortOrder = 0;
  } else {
    // Newly unpinned: give sortOrder 0, shift other unpinned notes
    const unpinnedNotes = folderNotes.filter(n => !n.pinned).sort((a, b) => a.sortOrder - b.sortOrder);
    unpinnedNotes.forEach((n, i) => { n.sortOrder = i + 1; });
    note.sortOrder = 0;
  }
  renderNotesList();
  invoke('toggle_note_pinned', { id, pinned: note.pinned });
  // Persist reorder for all notes in the folder
  const allFolderNotes = state.data.notes.filter(n => n.folderId === note.folderId);
  invoke('reorder_notes', { updates: allFolderNotes.map(n => [n.id, n.sortOrder]) });
}

async function exportMarkdownNote(id) {
  const note = state.notesById.get(id);
  if (!note) return;

  try {
    // Flush any pending edits before exporting
    flushPendingSaves();
    
    // Sanitize filename for filesystem safety
    const rawTitle = (note.title || 'note').trim();
    const safeTitle = rawTitle.replace(/[\\/:*?"<>|]+/g, '_') || 'note';
    
    const filePath = await save({
      defaultPath: `${safeTitle}.md`,
      filters: [{ name: 'Markdown', extensions: ['md'] }]
    });
    if (filePath) {
      await DataLayer.exportNoteMarkdown(id, filePath);
    }
  } catch (e) {
    console.error('Failed to export note:', e);
  }
}

function showNoteContextMenu(e, noteId) {
  e.preventDefault();
  e.stopPropagation();
  closeContextMenu();

  const note = state.notesById.get(noteId);
  if (!note) return;

  const pinLabel = note.pinned ? 'Unpin' : 'Pin to top';
  const menu = document.createElement('div');
  menu.className = 'context-menu';
  menu.style.left = e.clientX + 'px';
  menu.style.top = e.clientY + 'px';
  menu.innerHTML = `
    <button class="context-menu-item" onclick="closeContextMenu(); togglePinNote('${noteId}')">
      ${icons.pin} ${pinLabel}
    </button>
    <button class="context-menu-item" onclick="closeContextMenu(); exportMarkdownNote('${noteId}')">
      ${icons.download} Export as Markdown
    </button>
    <div class="context-menu-separator"></div>
    <button class="context-menu-item danger" onclick="closeContextMenu(); deleteNote('${noteId}')">
      ${icons.trash} Delete note
    </button>
  `;
  document.body.appendChild(menu);

  const rect = menu.getBoundingClientRect();
  if (rect.right > window.innerWidth) menu.style.left = (window.innerWidth - rect.width - 8) + 'px';
  if (rect.bottom > window.innerHeight) menu.style.top = (window.innerHeight - rect.height - 8) + 'px';

  state.contextMenu = menu;
}

// ===== SETTINGS MODAL =====
function renderSettingsModal() {
  const existing = document.getElementById('settings-modal-overlay');
  if (existing) existing.remove();

  if (!state.settingsModalOpen) return;

  const overlay = document.createElement('div');
  overlay.id = 'settings-modal-overlay';
  overlay.className = 'modal-overlay';
  overlay.onclick = () => closeSettingsModal();
  overlay.innerHTML = `
    <div class="modal-content" onclick="event.stopPropagation()">
      <div class="modal-header">
        <h2>Settings</h2>
        <button class="modal-close-btn" onclick="closeSettingsModal()">${icons.x}</button>
      </div>
      <div class="modal-body">
        <div class="settings-section">
          <div class="settings-section-header">
            <h3>Backup</h3>
            <p>Export all your folders and notes as a JSON file to <code>~/.anote/backups/</code></p>
          </div>
          <div class="backup-buttons-row">
            <button class="settings-action-btn" onclick="exportBackup()">
              ${icons.download}
              <span>Export</span>
            </button>
            <button class="settings-action-btn" onclick="document.getElementById('import-file-input').click()">
              ${icons.upload}
              <span>Import</span>
            </button>
            <input type="file" id="import-file-input" accept=".json" style="display: none" onchange="importBackup(event)">
          </div>
          <div class="backup-status" id="backup-status"></div>
        </div>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
}

function openSettingsModal() {
  state.settingsModalOpen = true;
  renderSettingsModal();
}

function closeSettingsModal() {
  state.settingsModalOpen = false;
  renderSettingsModal();
}

async function exportBackup() {
  const statusEl = document.getElementById('backup-status');
  if (!statusEl) return;

  statusEl.className = 'backup-status loading';
  statusEl.textContent = 'Exporting...';

  try {
    const filePath = await invoke('export_backup');
    statusEl.className = 'backup-status success';
    statusEl.textContent = `Saved to ${filePath}`;
  } catch (e) {
    statusEl.className = 'backup-status error';
    statusEl.textContent = `Export failed: ${e}`;
  }
}

async function importBackup(event) {
  const statusEl = document.getElementById('backup-status');
  if (!statusEl) return;

  const file = event.target.files?.[0];
  if (!file) return;

  statusEl.className = 'backup-status loading';
  statusEl.textContent = 'Importing...';

  try {
    const text = await file.text();
    const data = JSON.parse(text);

    if (!Array.isArray(data.folders) || !Array.isArray(data.notes)) {
      throw new Error('Invalid backup file format');
    }

    for (const f of data.folders) {
      if (!isSafeId(f.id)) {
        throw new Error('Invalid backup file: unsafe folder ID');
      }
      if (f.parent_id !== null && f.parent_id !== undefined && !isSafeId(f.parent_id)) {
        throw new Error('Invalid backup file: unsafe parent folder ID');
      }
    }
    for (const n of data.notes) {
      if (!isSafeId(n.id)) {
        throw new Error('Invalid backup file: unsafe note ID');
      }
      if (!isSafeId(n.folder_id)) {
        throw new Error('Invalid backup file: unsafe note folder ID');
      }
    }

    await invoke('import_data', { folders: data.folders, notes: data.notes });

    const existingFolderIds = new Set(state.data.folders.map(f => f.id));
    const existingNoteIds = new Set(state.data.notes.map(n => n.id));

    const newFolders = [];
    for (const f of data.folders) {
      if (existingFolderIds.has(f.id)) continue;
      existingFolderIds.add(f.id);
      newFolders.push({
        id: f.id,
        name: f.name,
        createdAt: f.created_at,
        parentId: f.parent_id || null
      });
    }

    const newNotes = [];
    for (const n of data.notes) {
      if (existingNoteIds.has(n.id)) continue;
      existingNoteIds.add(n.id);
      const body = typeof n.body === 'string' ? n.body : '';
      newNotes.push({
        id: n.id,
        folderId: n.folder_id,
        title: n.title || '',
        preview: body.slice(0, 200),
        body,
        createdAt: n.created_at,
        updatedAt: n.updated_at,
        pinned: n.pinned || 0,
        sortOrder: n.sort_order || 0
      });
    }

    state.data.folders = [...state.data.folders, ...newFolders];
    state.data.notes = [...state.data.notes, ...newNotes];
    rebuildIndexes();
    render();

    statusEl.className = 'backup-status success';
    statusEl.textContent = `Imported ${newFolders.length} folders and ${newNotes.length} notes`;
  } catch (e) {
    statusEl.className = 'backup-status error';
    statusEl.textContent = `Import failed: ${e}`;
  }

  event.target.value = '';
}

// ===== GLOBAL EVENT LISTENERS =====
window.addEventListener('beforeunload', flushPendingSaves);
document.addEventListener('click', closeContextMenu);
document.addEventListener('contextmenu', (e) => {
  if (!e.target.closest('.folder-item') && !e.target.closest('.note-card')) closeContextMenu();
});

// ===== KEYBOARD SHORTCUTS =====
document.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    openCommandPalette();
    return;
  }

  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'f') {
    e.preventDefault();
    if (state.activeNoteId) openFindBar();
    return;
  }

  if (state.findBarOpen) {
    if (e.key === 'Escape') {
      e.preventDefault();
      closeFindBar();
      focusEditor();
      return;
    }
    // Let all other keys pass through to the find input
    return;
  }

  if (state.commandPaletteOpen) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      moveCommandSelection(1);
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      moveCommandSelection(-1);
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      selectCommandResult(state.commandSelectedIndex);
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      closeCommandPalette();
      return;
    }
    return;
  }

  if ((e.metaKey || e.ctrlKey) && e.key === 'n') {
    e.preventDefault();
    if (state.activeFolderId) addNote();
  }
  if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === 'N') {
    e.preventDefault();
    addFolder();
  }
  if ((e.metaKey || e.ctrlKey) && e.key === ',') {
    e.preventDefault();
    openSettingsModal();
  }
  if (e.key === 'Escape') {
    if (state.settingsModalOpen) { closeSettingsModal(); return; }
    closeContextMenu();
  }
});

// ===== EXPOSE TO WINDOW FOR INLINE HANDLERS =====
window.toggleTheme = toggleTheme;
window.toggleSidebar = toggleSidebar;
window.addFolder = addFolder;
window.selectFolder = selectFolder;
window.startEditingFolder = startEditingFolder;
window.finishEditingFolder = finishEditingFolder;
window.handleFolderKeydown = handleFolderKeydown;
window.deleteFolder = deleteFolder;
window.moveFolderTo = moveFolderTo;
window.toggleFolderExpanded = toggleFolderExpanded;
window.toggleFolderMenu = toggleFolderMenu;
window.closeFolderMenus = closeFolderMenus;
window.showFolderContextMenu = showFolderContextMenu;
window.closeContextMenu = closeContextMenu;
window.addNote = addNote;
window.selectNote = selectNote;
window.updateNoteTitle = updateNoteTitle;
window.updateNoteBody = updateNoteBody;
window.deleteNote = deleteNote;
window.openCommandPalette = openCommandPalette;
window.closeCommandPalette = closeCommandPalette;
window.setCommandQuery = setCommandQuery;
window.selectCommandResult = selectCommandResult;
window.openSettingsModal = openSettingsModal;
window.closeSettingsModal = closeSettingsModal;
window.openFindBar = openFindBar;
window.closeFindBar = closeFindBar;
window.setFindQuery = setFindQuery;
window.handleFindBarKeydown = handleFindBarKeydown;
window.navigateFindMatch = navigateFindMatch;
window.exportBackup = exportBackup;
window.importBackup = importBackup;
window.toggleSortMode = toggleSortMode;
window.togglePinNote = togglePinNote;
window.exportMarkdownNote = exportMarkdownNote;
window.showNoteContextMenu = showNoteContextMenu;
window.onNoteDragStart = onNoteDragStart;
window.onNoteDragOver = onNoteDragOver;
window.onNoteDragLeave = onNoteDragLeave;
window.onNoteDrop = onNoteDrop;
window.onNoteDragEnd = onNoteDragEnd;
window.onNotesListDragOver = onNotesListDragOver;
window.onNotesListDrop = onNotesListDrop;
