//! Native process + filesystem host for the TypeScript GrokAcpEngine bridge.
//!
//! The webview cannot spawn PE children; these Tauri commands own discovery
//! helpers, ACP stdio supervision, and project file I/O.

use std::collections::HashMap;
use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

static NEXT_PROC_ID: AtomicU32 = AtomicU32::new(1);

struct ManagedStdin {
    stdin: Option<ChildStdin>,
    pid: u32,
}

pub struct ProcRegistry {
    inner: Mutex<HashMap<u32, ManagedStdin>>,
}

impl Default for ProcRegistry {
    fn default() -> Self {
        Self {
            inner: Mutex::new(HashMap::new()),
        }
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpawnResult {
    pub id: u32,
    pub pid: u32,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StreamEvent {
    pub id: u32,
    pub text: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExitEvent {
    pub id: u32,
    pub exit_code: Option<i32>,
    pub signal: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecResult {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: i32,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileEntryDto {
    pub name: String,
    pub path: String,
    pub kind: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadFileDto {
    pub path: String,
    pub content: String,
    pub truncated: bool,
    pub size_bytes: u64,
}

fn map_err(err: impl ToString) -> String {
    err.to_string()
}

fn apply_no_window(cmd: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let _ = cmd;
}

#[tauri::command]
pub fn host_env() -> HashMap<String, String> {
    std::env::vars().collect()
}

#[tauri::command]
pub fn host_path_exists(path: String) -> bool {
    Path::new(&path).is_file()
}

#[tauri::command]
pub fn host_path_is_dir(path: String) -> bool {
    Path::new(&path).is_dir()
}

#[tauri::command]
pub fn host_path_any_exists(path: String) -> bool {
    Path::new(&path).exists()
}

#[tauri::command]
pub fn host_resolve_path(path: String) -> Result<String, String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err("empty path".into());
    }

    // Reject Unix-style paths on Windows (e.g. /tmp/demo from browser storage).
    #[cfg(windows)]
    {
        if trimmed.starts_with('/') && !trimmed.starts_with("//") {
            return Err(format!(
                "not a Windows path: {trimmed} (use e.g. C:\\\\Users\\\\…)"
            ));
        }
    }

    let p = PathBuf::from(trimmed);
    let resolved = if p.is_absolute() {
        p
    } else {
        std::env::current_dir()
            .map_err(map_err)?
            .join(p)
    };
    match fs::canonicalize(&resolved) {
        Ok(c) => {
            // Strip Windows \\?\ prefix for display / CLI cwd friendliness.
            let s = c.to_string_lossy().into_owned();
            Ok(s.strip_prefix(r"\\?\").unwrap_or(&s).to_string())
        }
        Err(_) => Ok(resolved.to_string_lossy().into_owned()),
    }
}

#[tauri::command]
pub fn host_which(command: String) -> Option<String> {
    #[cfg(windows)]
    let (bin, arg) = ("where", command.as_str());
    #[cfg(not(windows))]
    let (bin, arg) = ("which", command.as_str());

    let output = Command::new(bin).arg(arg).output().ok()?;
    if !output.status.success() {
        return None;
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    stdout
        .lines()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .map(|s| s.to_string())
}

#[tauri::command]
pub fn host_exec(
    program: String,
    args: Vec<String>,
    cwd: Option<String>,
) -> Result<ExecResult, String> {
    let mut cmd = Command::new(&program);
    cmd.args(&args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(dir) = cwd {
        cmd.current_dir(dir);
    }
    apply_no_window(&mut cmd);
    let output = cmd.output().map_err(map_err)?;
    Ok(ExecResult {
        stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
        exit_code: output.status.code().unwrap_or(-1),
    })
}

#[tauri::command]
pub fn host_list_dir(path: String) -> Result<Vec<FileEntryDto>, String> {
    let mut entries = Vec::new();
    for ent in fs::read_dir(&path).map_err(map_err)? {
        let ent = ent.map_err(map_err)?;
        let meta = ent.metadata().map_err(map_err)?;
        let kind = if meta.is_dir() { "directory" } else { "file" };
        let full = ent.path();
        entries.push(FileEntryDto {
            name: ent.file_name().to_string_lossy().into_owned(),
            path: full.to_string_lossy().into_owned(),
            kind: kind.to_string(),
        });
    }
    entries.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    Ok(entries)
}

#[tauri::command]
pub fn host_read_file(path: String, max_bytes: Option<u64>) -> Result<ReadFileDto, String> {
    let max = max_bytes.unwrap_or(256 * 1024) as usize;
    let bytes = fs::read(&path).map_err(map_err)?;
    let size = bytes.len() as u64;
    let truncated = bytes.len() > max;
    let slice = if truncated { &bytes[..max] } else { &bytes[..] };
    Ok(ReadFileDto {
        path,
        content: String::from_utf8_lossy(slice).into_owned(),
        truncated,
        size_bytes: size,
    })
}

#[tauri::command]
pub fn host_write_text(path: String, content: String) -> Result<(), String> {
    if let Some(parent) = Path::new(&path).parent() {
        if !parent.as_os_str().is_empty() {
            fs::create_dir_all(parent).map_err(map_err)?;
        }
    }
    fs::write(&path, content.as_bytes()).map_err(map_err)
}

#[tauri::command]
pub fn host_delete_file(path: String) -> Result<(), String> {
    let p = Path::new(&path);
    if p.is_dir() {
        fs::remove_dir_all(p).map_err(map_err)
    } else {
        fs::remove_file(p).map_err(map_err)
    }
}

#[tauri::command]
pub fn host_move_file(from: String, to: String) -> Result<(), String> {
    if let Some(parent) = Path::new(&to).parent() {
        if !parent.as_os_str().is_empty() {
            fs::create_dir_all(parent).map_err(map_err)?;
        }
    }
    fs::rename(&from, &to).map_err(map_err)
}

#[tauri::command]
pub fn host_taskkill(pid: u32) -> Result<bool, String> {
    #[cfg(windows)]
    {
        let mut cmd = Command::new("taskkill");
        cmd.args(["/PID", &pid.to_string(), "/T", "/F"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        apply_no_window(&mut cmd);
        let status = cmd.status().map_err(map_err)?;
        Ok(status.success() || status.code() == Some(128))
    }
    #[cfg(not(windows))]
    {
        let _ = pid;
        Err("taskkill is Windows-only".into())
    }
}

fn spawn_streaming(
    app: AppHandle,
    registry: Arc<ProcRegistry>,
    mut cmd: Command,
    with_stdin: bool,
) -> Result<SpawnResult, String> {
    if with_stdin {
        cmd.stdin(Stdio::piped());
    } else {
        cmd.stdin(Stdio::null());
    }
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
    apply_no_window(&mut cmd);

    let mut child = cmd.spawn().map_err(|e| {
        eprintln!("[engine_host] spawn failed: {e}");
        format!("spawn failed: {e}")
    })?;
    let pid = child.id();
    eprintln!("[engine_host] spawned pid={pid} with_stdin={with_stdin}");
    let stdin = if with_stdin {
        child.stdin.take()
    } else {
        None
    };
    let stdout = child.stdout.take().ok_or("missing stdout")?;
    let stderr = child.stderr.take().ok_or("missing stderr")?;

    let id = NEXT_PROC_ID.fetch_add(1, Ordering::Relaxed);
    {
        let mut guard = registry.inner.lock().map_err(map_err)?;
        guard.insert(id, ManagedStdin { stdin, pid });
    }

    let app_out = app.clone();
    thread::spawn(move || {
        let reader = BufReader::new(stdout);
        for line in reader.lines().flatten() {
            let _ = app_out.emit("engine-stdout", StreamEvent { id, text: line });
        }
    });

    let app_err = app.clone();
    thread::spawn(move || {
        let reader = BufReader::new(stderr);
        for line in reader.lines().flatten() {
            let _ = app_err.emit(
                "engine-stderr",
                StreamEvent {
                    id,
                    text: format!("{line}\n"),
                },
            );
        }
    });

    let reg_wait = Arc::clone(&registry);
    let app_wait = app;
    thread::spawn(move || {
        let status = child.wait();
        {
            let mut guard = match reg_wait.inner.lock() {
                Ok(g) => g,
                Err(_) => return,
            };
            guard.remove(&id);
        }
        let exit_code = status.ok().and_then(|s| s.code());
        let _ = app_wait.emit(
            "engine-exit",
            ExitEvent {
                id,
                exit_code,
                signal: None,
            },
        );
    });

    Ok(SpawnResult { id, pid })
}

#[tauri::command]
pub fn engine_spawn(
    app: AppHandle,
    registry: State<'_, Arc<ProcRegistry>>,
    command: String,
    args: Vec<String>,
    env: HashMap<String, String>,
) -> Result<SpawnResult, String> {
    eprintln!(
        "[engine_host] engine_spawn command={command} args={args:?} env_keys={}",
        env.len()
    );
    let mut cmd = Command::new(&command);
    cmd.args(&args).envs(env);
    spawn_streaming(app, Arc::clone(&registry), cmd, true)
}

#[tauri::command]
pub fn engine_write(
    registry: State<'_, Arc<ProcRegistry>>,
    id: u32,
    line: String,
) -> Result<(), String> {
    let mut guard = registry.inner.lock().map_err(map_err)?;
    let proc = guard
        .get_mut(&id)
        .ok_or_else(|| format!("unknown process id {id}"))?;
    let stdin = proc
        .stdin
        .as_mut()
        .ok_or_else(|| format!("process {id} has no stdin"))?;
    let payload = if line.ends_with('\n') {
        line
    } else {
        format!("{line}\n")
    };
    stdin.write_all(payload.as_bytes()).map_err(map_err)?;
    stdin.flush().map_err(map_err)
}

#[tauri::command]
pub fn engine_kill(
    registry: State<'_, Arc<ProcRegistry>>,
    id: u32,
) -> Result<(), String> {
    let mut guard = registry.inner.lock().map_err(map_err)?;
    if let Some(mut managed) = guard.remove(&id) {
        // Drop stdin to signal EOF to the child when possible.
        drop(managed.stdin.take());
        let pid = managed.pid;
        #[cfg(windows)]
        {
            let mut cmd = Command::new("taskkill");
            cmd.args(["/PID", &pid.to_string(), "/T", "/F"])
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null());
            apply_no_window(&mut cmd);
            let _ = cmd.status();
        }
        #[cfg(not(windows))]
        {
            let _ = pid;
        }
    }
    Ok(())
}

#[tauri::command]
pub fn terminal_spawn(
    app: AppHandle,
    registry: State<'_, Arc<ProcRegistry>>,
    command: String,
    args: Vec<String>,
    cwd: Option<String>,
    env: HashMap<String, String>,
    shell: bool,
) -> Result<SpawnResult, String> {
    let mut cmd = if shell {
        #[cfg(windows)]
        {
            let mut c = Command::new("cmd");
            let joined = if args.is_empty() {
                command.clone()
            } else {
                format!("{command} {}", args.join(" "))
            };
            c.args(["/C", &joined]);
            c
        }
        #[cfg(not(windows))]
        {
            let mut c = Command::new("sh");
            let joined = if args.is_empty() {
                command.clone()
            } else {
                format!("{command} {}", args.join(" "))
            };
            c.args(["-c", &joined]);
            c
        }
    } else {
        let mut c = Command::new(&command);
        c.args(&args);
        c
    };

    cmd.envs(env);
    if let Some(dir) = cwd {
        cmd.current_dir(dir);
    }
    spawn_streaming(app, Arc::clone(&registry), cmd, false)
}
