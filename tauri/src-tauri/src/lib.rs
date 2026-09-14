use std::fs;
use std::path::PathBuf;

use tauri::ipc::Response;

fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(v) = u8::from_str_radix(
                std::str::from_utf8(&bytes[i + 1..i + 3]).unwrap_or(""),
                16,
            ) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Native drop / file-association paths may arrive as `file://` URLs or `\\?\` prefixes.
fn normalize_document_path(raw: &str) -> PathBuf {
    let mut s = raw.trim().trim_matches('"').to_string();
    if s.get(..5).is_some_and(|h| h.eq_ignore_ascii_case("file:")) {
        if let Some(idx) = s.find("://") {
            s = s[idx + 3..].to_string();
        } else if let Some(idx) = s.find(':') {
            s = s[idx + 1..].to_string();
        }
        if s.get(..9).is_some_and(|h| h.eq_ignore_ascii_case("localhost")) {
            s = s[9..].to_string();
        }
        s = percent_decode(&s);
        #[cfg(windows)]
        {
            if s.starts_with('/') && s.len() >= 3 {
                let chars: Vec<char> = s.chars().collect();
                if chars.len() >= 3 && chars[2] == ':' {
                    s.remove(0);
                }
            }
            s = s.replace('/', "\\");
        }
    }
    if let Some(rest) = s.strip_prefix(r"\\?\") {
        s = rest.to_string();
    }
    PathBuf::from(s)
}

fn data_dir() -> PathBuf {
    #[cfg(windows)]
    {
        let root = std::env::var("APPDATA").unwrap_or_else(|_| ".".into());
        PathBuf::from(root).join("Paperweight")
    }
    #[cfg(target_os = "macos")]
    {
        let home = std::env::var("HOME").unwrap_or_else(|_| ".".into());
        PathBuf::from(home)
            .join("Library")
            .join("Application Support")
            .join("Paperweight")
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    {
        let home = std::env::var("HOME").unwrap_or_else(|_| ".".into());
        PathBuf::from(home).join(".paperweight")
    }
}

fn marks_path() -> PathBuf {
    data_dir().join("marks.json")
}

fn last_path_file() -> PathBuf {
    data_dir().join("last-path.txt")
}

fn is_pdf_or_epub(path: &std::path::Path) -> bool {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    ext == "pdf" || ext == "epub"
}

#[tauri::command]
fn document_exists(path: String) -> bool {
    let p = normalize_document_path(&path);
    is_pdf_or_epub(&p) && p.is_file()
}

#[tauri::command]
fn load_last_path() -> Result<String, String> {
    let path = last_path_file();
    if !path.is_file() {
        return Ok(String::new());
    }
    let raw = fs::read_to_string(path).map_err(|e| e.to_string())?;
    Ok(raw.trim().to_string())
}

#[tauri::command]
fn save_last_path(path: String) -> Result<(), String> {
    let dir = data_dir();
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let trimmed = path.trim();
    if trimmed.is_empty() {
        let _ = fs::remove_file(last_path_file());
        return Ok(());
    }
    fs::write(last_path_file(), trimmed).map_err(|e| e.to_string())
}

#[tauri::command]
fn read_document(path: String) -> Result<Response, String> {
    let p = normalize_document_path(&path);
    if !is_pdf_or_epub(&p) {
        return Err("This preview opens PDF and EPUB files.".into());
    }
    let bytes = fs::read(&p).map_err(|e| e.to_string())?;
    if bytes.is_empty() {
        return Err("That file is empty.".into());
    }
    Ok(Response::new(bytes))
}

#[tauri::command]
fn load_marks() -> Result<String, String> {
    let path = marks_path();
    if !path.is_file() {
        return Ok("{}".into());
    }
    fs::read_to_string(path).map_err(|e| e.to_string())
}

#[tauri::command]
fn save_marks(json: String) -> Result<(), String> {
    let dir = data_dir();
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    fs::write(marks_path(), json).map_err(|e| e.to_string())
}

#[tauri::command]
fn write_clipboard(text: String) -> Result<(), String> {
    #[cfg(windows)]
    {
        use std::io::Write;
        use std::process::{Command, Stdio};
        let mut child = Command::new("powershell")
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                "Set-Clipboard -Value ([Console]::In.ReadToEnd())",
            ])
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| e.to_string())?;
        if let Some(mut stdin) = child.stdin.take() {
            stdin.write_all(text.as_bytes()).map_err(|e| e.to_string())?;
        }
        let status = child.wait().map_err(|e| e.to_string())?;
        if status.success() {
            Ok(())
        } else {
            Err("Could not write clipboard.".into())
        }
    }
    #[cfg(target_os = "macos")]
    {
        use std::io::Write;
        use std::process::{Command, Stdio};
        let mut child = Command::new("pbcopy")
            .stdin(Stdio::piped())
            .spawn()
            .map_err(|e| e.to_string())?;
        if let Some(mut stdin) = child.stdin.take() {
            stdin.write_all(text.as_bytes()).map_err(|e| e.to_string())?;
        }
        let status = child.wait().map_err(|e| e.to_string())?;
        if status.success() {
            Ok(())
        } else {
            Err("Could not write clipboard.".into())
        }
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    {
        let _ = text;
        Err("Clipboard write is not available.".into())
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            document_exists,
            load_last_path,
            save_last_path,
            read_document,
            load_marks,
            save_marks,
            write_clipboard
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::{document_exists, normalize_document_path};
    use std::fs;
    use std::path::PathBuf;

    #[test]
    fn keeps_windows_native_path() {
        let p = normalize_document_path(r"C:\Users\Mark\Doc.pdf");
        assert_eq!(p, PathBuf::from(r"C:\Users\Mark\Doc.pdf"));
    }

    #[test]
    fn unwraps_file_url() {
        let p = normalize_document_path("file:///C:/Users/Mark/Doc.pdf");
        let s = p.to_string_lossy();
        assert!(s.contains("Doc.pdf"), "{s}");
        assert!(!s.to_ascii_lowercase().starts_with("file:"), "{s}");
    }

    #[test]
    fn strips_extended_prefix() {
        let p = normalize_document_path(r"\\?\C:\Users\Mark\Doc.epub");
        assert_eq!(p, PathBuf::from(r"C:\Users\Mark\Doc.epub"));
    }

    #[test]
    fn document_exists_rejects_missing_and_wrong_type() {
        assert!(!document_exists(r"Z:\no-such-paperweight-file.pdf".into()));
        assert!(!document_exists(r"C:\Users\Mark\notes.txt".into()));
    }

    #[test]
    fn document_exists_true_for_real_pdf() {
        let p = std::env::temp_dir().join("paperweight_exists_test.pdf");
        fs::write(&p, b"%PDF-1.1\n").unwrap();
        assert!(document_exists(p.to_string_lossy().into_owned()));
        let _ = fs::remove_file(&p);
    }
}

