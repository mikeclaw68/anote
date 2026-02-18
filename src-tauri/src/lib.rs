mod db;
mod bridge_cli;

use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use tauri::{Manager, State};

struct Db(Mutex<Connection>);

#[derive(Serialize, Deserialize, Clone)]
struct Folder {
    id: String,
    name: String,
    created_at: i64,
    parent_id: Option<String>,
    #[serde(default)]
    updated_at: i64,
}

#[derive(Serialize, Deserialize, Clone)]
struct Note {
    id: String,
    folder_id: String,
    title: String,
    body: String,
    created_at: i64,
    updated_at: i64,
    // TEMP legacy-compat (added 12 02 2026): older localStorage imports don't include these fields.
    // Remove this defaulting path once legacy migration support is dropped.
    #[serde(default)]
    pinned: i32,
    #[serde(default)]
    sort_order: i32,
}

#[derive(Serialize, Clone)]
struct NoteMetadata {
    id: String,
    folder_id: String,
    title: String,
    preview: String,
    created_at: i64,
    updated_at: i64,
    pinned: i32,
    sort_order: i32,
}

#[derive(Serialize, Deserialize, Clone)]
struct Tag {
    id: String,
    name: String,
    color: String,
}

// ===== Folder commands =====

#[tauri::command]
fn get_folders(db: State<Db>) -> Result<Vec<Folder>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare("SELECT id, name, created_at, parent_id, COALESCE(updated_at, created_at) FROM folders ORDER BY created_at")
        .map_err(|e| e.to_string())?;
    let folders = stmt
        .query_map([], |row| {
            Ok(Folder {
                id: row.get(0)?,
                name: row.get(1)?,
                created_at: row.get(2)?,
                parent_id: row.get(3)?,
                updated_at: row.get(4)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(folders)
}

#[tauri::command]
fn create_folder(
    db: State<Db>,
    id: String,
    name: String,
    created_at: i64,
    parent_id: Option<String>,
) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO folders (id, name, created_at, parent_id, updated_at) VALUES (?1, ?2, ?3, ?4, ?3)",
        rusqlite::params![id, name, created_at, parent_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn rename_folder(db: State<Db>, id: String, name: String) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let now = chrono::Local::now().timestamp_millis();
    conn.execute(
        "UPDATE folders SET name = ?1, updated_at = ?3 WHERE id = ?2",
        rusqlite::params![name, id, now],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn delete_folder(db: State<Db>, id: String) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    delete_folder_recursive(&conn, &id)?;
    Ok(())
}

fn delete_folder_recursive(conn: &Connection, id: &str) -> Result<(), String> {
    let mut stmt = conn
        .prepare("SELECT id FROM folders WHERE parent_id = ?1")
        .map_err(|e| e.to_string())?;
    let children: Vec<String> = stmt
        .query_map(rusqlite::params![id], |row| row.get(0))
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;

    for child_id in children {
        delete_folder_recursive(conn, &child_id)?;
    }

    conn.execute(
        "DELETE FROM notes WHERE folder_id = ?1",
        rusqlite::params![id],
    )
    .map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM folders WHERE id = ?1", rusqlite::params![id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

// ===== Note commands =====

#[tauri::command]
fn get_notes_metadata(db: State<Db>) -> Result<Vec<NoteMetadata>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare("SELECT id, folder_id, title, substr(body, 1, 200), created_at, updated_at, pinned, sort_order FROM notes")
        .map_err(|e| e.to_string())?;
    let notes = stmt
        .query_map([], |row| {
            Ok(NoteMetadata {
                id: row.get(0)?,
                folder_id: row.get(1)?,
                title: row.get(2)?,
                preview: row.get(3)?,
                created_at: row.get(4)?,
                updated_at: row.get(5)?,
                pinned: row.get(6)?,
                sort_order: row.get(7)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(notes)
}

#[tauri::command]
fn get_note_body(db: State<Db>, id: String) -> Result<String, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let body: String = conn
        .query_row(
            "SELECT body FROM notes WHERE id = ?1",
            rusqlite::params![id],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;
    Ok(body)
}

#[tauri::command]
fn get_notes_all(db: State<Db>) -> Result<Vec<Note>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare("SELECT id, folder_id, title, body, created_at, updated_at, pinned, sort_order FROM notes")
        .map_err(|e| e.to_string())?;
    let notes = stmt
        .query_map([], |row| {
            Ok(Note {
                id: row.get(0)?,
                folder_id: row.get(1)?,
                title: row.get(2)?,
                body: row.get(3)?,
                created_at: row.get(4)?,
                updated_at: row.get(5)?,
                pinned: row.get(6)?,
                sort_order: row.get(7)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(notes)
}

#[tauri::command]
fn search_notes(db: State<Db>, query: String) -> Result<Vec<NoteMetadata>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    // FTS5 MATCH query, joined back to notes for full metadata
    let mut stmt = conn
        .prepare(
            "SELECT n.id, n.folder_id, n.title, substr(n.body, 1, 200), \
             n.created_at, n.updated_at, n.pinned, n.sort_order \
             FROM notes_fts f \
             JOIN notes n ON n.rowid = f.rowid \
             WHERE notes_fts MATCH ?1 \
             ORDER BY rank \
             LIMIT 80",
        )
        .map_err(|e| e.to_string())?;
    let notes = stmt
        .query_map(rusqlite::params![query], |row| {
            Ok(NoteMetadata {
                id: row.get(0)?,
                folder_id: row.get(1)?,
                title: row.get(2)?,
                preview: row.get(3)?,
                created_at: row.get(4)?,
                updated_at: row.get(5)?,
                pinned: row.get(6)?,
                sort_order: row.get(7)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(notes)
}

#[tauri::command]
fn create_note(
    db: State<Db>,
    id: String,
    folder_id: String,
    title: String,
    body: String,
    created_at: i64,
    updated_at: i64,
    pinned: i32,
    sort_order: i32,
) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO notes (id, folder_id, title, body, created_at, updated_at, pinned, sort_order) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        rusqlite::params![id, folder_id, title, body, created_at, updated_at, pinned, sort_order],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn update_note(
    db: State<Db>,
    id: String,
    title: String,
    body: String,
    updated_at: i64,
) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    // Guard against stale writes coming from external clients (e.g. Raycast bridge).
    let rows = conn
        .execute(
            "UPDATE notes SET title = ?1, body = ?2, updated_at = ?3 WHERE id = ?4 AND updated_at <= ?3",
            rusqlite::params![title, body, updated_at, &id],
        )
        .map_err(|e| e.to_string())?;
    if rows == 0 {
        let exists: i64 = conn
            .query_row(
                "SELECT COUNT(1) FROM notes WHERE id = ?1",
                rusqlite::params![&id],
                |row| row.get(0),
            )
            .map_err(|e| e.to_string())?;
        if exists == 0 {
            return Err("note not found".to_string());
        }
        return Err("conflict: stale note update rejected".to_string());
    }
    Ok(())
}

#[tauri::command]
fn delete_note(db: State<Db>, id: String) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM notes WHERE id = ?1", rusqlite::params![id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

// ===== Pin & reorder commands =====

#[tauri::command]
fn toggle_note_pinned(db: State<Db>, id: String, pinned: i32) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "UPDATE notes SET pinned = ?1 WHERE id = ?2",
        rusqlite::params![pinned, id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn reorder_notes(db: State<Db>, updates: Vec<(String, i32)>) -> Result<(), String> {
    if updates.is_empty() {
        return Ok(());
    }
    // IDs are app-generated alphanumeric (base36), validate to be safe
    for (id, _) in &updates {
        if !id.chars().all(|c| c.is_alphanumeric()) {
            return Err("invalid note id".to_string());
        }
    }
    let case_clauses: Vec<String> = updates
        .iter()
        .map(|(id, order)| format!("WHEN '{}' THEN {}", id, order))
        .collect();
    let ids: Vec<String> = updates.iter().map(|(id, _)| format!("'{}'", id)).collect();
    let sql = format!(
        "UPDATE notes SET sort_order = CASE id {} END WHERE id IN ({})",
        case_clauses.join(" "),
        ids.join(",")
    );
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    conn.execute(&sql, []).map_err(|e| e.to_string())?;
    Ok(())
}

// ===== Data migration command =====

// ===== Tag commands =====

#[tauri::command]
fn get_tags(db: State<Db>) -> Result<Vec<Tag>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare("SELECT id, name, color FROM tags ORDER BY name")
        .map_err(|e| e.to_string())?;
    let tags = stmt
        .query_map([], |row| {
            Ok(Tag {
                id: row.get(0)?,
                name: row.get(1)?,
                color: row.get(2)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(tags)
}

#[tauri::command]
fn create_tag(db: State<Db>, id: String, name: String, color: String) -> Result<Tag, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO tags (id, name, color) VALUES (?1, ?2, ?3)",
        rusqlite::params![id, name, color],
    )
    .map_err(|e| e.to_string())?;
    Ok(Tag { id, name, color })
}

#[tauri::command]
fn delete_tag(db: State<Db>, id: String) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM tags WHERE id = ?1", rusqlite::params![id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn add_tag_to_note(db: State<Db>, note_id: String, tag_id: String) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT OR IGNORE INTO note_tags (note_id, tag_id) VALUES (?1, ?2)",
        rusqlite::params![note_id, tag_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn remove_tag_from_note(db: State<Db>, note_id: String, tag_id: String) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "DELETE FROM note_tags WHERE note_id = ?1 AND tag_id = ?2",
        rusqlite::params![note_id, tag_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn get_tags_for_note(db: State<Db>, note_id: String) -> Result<Vec<Tag>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare("SELECT t.id, t.name, t.color FROM tags t JOIN note_tags nt ON t.id = nt.tag_id WHERE nt.note_id = ?1 ORDER BY t.name")
        .map_err(|e| e.to_string())?;
    let tags = stmt
        .query_map(rusqlite::params![note_id], |row| {
            Ok(Tag {
                id: row.get(0)?,
                name: row.get(1)?,
                color: row.get(2)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(tags)
}

#[tauri::command]
fn get_notes_by_tag(db: State<Db>, tag_id: String) -> Result<Vec<NoteMetadata>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare("SELECT n.id, n.folder_id, n.title, substr(n.body, 1, 200), n.created_at, n.updated_at, n.pinned, n.sort_order FROM notes n JOIN note_tags nt ON n.id = nt.note_id WHERE nt.tag_id = ?1")
        .map_err(|e| e.to_string())?;
    let notes = stmt
        .query_map(rusqlite::params![tag_id], |row| {
            Ok(NoteMetadata {
                id: row.get(0)?,
                folder_id: row.get(1)?,
                title: row.get(2)?,
                preview: row.get(3)?,
                created_at: row.get(4)?,
                updated_at: row.get(5)?,
                pinned: row.get(6)?,
                sort_order: row.get(7)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(notes)
}

#[tauri::command]
fn import_data(db: State<Db>, folders: Vec<Folder>, notes: Vec<Note>) -> Result<(), String> {
    let mut conn = db.0.lock().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    for folder in &folders {
        let updated = if folder.updated_at != 0 { folder.updated_at } else { folder.created_at };
        tx.execute(
            "INSERT OR IGNORE INTO folders (id, name, created_at, parent_id, updated_at) VALUES (?1, ?2, ?3, ?4, ?5)",
            rusqlite::params![folder.id, folder.name, folder.created_at, folder.parent_id, updated],
        )
        .map_err(|e| e.to_string())?;
    }
    for note in &notes {
        tx.execute(
            "INSERT OR IGNORE INTO notes (id, folder_id, title, body, created_at, updated_at, pinned, sort_order) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            rusqlite::params![note.id, note.folder_id, note.title, note.body, note.created_at, note.updated_at, note.pinned, note.sort_order],
        )
        .map_err(|e| e.to_string())?;
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

// ===== Backup command =====

#[tauri::command]
fn export_backup(db: State<Db>) -> Result<String, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;

    // Query all folders
    let mut folder_stmt = conn
        .prepare("SELECT id, name, created_at, parent_id, COALESCE(updated_at, created_at) FROM folders ORDER BY created_at")
        .map_err(|e| e.to_string())?;
    let folders: Vec<serde_json::Value> = folder_stmt
        .query_map([], |row| {
            Ok(serde_json::json!({
                "id": row.get::<_, String>(0)?,
                "name": row.get::<_, String>(1)?,
                "created_at": row.get::<_, i64>(2)?,
                "parent_id": row.get::<_, Option<String>>(3)?,
                "updated_at": row.get::<_, i64>(4)?
            }))
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;

    // Query all notes (full body)
    let mut note_stmt = conn
        .prepare("SELECT id, folder_id, title, body, created_at, updated_at, pinned, sort_order FROM notes")
        .map_err(|e| e.to_string())?;
    let notes: Vec<serde_json::Value> = note_stmt
        .query_map([], |row| {
            Ok(serde_json::json!({
                "id": row.get::<_, String>(0)?,
                "folder_id": row.get::<_, String>(1)?,
                "title": row.get::<_, String>(2)?,
                "body": row.get::<_, String>(3)?,
                "created_at": row.get::<_, i64>(4)?,
                "updated_at": row.get::<_, i64>(5)?,
                "pinned": row.get::<_, i32>(6)?,
                "sort_order": row.get::<_, i32>(7)?
            }))
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;

    let now = chrono::Local::now();
    let backup = serde_json::json!({
        "version": "1.0",
        "exportedAt": now.timestamp_millis(),
        "folders": folders,
        "notes": notes
    });

    let json_str = serde_json::to_string_pretty(&backup).map_err(|e| e.to_string())?;

    // Write to ~/.anote/backups/
    let home = dirs::home_dir().ok_or("failed to get home directory")?;
    let backups_dir = home.join(".anote").join("backups");
    std::fs::create_dir_all(&backups_dir).map_err(|e| e.to_string())?;

    let filename = format!("anote-backup-{}.json", now.format("%Y%m%d-%H%M%S"));
    let file_path = backups_dir.join(&filename);
    std::fs::write(&file_path, json_str).map_err(|e| e.to_string())?;

    Ok(file_path.to_string_lossy().to_string())
}

// ===== PDF Export command =====

#[tauri::command]
fn export_note_pdf(db: State<Db>, id: String, path: String) -> Result<(), String> {
    use printpdf::*;

    // Get note from database
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let note: (String, String) = conn
        .query_row(
            "SELECT title, body FROM notes WHERE id = ?1",
            rusqlite::params![id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(|e| e.to_string())?;
    
    let (title, body) = note;

    // Create PDF document
    let (doc, page1, layer1) = PdfDocument::new(
        &title,
        Mm(210.0),  // A4 width
        Mm(297.0),  // A4 height
        "Layer 1",
    );

    let current_layer = doc.get_page(page1).get_layer(layer1);

    // Use built-in font
    let font = doc.add_builtin_font(BuiltinFont::Helvetica).map_err(|e| e.to_string())?;
    let font_bold = doc.add_builtin_font(BuiltinFont::HelveticaBold).map_err(|e| e.to_string())?;

    // Add title
    current_layer.use_text(&title, 18.0, Mm(20.0), Mm(277.0), &font_bold);

    // Add content - simple text wrapping
    let content_lines: Vec<&str> = body.lines().collect();
    let mut y_position = 260.0;
    let line_height = 5.0;
    
    for line in content_lines {
        if y_position < 20.0 {
            break; // Stop if we run out of page space
        }
        current_layer.use_text(line, 12.0, Mm(20.0), Mm(y_position), &font);
        y_position -= line_height;
    }

    // Save the PDF
    let file = std::fs::File::create(&path).map_err(|e| e.to_string())?;
    doc.save(&mut std::io::BufWriter::new(file)).map_err(|e| e.to_string())?;

    Ok(())
}

// ===== HTML Export command =====

#[tauri::command]
fn export_note_html(db: State<Db>, id: String, path: String) -> Result<(), String> {
    use pulldown_cmark::{html, Options, Parser};

    // Get note from database
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let note: (String, String, i64, i64) = conn
        .query_row(
            "SELECT title, body, created_at, updated_at FROM notes WHERE id = ?1",
            rusqlite::params![id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .map_err(|e| e.to_string())?;
    
    let (title, body, created_at, updated_at) = note;

    // Convert markdown to HTML
    let mut options = Options::empty();
    options.insert(Options::ENABLE_TABLES);
    options.insert(Options::ENABLE_FOOTNOTES);
    options.insert(Options::ENABLE_STRIKETHROUGH);
    options.insert(Options::ENABLE_TASKLISTS);
    
    let parser = Parser::new_ext(&body, options);
    let mut html_body = String::new();
    html::push_html(&mut html_body, parser);

    // Format timestamps
    let created = chrono::DateTime::from_timestamp_millis(created_at)
        .map(|dt| dt.format("%Y-%m-%d %H:%M").to_string())
        .unwrap_or_else(|| "Unknown".to_string());
    let updated = chrono::DateTime::from_timestamp_millis(updated_at)
        .map(|dt| dt.format("%Y-%m-%d %H:%M").to_string())
        .unwrap_or_else(|| "Unknown".to_string());

    // Build the HTML document
    let html_content = format!(r#"<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>{title}</title>
    <style>
        body {{
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif;
            max-width: 800px;
            margin: 0 auto;
            padding: 40px 20px;
            line-height: 1.6;
            color: #333;
            background: #fafafa;
        }}
        h1, h2, h3, h4, h5, h6 {{
            margin-top: 1.5em;
            margin-bottom: 0.5em;
            font-weight: 600;
        }}
        h1 {{ font-size: 2em; border-bottom: 1px solid #eee; padding-bottom: 0.3em; }}
        h2 {{ font-size: 1.5em; }}
        h3 {{ font-size: 1.25em; }}
        pre {{
            background: #f4f4f4;
            padding: 16px;
            border-radius: 6px;
            overflow-x: auto;
        }}
        code {{
            font-family: 'SF Mono', Consolas, 'Liberation Mono', Menlo, monospace;
            font-size: 0.9em;
        }}
        blockquote {{
            border-left: 4px solid #ddd;
            margin: 0;
            padding-left: 16px;
            color: #666;
        }}
        table {{
            border-collapse: collapse;
            width: 100%;
            margin: 1em 0;
        }}
        th, td {{
            border: 1px solid #ddd;
            padding: 8px 12px;
            text-align: left;
        }}
        th {{ background: #f4f4f4; }}
        img {{ max-width: 100%; height: auto; }}
        a {{ color: #0066cc; }}
        .metadata {{
            color: #888;
            font-size: 0.85em;
            margin-bottom: 2em;
            padding-bottom: 1em;
            border-bottom: 1px solid #eee;
        }}
    </style>
</head>
<body>
    <h1>{title}</h1>
    <div class="metadata">
        Created: {created} | Last modified: {updated}
    </div>
    <div class="content">
{html_body}
    </div>
</body>
</html>"#);

    // Write the HTML file
    std::fs::write(&path, html_content).map_err(|e| e.to_string())?;

    Ok(())
}

fn get_sync_token_from_conn(conn: &Connection) -> Result<i64, String> {
    // A single monotonic-ish value used by the frontend to detect external DB mutations.
    conn.query_row(
        "SELECT MAX(
            COALESCE((SELECT MAX(updated_at) FROM notes), 0),
            COALESCE((SELECT MAX(COALESCE(updated_at, created_at)) FROM folders), 0)
        )",
        [],
        |row| row.get(0),
    )
    .map_err(|e| e.to_string())
}

#[tauri::command]
fn get_sync_token(db: State<Db>) -> Result<i64, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    get_sync_token_from_conn(&conn)
}

pub fn maybe_run_bridge_cli() -> bool {
    bridge_cli::maybe_run_from_args()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let db_path = db::canonical_db_path().expect("failed to resolve canonical database path");

            // Migrate from old Tauri app data path if needed
            if !db_path.exists() {
                if let Ok(app_data_dir) = app.path().app_data_dir() {
                    let old_db = app_data_dir.join("anote.db");
                    if old_db.exists() {
                        let _ = std::fs::copy(&old_db, &db_path);
                    }
                }
            }

            // Shared DB bootstrap guarantees schema parity with external writers (e.g. Raycast bridge).
            let conn = db::open_initialized_db(&db_path).expect("failed to open/initialize database");

            app.manage(Db(Mutex::new(conn)));

            // Add dialog plugin for file save dialogs
            app.handle().plugin(tauri_plugin_dialog::init());

            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_folders,
            create_folder,
            rename_folder,
            delete_folder,
            get_notes_metadata,
            get_note_body,
            get_notes_all,
            search_notes,
            create_note,
            update_note,
            delete_note,
            toggle_note_pinned,
            reorder_notes,
            get_tags,
            create_tag,
            delete_tag,
            add_tag_to_note,
            remove_tag_from_note,
            get_tags_for_note,
            get_notes_by_tag,
            import_data,
            export_backup,
            get_sync_token,
            export_note_pdf,
            export_note_html,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
