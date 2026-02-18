import { invoke } from '@tauri-apps/api/core';

const STORAGE_KEY = 'anote_data';
const THEME_KEY = 'anote_theme';

export const state = {
  data: { folders: [], notes: [], tags: [] },
  activeFolderId: null,
  activeNoteId: null,
  editingFolderId: null,
  contextMenu: null,
  sidebarCollapsed: false,
  settingsModalOpen: false,
  sortMode: 'manual',
  commandPaletteOpen: false,
  commandQuery: '',
  commandSelectedIndex: 0,
  findBarOpen: false,
  findQuery: '',
  findMatches: [],
  findCurrentMatch: 0,
  expandedFolders: new Set(),
  activeTagId: null,  // Filter by tag
  // In-memory indexes for O(1) lookups
  notesById: new Map(),
  foldersById: new Map(),
  notesByFolderId: new Map(),
  notesCountByFolder: new Map(),
  tagsById: new Map(),
  notesByTagId: new Map(),
  noteTags: new Map(),  // noteId -> Set of tagIds
};

export function rebuildIndexes() {
  state.notesById.clear();
  state.foldersById.clear();
  state.notesByFolderId.clear();
  state.notesCountByFolder.clear();
  state.tagsById.clear();
  state.notesByTagId.clear();
  state.noteTags.clear();
  
  for (const f of state.data.folders) {
    state.foldersById.set(f.id, f);
    state.notesByFolderId.set(f.id, []);
    state.notesCountByFolder.set(f.id, 0);
  }
  
  for (const t of state.data.tags) {
    state.tagsById.set(t.id, t);
    state.notesByTagId.set(t.id, []);
  }
  
  for (const n of state.data.notes) {
    state.notesById.set(n.id, n);
    const list = state.notesByFolderId.get(n.folderId);
    if (list) list.push(n);
    state.notesCountByFolder.set(n.folderId, (state.notesCountByFolder.get(n.folderId) || 0) + 1);
    // Initialize empty tag set for each note
    state.noteTags.set(n.id, new Set());
  }
}

export const DataLayer = {
  async load() {
    try {
      const folders = await invoke('get_folders');
      const notes = await invoke('get_notes_metadata');
      const tags = await invoke('get_tags');
      state.data.folders = folders.map(f => ({
        id: f.id, name: f.name, createdAt: f.created_at, parentId: f.parent_id || null
      }));
      state.data.notes = notes.map(n => ({
        id: n.id, folderId: n.folder_id, title: n.title,
        preview: n.preview, body: null,
        createdAt: n.created_at, updatedAt: n.updated_at,
        pinned: n.pinned || 0, sortOrder: n.sort_order || 0
      }));
      state.data.tags = tags.map(t => ({
        id: t.id, name: t.name, color: t.color
      }));
      rebuildIndexes();
    } catch (e) {
      console.error('Failed to load data:', e);
      state.data = { folders: [], notes: [], tags: [] };
      state.notesById.clear();
      state.foldersById.clear();
      state.notesByFolderId.clear();
      state.notesCountByFolder.clear();
      state.tagsById.clear();
      state.notesByTagId.clear();
    }
  },
  
  async loadNotesByTag(tagId) {
    try {
      const notes = await invoke('get_notes_by_tag', { tagId });
      return notes.map(n => ({
        id: n.id, folderId: n.folder_id, title: n.title,
        preview: n.preview, body: null,
        createdAt: n.created_at, updatedAt: n.updated_at,
        pinned: n.pinned || 0, sortOrder: n.sort_order || 0
      }));
    } catch (e) {
      console.error('Failed to load notes by tag:', e);
      return [];
    }
  },
  
  async createTag(id, name, color) {
    try {
      await invoke('create_tag', { id, name, color });
      const tag = { id, name, color };
      state.data.tags.push(tag);
      state.tagsById.set(id, tag);
      return tag;
    } catch (e) {
      console.error('Failed to create tag:', e);
      throw e;
    }
  },
  
  async deleteTag(id) {
    try {
      await invoke('delete_tag', { id });
      state.data.tags = state.data.tags.filter(t => t.id !== id);
      state.tagsById.delete(id);
    } catch (e) {
      console.error('Failed to delete tag:', e);
      throw e;
    }
  },
  
  async addTagToNote(noteId, tagId) {
    try {
      await invoke('add_tag_to_note', { noteId, tagId });
    } catch (e) {
      console.error('Failed to add tag to note:', e);
      throw e;
    }
  },
  
  async removeTagFromNote(noteId, tagId) {
    try {
      await invoke('remove_tag_from_note', { noteId, tagId });
    } catch (e) {
      console.error('Failed to remove tag from note:', e);
      throw e;
    }
  },
  
  async getTagsForNote(noteId) {
    try {
      const tags = await invoke('get_tags_for_note', { noteId });
      return tags.map(t => ({ id: t.id, name: t.name, color: t.color }));
    } catch (e) {
      console.error('Failed to get tags for note:', e);
      return [];
    }
  },

  async exportNotePdf(noteId, path) {
    try {
      await invoke('export_note_pdf', { id: noteId, path });
    } catch (e) {
      console.error('Failed to export note as PDF:', e);
      throw e;
    }
  },
};

export async function migrateLocalStorage() {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return;
  try {
    const data = JSON.parse(raw);
    if (data.folders && data.folders.length > 0) {
      const folders = data.folders.map(f => ({
        id: f.id, name: f.name, created_at: f.createdAt, parent_id: f.parentId || null
      }));
      const notes = (data.notes || []).map(n => ({
        id: n.id, folder_id: n.folderId, title: n.title || '',
        body: n.body || '', created_at: n.createdAt, updated_at: n.updatedAt
      }));
      await invoke('import_data', { folders, notes });
    }
    localStorage.removeItem(STORAGE_KEY);
  } catch (e) {
    console.error('Migration failed:', e);
  }
}

export function loadTheme() {
  return localStorage.getItem(THEME_KEY) || 'light';
}

export function saveTheme(theme) {
  localStorage.setItem(THEME_KEY, theme);
  document.documentElement.setAttribute('data-theme', theme);
}

export function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

export function formatDate(ts) {
  const d = new Date(ts);
  return `${MONTHS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
}

export function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
