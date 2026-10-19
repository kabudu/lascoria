//! OS boundaries shared by the desktop and supervisor. No network-facing control socket.
#[cfg(unix)]
use std::os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt};
use std::{
    fs::{self, File, OpenOptions},
    io,
    path::Path,
};

pub fn private_dir(path: &Path) -> io::Result<()> {
    fs::create_dir_all(path)?;
    let meta = fs::symlink_metadata(path)?;
    if !meta.is_dir() || meta.is_symlink() {
        return Err(io::Error::other("Private directory cannot be a link"));
    }
    #[cfg(unix)]
    {
        if meta.uid() != unsafe { libc::geteuid() } {
            return Err(io::Error::other(
                "Private directory belongs to another user",
            ));
        }
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
    }
    #[cfg(windows)]
    windows::protect(path)?;
    Ok(())
}
pub fn private_file(path: &Path, truncate: bool) -> io::Result<File> {
    let mut options = OpenOptions::new();
    options.read(true).write(true).create(true).truncate(false);
    #[cfg(unix)]
    options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        // Opening the reparse point itself prevents following a pre-existing file link.
        options.custom_flags(0x00200000);
    }
    let file = options.open(path)?;
    let meta = file.metadata()?;
    if !meta.is_file() {
        return Err(io::Error::other("Private file must be regular"));
    }
    #[cfg(unix)]
    {
        if meta.uid() != unsafe { libc::geteuid() } {
            return Err(io::Error::other("Private file belongs to another user"));
        }
        file.set_permissions(fs::Permissions::from_mode(0o600))?;
    }
    #[cfg(windows)]
    windows::protect(path)?;
    if truncate {
        file.set_len(0)?;
    }
    Ok(file)
}
#[cfg(unix)]
pub type Stream = tokio::net::UnixStream;
#[cfg(windows)]
pub type Stream = tokio::net::windows::named_pipe::NamedPipeServer;
#[cfg(unix)]
pub struct Listener(tokio::net::UnixListener);
#[cfg(windows)]
pub struct Listener {
    pipe: Option<Stream>,
    name: String,
}
impl Listener {
    pub fn bind(root: &Path) -> io::Result<Self> {
        #[cfg(unix)]
        {
            let path = root.join("supervisor.sock");
            if path.exists() {
                fs::remove_file(&path)?;
            }
            let listener = tokio::net::UnixListener::bind(&path)?;
            fs::set_permissions(&path, fs::Permissions::from_mode(0o600))?;
            Ok(Self(listener))
        }
        #[cfg(windows)]
        {
            // A fresh unguessable name prevents another user squatting a stale endpoint.
            // The endpoint file is readable only by the owner; clients also verify server SID.
            let mut random = [0u8; 32];
            getrandom::fill(&mut random).map_err(io::Error::other)?;
            let suffix: String = random.iter().map(|b| format!("{b:02x}")).collect();
            let name = format!(r"\\.\pipe\lascoria-{suffix}");
            let pipe = windows::pipe(&name, true)?;
            use std::io::Write;
            let mut file = private_file(&root.join("ipc.json"), true)?;
            file.write_all(serde_json::json!({"pipe":name}).to_string().as_bytes())?;
            file.sync_all()?;
            Ok(Self {
                pipe: Some(pipe),
                name,
            })
        }
    }
    pub async fn accept(&mut self) -> io::Result<Stream> {
        #[cfg(unix)]
        {
            self.0.accept().await.map(|v| v.0)
        }
        #[cfg(windows)]
        {
            self.pipe.as_ref().unwrap().connect().await?;
            let next = windows::pipe(&self.name, false)?;
            Ok(self.pipe.replace(next).unwrap())
        }
    }
}
#[cfg(unix)]
pub async fn connect(root: &Path) -> io::Result<tokio::net::UnixStream> {
    tokio::net::UnixStream::connect(root.join("supervisor.sock")).await
}
#[cfg(windows)]
pub async fn connect(root: &Path) -> io::Result<tokio::net::windows::named_pipe::NamedPipeClient> {
    use tokio::net::windows::named_pipe::ClientOptions;
    let value: serde_json::Value = serde_json::from_slice(&fs::read(root.join("ipc.json"))?)?;
    let name = value["pipe"]
        .as_str()
        .filter(|v| {
            v.strip_prefix(r"\\.\pipe\lascoria-").is_some_and(|suffix| {
                suffix.len() == 64 && suffix.bytes().all(|b| b.is_ascii_hexdigit())
            })
        })
        .ok_or_else(|| io::Error::other("Invalid local pipe endpoint"))?;
    for _ in 0..40 {
        match ClientOptions::new().open(name) {
            Err(e) if e.raw_os_error() == Some(231) => {
                tokio::time::sleep(std::time::Duration::from_millis(25)).await
            }
            Ok(client) => {
                windows::verify_server(&client)?;
                return Ok(client);
            }
            Err(error) => return Err(error),
        }
    }
    Err(io::Error::other("Local control pipe remains busy"))
}
pub fn check_peer(stream: &Stream) -> io::Result<()> {
    #[cfg(unix)]
    if stream.peer_cred()?.uid() != unsafe { libc::geteuid() } {
        return Err(io::Error::other("IPC peer belongs to another user"));
    }
    // Windows enforces the current user's SID in the named-pipe DACL, plus the token handshake.
    #[cfg(windows)]
    let _ = stream;
    Ok(())
}
/// Process ID of the connected peer. `None` where the platform cannot report it.
pub fn peer_pid(stream: &Stream) -> io::Result<Option<u32>> {
    #[cfg(unix)]
    {
        Ok(stream.peer_cred()?.pid().map(|pid| pid as u32))
    }
    #[cfg(windows)]
    {
        use std::os::windows::io::AsRawHandle;
        let mut pid = 0;
        if unsafe {
            windows_sys::Win32::System::Pipes::GetNamedPipeClientProcessId(
                stream.as_raw_handle(),
                &mut pid,
            )
        } == 0
        {
            return Err(io::Error::last_os_error());
        }
        Ok(Some(pid))
    }
}
/// Executable of the connected peer process, for binding control authority to an installed
/// binary rather than to a file any same-user process can read. `None` where the platform
/// cannot report the peer process.
pub fn peer_executable(stream: &Stream) -> io::Result<Option<std::path::PathBuf>> {
    peer_pid(stream)?.map(process_executable).transpose()
}
/// Signs that another program is steering a process from outside (F1 residual): a tracer
/// attached, or libraries forced into it when it was launched. Reported for Linux, where a
/// same-user program can otherwise start the desktop app with `LD_PRELOAD` or under
/// `ptrace`; macOS hardened-runtime builds refuse both for signed apps, and Windows offers
/// no equivalent check, so elsewhere this reports nothing.
#[cfg(target_os = "linux")]
pub fn process_interference(pid: u32) -> io::Result<Option<&'static str>> {
    let status = fs::read_to_string(format!("/proc/{pid}/status"))?;
    if status
        .lines()
        .filter_map(|line| line.strip_prefix("TracerPid:"))
        .any(|tracer| tracer.trim() != "0")
    {
        return Ok(Some("another program is tracing it"));
    }
    let environ = fs::read(format!("/proc/{pid}/environ"))?;
    if environ.split(|b| *b == 0).any(|entry| {
        [b"LD_PRELOAD=".as_slice(), b"LD_AUDIT="]
            .iter()
            .any(|name| entry.starts_with(name) && entry.len() > name.len())
    }) {
        return Ok(Some("it was started with injected libraries"));
    }
    Ok(None)
}
#[cfg(not(target_os = "linux"))]
pub fn process_interference(_pid: u32) -> io::Result<Option<&'static str>> {
    Ok(None)
}
/// The parent of a running process, for binding a session helper to the Muse host that
/// started it.
#[cfg(target_os = "linux")]
pub fn parent_pid(pid: u32) -> io::Result<u32> {
    // Field 4 of /proc/<pid>/stat, after the parenthesised command name (which may itself
    // contain spaces or parentheses, so split at the last ')').
    let stat = fs::read_to_string(format!("/proc/{pid}/stat"))?;
    stat.rsplit_once(')')
        .and_then(|(_, rest)| rest.split_whitespace().nth(1))
        .and_then(|ppid| ppid.parse().ok())
        .ok_or_else(|| io::Error::other("Unreadable process status"))
}
#[cfg(target_os = "macos")]
pub fn parent_pid(pid: u32) -> io::Result<u32> {
    let mut info: libc::proc_bsdinfo = unsafe { std::mem::zeroed() };
    let size = std::mem::size_of::<libc::proc_bsdinfo>() as libc::c_int;
    let read = unsafe {
        libc::proc_pidinfo(
            pid as libc::c_int,
            libc::PROC_PIDTBSDINFO,
            0,
            (&mut info as *mut libc::proc_bsdinfo).cast(),
            size,
        )
    };
    if read != size {
        return Err(io::Error::last_os_error());
    }
    Ok(info.pbi_ppid)
}
#[cfg(all(unix, not(any(target_os = "linux", target_os = "macos"))))]
pub fn parent_pid(_pid: u32) -> io::Result<u32> {
    Err(io::Error::other(
        "Parent process lookup is unsupported on this platform",
    ))
}
#[cfg(windows)]
pub fn parent_pid(pid: u32) -> io::Result<u32> {
    use std::os::windows::io::{FromRawHandle, OwnedHandle};
    use windows_sys::Win32::{
        Foundation::INVALID_HANDLE_VALUE,
        System::Diagnostics::ToolHelp::{
            CreateToolhelp32Snapshot, PROCESSENTRY32W, Process32FirstW, Process32NextW,
            TH32CS_SNAPPROCESS,
        },
    };
    unsafe {
        let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if snapshot == INVALID_HANDLE_VALUE {
            return Err(io::Error::last_os_error());
        }
        let _snapshot = OwnedHandle::from_raw_handle(snapshot);
        let mut entry: PROCESSENTRY32W = std::mem::zeroed();
        entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
        let mut more = Process32FirstW(snapshot, &mut entry) != 0;
        while more {
            if entry.th32ProcessID == pid {
                return Ok(entry.th32ParentProcessID);
            }
            more = Process32NextW(snapshot, &mut entry) != 0;
        }
    }
    Err(io::Error::other("Process not found"))
}
/// The path the operating system resolved for an already open file. Checking this after
/// opening closes the window in which a checked path is swapped for a link (F3).
#[cfg(target_os = "linux")]
pub fn opened_path(file: &File) -> io::Result<std::path::PathBuf> {
    use std::os::fd::AsRawFd;
    fs::read_link(format!("/proc/self/fd/{}", file.as_raw_fd()))
}
#[cfg(target_os = "macos")]
pub fn opened_path(file: &File) -> io::Result<std::path::PathBuf> {
    use std::os::{fd::AsRawFd, unix::ffi::OsStringExt};
    let mut buffer = vec![0u8; libc::PATH_MAX as usize];
    if unsafe { libc::fcntl(file.as_raw_fd(), libc::F_GETPATH, buffer.as_mut_ptr()) } == -1 {
        return Err(io::Error::last_os_error());
    }
    let length = buffer.iter().position(|b| *b == 0).unwrap_or(buffer.len());
    buffer.truncate(length);
    Ok(std::ffi::OsString::from_vec(buffer).into())
}
#[cfg(all(unix, not(any(target_os = "linux", target_os = "macos"))))]
pub fn opened_path(_file: &File) -> io::Result<std::path::PathBuf> {
    Err(io::Error::other(
        "Open-file path lookup is unsupported on this platform",
    ))
}
#[cfg(windows)]
pub fn opened_path(file: &File) -> io::Result<std::path::PathBuf> {
    use std::os::windows::{ffi::OsStringExt, io::AsRawHandle};
    use windows_sys::Win32::Storage::FileSystem::{
        FILE_NAME_NORMALIZED, GetFinalPathNameByHandleW,
    };
    let mut buffer = vec![0u16; 32768];
    let length = unsafe {
        GetFinalPathNameByHandleW(
            file.as_raw_handle(),
            buffer.as_mut_ptr(),
            buffer.len() as u32,
            FILE_NAME_NORMALIZED,
        )
    };
    if length == 0 || length as usize >= buffer.len() {
        return Err(io::Error::last_os_error());
    }
    buffer.truncate(length as usize);
    Ok(std::ffi::OsString::from_wide(&buffer).into())
}
#[cfg(target_os = "linux")]
pub fn process_executable(pid: u32) -> io::Result<std::path::PathBuf> {
    fs::read_link(format!("/proc/{pid}/exe"))
}
#[cfg(target_os = "macos")]
pub fn process_executable(pid: u32) -> io::Result<std::path::PathBuf> {
    use std::os::unix::ffi::OsStringExt;
    let mut buffer = vec![0u8; libc::PROC_PIDPATHINFO_MAXSIZE as usize];
    let length = unsafe {
        libc::proc_pidpath(
            pid as libc::c_int,
            buffer.as_mut_ptr().cast(),
            buffer.len() as u32,
        )
    };
    if length <= 0 {
        return Err(io::Error::last_os_error());
    }
    buffer.truncate(length as usize);
    Ok(std::ffi::OsString::from_vec(buffer).into())
}
#[cfg(all(unix, not(any(target_os = "linux", target_os = "macos"))))]
pub fn process_executable(_pid: u32) -> io::Result<std::path::PathBuf> {
    Err(io::Error::other(
        "Peer executable lookup is unsupported on this platform",
    ))
}
#[cfg(windows)]
pub fn process_executable(pid: u32) -> io::Result<std::path::PathBuf> {
    use std::os::windows::{
        ffi::OsStringExt,
        io::{AsRawHandle, FromRawHandle, OwnedHandle},
    };
    use windows_sys::Win32::System::Threading::{
        OpenProcess, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
        QueryFullProcessImageNameW,
    };
    unsafe {
        let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if process.is_null() {
            return Err(io::Error::last_os_error());
        }
        let process = OwnedHandle::from_raw_handle(process);
        let mut buffer = vec![0u16; 32768];
        let mut length = buffer.len() as u32;
        if QueryFullProcessImageNameW(
            process.as_raw_handle(),
            PROCESS_NAME_WIN32,
            buffer.as_mut_ptr(),
            &mut length,
        ) == 0
        {
            return Err(io::Error::last_os_error());
        }
        buffer.truncate(length as usize);
        Ok(std::ffi::OsString::from_wide(&buffer).into())
    }
}
pub async fn terminate_signal() {
    #[cfg(unix)]
    {
        if let Ok(mut signal) =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
        {
            signal.recv().await;
        }
    }
    #[cfg(windows)]
    std::future::pending::<()>().await;
}
#[cfg(windows)]
mod windows {
    use super::*;
    use std::{
        os::windows::{ffi::OsStrExt, fs::MetadataExt},
        ptr::{null, null_mut},
    };
    use windows_sys::Win32::{
        Foundation::{CloseHandle, LocalFree},
        Security::{Authorization::*, *},
        System::{
            Pipes::GetNamedPipeServerProcessId,
            Threading::{
                GetCurrentProcess, OpenProcess, OpenProcessToken, PROCESS_QUERY_LIMITED_INFORMATION,
            },
        },
    };
    struct Local(*mut std::ffi::c_void);
    impl Drop for Local {
        fn drop(&mut self) {
            unsafe {
                LocalFree(self.0);
            }
        }
    }
    fn user() -> io::Result<Vec<usize>> {
        user_for(unsafe { GetCurrentProcess() })
    }
    fn user_for(process: windows_sys::Win32::Foundation::HANDLE) -> io::Result<Vec<usize>> {
        unsafe {
            let mut token = null_mut();
            if OpenProcessToken(process, TOKEN_QUERY, &mut token) == 0 {
                return Err(io::Error::last_os_error());
            }
            let mut size = 0;
            GetTokenInformation(token, TokenUser, null_mut(), 0, &mut size);
            let mut data = vec![0usize; (size as usize).div_ceil(std::mem::size_of::<usize>())];
            let ok =
                GetTokenInformation(token, TokenUser, data.as_mut_ptr().cast(), size, &mut size);
            let error = io::Error::last_os_error();
            CloseHandle(token);
            if ok == 0 {
                return Err(error);
            }
            Ok(data)
        }
    }
    pub fn verify_server(
        client: &tokio::net::windows::named_pipe::NamedPipeClient,
    ) -> io::Result<()> {
        use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
        unsafe {
            let mut pid = 0;
            if GetNamedPipeServerProcessId(client.as_raw_handle(), &mut pid) == 0 {
                return Err(io::Error::last_os_error());
            }
            let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
            if process.is_null() {
                return Err(io::Error::last_os_error());
            }
            let process = OwnedHandle::from_raw_handle(process);
            let server = user_for(process.as_raw_handle())?;
            let current = user()?;
            if EqualSid(
                (*(server.as_ptr().cast::<TOKEN_USER>())).User.Sid,
                (*(current.as_ptr().cast::<TOKEN_USER>())).User.Sid,
            ) == 0
            {
                return Err(io::Error::other(
                    "Control pipe server belongs to another user",
                ));
            }
            Ok(())
        }
    }
    fn descriptor() -> io::Result<Local> {
        unsafe {
            let user = user()?;
            let sid = (*(user.as_ptr().cast::<TOKEN_USER>())).User.Sid;
            let mut sid_string = null_mut();
            if ConvertSidToStringSidW(sid, &mut sid_string) == 0 {
                return Err(io::Error::last_os_error());
            }
            let _string = Local(sid_string.cast());
            let mut len = 0;
            while *sid_string.add(len) != 0 {
                len += 1;
            }
            let sid = String::from_utf16_lossy(std::slice::from_raw_parts(sid_string, len));
            let text: Vec<u16> = format!("D:P(A;OICI;FA;;;{sid})(A;OICI;FA;;;SY)")
                .encode_utf16()
                .chain(Some(0))
                .collect();
            let mut descriptor = null_mut();
            if ConvertStringSecurityDescriptorToSecurityDescriptorW(
                text.as_ptr(),
                1,
                &mut descriptor,
                null_mut(),
            ) == 0
            {
                return Err(io::Error::last_os_error());
            }
            Ok(Local(descriptor))
        }
    }
    pub fn protect(path: &Path) -> io::Result<()> {
        if fs::symlink_metadata(path)?.file_attributes() & 0x400 != 0 {
            return Err(io::Error::other("Private state cannot be a reparse point"));
        }
        let name: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
        unsafe {
            let mut owner = null_mut();
            let mut existing = null_mut();
            let status = GetNamedSecurityInfoW(
                name.as_ptr(),
                SE_FILE_OBJECT,
                OWNER_SECURITY_INFORMATION,
                &mut owner,
                null_mut(),
                null_mut(),
                null_mut(),
                &mut existing,
            );
            if status != 0 {
                return Err(io::Error::from_raw_os_error(status as i32));
            }
            let _existing = Local(existing);
            let user = user()?;
            if EqualSid(owner, (*(user.as_ptr().cast::<TOKEN_USER>())).User.Sid) == 0 {
                return Err(io::Error::other("Private state belongs to another user"));
            }
            let descriptor = descriptor()?;
            let mut dacl = null_mut();
            let mut present = 0;
            let mut defaulted = 0;
            if GetSecurityDescriptorDacl(descriptor.0, &mut present, &mut dacl, &mut defaulted) == 0
                || present == 0
                || dacl.is_null()
            {
                return Err(io::Error::other("Private state DACL unavailable"));
            }
            let status = SetNamedSecurityInfoW(
                name.as_ptr(),
                SE_FILE_OBJECT,
                DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
                null_mut(),
                null_mut(),
                dacl,
                null(),
            );
            if status != 0 {
                return Err(io::Error::from_raw_os_error(status as i32));
            }
            Ok(())
        }
    }
    pub fn pipe(name: &str, first: bool) -> io::Result<Stream> {
        use tokio::net::windows::named_pipe::ServerOptions;
        let descriptor = descriptor()?;
        let mut attrs = SECURITY_ATTRIBUTES {
            nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: descriptor.0,
            bInheritHandle: 0,
        };
        unsafe {
            ServerOptions::new()
                .first_pipe_instance(first)
                .reject_remote_clients(true)
                .create_with_security_attributes_raw(
                    name,
                    (&mut attrs as *mut SECURITY_ATTRIBUTES).cast(),
                )
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(target_os = "linux")]
    #[test]
    fn notices_a_process_started_with_injected_libraries() -> io::Result<()> {
        let start = |preload: Option<&str>| {
            let mut command = std::process::Command::new("sleep");
            command.arg("5").env_remove("LD_PRELOAD");
            if let Some(library) = preload {
                // A missing library only prints a loader warning; the process still runs.
                command
                    .env("LD_PRELOAD", library)
                    .stderr(std::process::Stdio::null());
            }
            command.spawn()
        };
        let mut clean = start(None)?;
        let mut injected = start(Some("/nonexistent/lascoria-test.so"))?;
        // Read after both have replaced the forked image with `sleep`.
        std::thread::sleep(std::time::Duration::from_millis(300));
        let result = (
            process_interference(clean.id()),
            process_interference(injected.id()),
        );
        for child in [&mut clean, &mut injected] {
            let _ = child.kill();
            let _ = child.wait();
        }
        assert_eq!(result.0?, None);
        assert!(result.1?.is_some());
        assert_eq!(
            parent_pid(std::process::id())?,
            std::os::unix::process::parent_id()
        );
        Ok(())
    }
    #[tokio::test]
    async fn local_channel_and_private_state_roundtrip() -> io::Result<()> {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let root = std::env::temp_dir().join(format!("lascoria-platform-{}", std::process::id()));
        private_dir(&root)?;
        let result = async {
            let mut file = private_file(&root.join("token"), true)?;
            use std::io::Write;
            file.write_all(b"fixture")?;
            let mut listener = Listener::bind(&root)?;
            let server = tokio::spawn(async move {
                let mut stream = listener.accept().await?;
                check_peer(&stream)?;
                let mut bytes = [0; 4];
                stream.read_exact(&mut bytes).await?;
                if &bytes != b"ping" {
                    return Err(io::Error::other("Unexpected request"));
                }
                stream.write_all(b"pong").await?;
                Ok::<_, io::Error>(())
            });
            let mut client = connect(&root).await?;
            client.write_all(b"ping").await?;
            let mut bytes = [0; 4];
            client.read_exact(&mut bytes).await?;
            assert_eq!(&bytes, b"pong");
            server.await??;
            Ok(())
        }
        .await;
        let _ = fs::remove_dir_all(root);
        result
    }
    #[cfg(unix)]
    #[test]
    fn refuses_private_state_symlinks() -> io::Result<()> {
        use std::os::unix::fs::symlink;
        let root = std::env::temp_dir().join(format!("lascoria-private-{}", std::process::id()));
        fs::create_dir_all(&root)?;
        let target = root.join("real");
        fs::write(&target, "keep")?;
        let link = root.join("link");
        symlink(&target, &link)?;
        assert!(private_file(&link, true).is_err());
        assert_eq!(fs::read_to_string(&target)?, "keep");
        fs::remove_dir_all(root)
    }
}
