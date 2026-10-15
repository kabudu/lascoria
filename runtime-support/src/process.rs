//! A trusted Windows helper joins a kill-on-close job before it launches user code.
#[cfg(windows)]
pub fn workspace_helper() -> std::io::Result<bool> {
    use std::{
        mem::{size_of, zeroed},
        ptr::null,
    };
    use windows_sys::Win32::System::{JobObjects::*, Threading::GetCurrentProcess};
    if std::env::args().nth(1).as_deref() != Some("--workspace-job") {
        return Ok(false);
    }
    let command = std::env::args()
        .nth(2)
        .ok_or_else(|| std::io::Error::other("Test command missing"))?;
    // The non-inheritable handle lives for the helper lifetime. On helper termination,
    // Windows closes it and terminates every descendant before the job can outlive it.
    unsafe {
        let job = CreateJobObjectW(null(), null());
        if job.is_null() {
            return Err(std::io::Error::last_os_error());
        }
        let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = zeroed();
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        if SetInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            (&info as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
            size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        ) == 0
            || AssignProcessToJobObject(job, GetCurrentProcess()) == 0
        {
            let error = std::io::Error::last_os_error();
            windows_sys::Win32::Foundation::CloseHandle(job);
            return Err(error);
        }
    }
    // Only the supervisor holds the write end. EOF also covers a hard supervisor crash.
    std::thread::spawn(|| {
        use std::io::Read;
        let mut byte = [0];
        let _ = std::io::stdin().read(&mut byte);
        unsafe {
            windows_sys::Win32::System::Threading::TerminateProcess(GetCurrentProcess(), 1);
        }
    });
    let shell = std::path::PathBuf::from(
        std::env::var_os("SystemRoot").unwrap_or_else(|| "C:\\Windows".into()),
    )
    .join("System32")
    .join("cmd.exe");
    use std::os::windows::process::CommandExt;
    let status = std::process::Command::new(shell)
        .args(["/D", "/S", "/C"])
        .raw_arg(format!("\"{command}\""))
        .stdin(std::process::Stdio::null())
        .status()?;
    std::process::exit(status.code().unwrap_or(1));
}
#[cfg(windows)]
pub struct ProcessTree {
    handle: std::os::windows::io::OwnedHandle,
    _liveness: tokio::process::ChildStdin,
}
#[cfg(windows)]
impl ProcessTree {
    pub fn new(child: &mut tokio::process::Child) -> std::io::Result<Self> {
        use std::{os::windows::io::FromRawHandle, ptr::null_mut};
        use windows_sys::Win32::{
            Foundation::{DUPLICATE_SAME_ACCESS, DuplicateHandle},
            System::Threading::GetCurrentProcess,
        };
        let handle = child
            .raw_handle()
            .ok_or_else(|| std::io::Error::other("Test process handle missing"))?;
        unsafe {
            let mut copy = null_mut();
            if DuplicateHandle(
                GetCurrentProcess(),
                handle,
                GetCurrentProcess(),
                &mut copy,
                0,
                0,
                DUPLICATE_SAME_ACCESS,
            ) == 0
            {
                return Err(std::io::Error::last_os_error());
            }
            let handle = std::os::windows::io::OwnedHandle::from_raw_handle(copy);
            let liveness = child
                .stdin
                .take()
                .ok_or_else(|| std::io::Error::other("Test liveness pipe missing"))?;
            Ok(Self {
                handle,
                _liveness: liveness,
            })
        }
    }
}
#[cfg(windows)]
impl Drop for ProcessTree {
    fn drop(&mut self) {
        use std::os::windows::io::AsRawHandle;
        unsafe {
            windows_sys::Win32::System::Threading::TerminateProcess(self.handle.as_raw_handle(), 1);
        }
    }
}
