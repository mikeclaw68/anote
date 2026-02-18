# NIGHTWORK.md - Anote Development Tasks


## HUMAN
I am the human.
Install cargo to actually run all the tests.

## Overview
This file contains tasks for nighttime autonomous development on the Anote project (https://github.com/mikeclaw68/anote).

## Current PRs
- **PR #1**: Raycast extension with bridge-backed writes + sync hardening (merged)
- **PR #4**: Quick Note & Voice Note commands for Raycast (in progress)

## Features to Implement

### Phase 1: Quick Wins (already partially in schema)
1. **Pin/Star Notes** - Backend already has `pinned` column! Need to:
   - Add toggle button in UI (sidebar or note card)
   - Sort pinned notes to top
   - Filter "Show pinned only" option

2. **Tags/Categories** - Need to add:
   - New `tags` table in SQLite
   - Many-to-many relationship (notes ↔ tags)
   - UI to add/remove tags on notes
   - Sidebar filter by tag

### Phase 2: Export Features
3. **Export to PDF**
   - Add Rust backend command using `printpdf` or similar
   - Button in note menu "Export as PDF"
   - Save to user-selected location via Tauri dialog

4. **Export to Markdown** - simpler, just save .md file

5. **Export to HTML**
   - Single HTML file with embedded styles
   - Good for sharing

### Phase 3: Enhanced Organization
6. **Nested Folders** - Backend already has `parent_id`!
   - UI for drag-drop folder nesting
   - Expand/collapse in sidebar

7. **Note Templates**
   - Predefined templates (meeting notes, daily log, etc.)
   - Create note from template

8. **Favorites** - separate from pinned, for quick access

### Phase 4: Nice to Have
9. **Keyboard Shortcuts** - Cmd+N new note, Cmd+S save, etc.
10. **Note Linking** - Wiki-style `[[note-title]]` links
11. **Sort Options** - By date created, date modified, title, manual

## Database Schema Changes Needed

```sql
-- Tags (new)
CREATE TABLE IF NOT EXISTS tags (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    color TEXT DEFAULT '#888888'
);

CREATE TABLE IF NOT EXISTS note_tags (
    note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
    tag_id TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
    PRIMARY KEY (note_id, tag_id)
);

-- Add to notes table (if not already)
ALTER TABLE notes ADD COLUMN starred INTEGER NOT NULL DEFAULT 0;
```

## Backend Commands to Add

```rust
// Tags
#[tauri::command] fn get_tags() -> Vec<Tag>
#[tauri::command] fn create_tag(name: String, color: String) -> Tag
#[tauri::command] fn delete_tag(id: String)
#[tauri::command] fn add_tag_to_note(note_id: String, tag_id: String)
#[tauri::command] fn remove_tag_from_note(note_id: String, tag_id: String)
#[tauri::command] fn get_notes_by_tag(tag_id: String) -> Vec<Note>

// Export
#[tauri::command] fn export_note_pdf(id: String, path: String) -> Result<()>
#[tauri::command] fn export_note_html(id: String, path: String) -> Result<()>
#[tauri::command] fn export_note_markdown(id: String, path: String) -> Result<()>

// Notes
#[tauri::command] fn toggle_pin(id: String) -> Result<()>
#[tauri::command] fn toggle_star(id: String) -> Result<()>
```

## Working Instructions

### Setup
1. Repository: /home/mike/.openclaw/workspace/anote
2. Work on branches from `main`
3. Push changes and create PRs regularly

### Development Workflow
1. Create feature branch: `git checkout -b feat/tags-system`
2. Make changes to backend (Rust) first, then frontend (JS)
3. Test with `cd src-tauri && cargo build` for Rust
4. Test with `bun run vite:dev` for frontend
5. Commit with conventional commits: `feat(tags): add tags table and CRUD`
6. Push and create PR

### Testing
- Run `cd src-tauri && cargo check` before committing
- Run `bun run vite:build` to verify frontend builds

### Cron Job Instructions
- Check every 15 minutes if work is in progress
- If no active task, pick next item from this list
- Commit progress even if incomplete
- Update this file with current status

## Current Status
- [x] Pin/star column exists in DB
- [x] Tags system (completed 2026-02-18)
- [x] Export PDF (completed 2026-02-18)
- [x] Export HTML (completed 2026-02-18)
- [ ] Export Markdown (not started)
- [ ] Nested folders UI (partial, backend exists)
- [ ] Note templates (not started)
- [ ] Favorites (not started)
- [ ] Keyboard shortcuts (not started)

## Notes
- The database schema already has `pinned` and `sort_order` columns
- Folders already have `parent_id` for nesting
- Raycast extension can be extended with these features too
- Use Tauri dialogs for file save dialogs
