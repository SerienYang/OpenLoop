use async_trait::async_trait;
use semver::Version;
use serde::Serialize;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter};
use tauri_plugin_updater::{Update, UpdaterExt};
use uuid::Uuid;

#[derive(Clone, Debug, PartialEq, Eq)]
enum StoreError {
    StaleUpdate,
    UpdateBusy,
    NoUpdateSession,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct SessionIdentity {
    update_id: String,
    generation: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct DownloadTicket {
    update_id: String,
    generation: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct InstallTicket {
    update_id: String,
    generation: u64,
    verified_bytes: Arc<Vec<u8>>,
}

struct UpdateSession<T> {
    identity: SessionIdentity,
    version: Version,
    update: T,
    verified_bytes: Option<Arc<Vec<u8>>>,
    downloading: bool,
    installing: bool,
}

struct SessionStore<T> {
    next_generation: u64,
    session: Option<UpdateSession<T>>,
}

impl<T> Default for SessionStore<T> {
    fn default() -> Self {
        Self {
            next_generation: 0,
            session: None,
        }
    }
}

impl<T> SessionStore<T> {
    fn upsert_candidate(&mut self, version: Version, update: T) -> SessionIdentity {
        if let Some(current) = self.session.as_ref() {
            if current.installing || current.version >= version {
                return current.identity.clone();
            }
        }

        self.next_generation += 1;
        let identity = SessionIdentity {
            update_id: Uuid::new_v4().to_string(),
            generation: self.next_generation,
        };
        self.session = Some(UpdateSession {
            identity: identity.clone(),
            version,
            update,
            verified_bytes: None,
            downloading: false,
            installing: false,
        });
        identity
    }

    #[cfg(test)]
    fn active_version(&self) -> Option<&Version> {
        self.session.as_ref().map(|session| &session.version)
    }

    fn begin_download(&mut self, update_id: &str) -> Result<DownloadTicket, StoreError> {
        let session = self.session_mut(update_id)?;
        if session.downloading || session.installing || session.verified_bytes.is_some() {
            return Err(StoreError::UpdateBusy);
        }
        session.downloading = true;
        Ok(DownloadTicket {
            update_id: session.identity.update_id.clone(),
            generation: session.identity.generation,
        })
    }

    fn finish_download(
        &mut self,
        ticket: &DownloadTicket,
        bytes: Arc<Vec<u8>>,
    ) -> Result<(), StoreError> {
        let session = self.session_for_ticket_mut(&ticket.update_id, ticket.generation)?;
        session.downloading = false;
        session.verified_bytes = Some(bytes);
        Ok(())
    }

    fn fail_download(&mut self, ticket: &DownloadTicket) -> Result<(), StoreError> {
        let session = self.session_for_ticket_mut(&ticket.update_id, ticket.generation)?;
        session.downloading = false;
        Ok(())
    }

    fn begin_install(&mut self, update_id: &str) -> Result<InstallTicket, StoreError> {
        let session = self.session_mut(update_id)?;
        if session.downloading || session.installing {
            return Err(StoreError::UpdateBusy);
        }
        let bytes = session
            .verified_bytes
            .clone()
            .ok_or(StoreError::NoUpdateSession)?;
        session.installing = true;
        Ok(InstallTicket {
            update_id: session.identity.update_id.clone(),
            generation: session.identity.generation,
            verified_bytes: bytes,
        })
    }

    fn finish_install(
        &mut self,
        ticket: &InstallTicket,
        succeeded: bool,
    ) -> Result<(), StoreError> {
        self.session_for_ticket_mut(&ticket.update_id, ticket.generation)?;
        if succeeded {
            self.next_generation += 1;
            self.session = None;
        } else if let Some(session) = self.session.as_mut() {
            session.installing = false;
        }
        Ok(())
    }

    fn clear(&mut self, update_id: &str) -> Result<(), StoreError> {
        let session = self.session_mut(update_id)?;
        if session.installing {
            return Err(StoreError::UpdateBusy);
        }
        self.next_generation += 1;
        self.session = None;
        Ok(())
    }

    #[cfg(test)]
    fn has_verified_bytes(&self, update_id: &str) -> bool {
        self.session.as_ref().is_some_and(|session| {
            session.identity.update_id == update_id && session.verified_bytes.is_some()
        })
    }

    fn update_for_download(&self, ticket: &DownloadTicket) -> Result<&T, StoreError> {
        self.session_for_ticket(&ticket.update_id, ticket.generation)
            .map(|session| &session.update)
    }

    fn update_for_install(&self, ticket: &InstallTicket) -> Result<&T, StoreError> {
        self.session_for_ticket(&ticket.update_id, ticket.generation)
            .map(|session| &session.update)
    }

    fn session_mut(&mut self, update_id: &str) -> Result<&mut UpdateSession<T>, StoreError> {
        match self.session.as_mut() {
            Some(session) if session.identity.update_id == update_id => Ok(session),
            _ => Err(StoreError::StaleUpdate),
        }
    }

    fn session_for_ticket_mut(
        &mut self,
        update_id: &str,
        generation: u64,
    ) -> Result<&mut UpdateSession<T>, StoreError> {
        match self.session.as_mut() {
            Some(session)
                if session.identity.update_id == update_id
                    && session.identity.generation == generation =>
            {
                Ok(session)
            }
            _ => Err(StoreError::StaleUpdate),
        }
    }

    fn session_for_ticket(
        &self,
        update_id: &str,
        generation: u64,
    ) -> Result<&UpdateSession<T>, StoreError> {
        match self.session.as_ref() {
            Some(session)
                if session.identity.update_id == update_id
                    && session.identity.generation == generation =>
            {
                Ok(session)
            }
            _ => Err(StoreError::StaleUpdate),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub(crate) enum UpdateErrorCode {
    CheckFailed,
    DownloadFailed,
    SignatureInvalid,
    StaleUpdate,
    UpdateBusy,
    NoUpdateSession,
    InstallPermissionDenied,
    InstallFailed,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub(crate) struct UpdateCommandError {
    code: UpdateErrorCode,
}

impl UpdateCommandError {
    fn new(code: UpdateErrorCode) -> Self {
        Self { code }
    }
}

#[derive(Clone, Copy, Debug)]
enum UpdateStage {
    Check,
    Download,
    Install,
}

fn map_store_error(error: StoreError) -> UpdateCommandError {
    let code = match error {
        StoreError::StaleUpdate => UpdateErrorCode::StaleUpdate,
        StoreError::UpdateBusy => UpdateErrorCode::UpdateBusy,
        StoreError::NoUpdateSession => UpdateErrorCode::NoUpdateSession,
    };
    UpdateCommandError::new(code)
}

fn map_updater_error(stage: UpdateStage, error: tauri_plugin_updater::Error) -> UpdateCommandError {
    use tauri_plugin_updater::Error;

    eprintln!("[openloop] updater {stage:?} failed: {error}");
    let code = match (&stage, &error) {
        (
            UpdateStage::Download,
            Error::Minisign(_) | Error::Base64(_) | Error::SignatureUtf8(_),
        ) => UpdateErrorCode::SignatureInvalid,
        (UpdateStage::Install, Error::AuthenticationFailed) => {
            UpdateErrorCode::InstallPermissionDenied
        }
        (UpdateStage::Install, Error::Io(io_error))
            if io_error.kind() == std::io::ErrorKind::PermissionDenied =>
        {
            UpdateErrorCode::InstallPermissionDenied
        }
        (UpdateStage::Check, _) => UpdateErrorCode::CheckFailed,
        (UpdateStage::Download, _) => UpdateErrorCode::DownloadFailed,
        (UpdateStage::Install, _) => UpdateErrorCode::InstallFailed,
    };
    UpdateCommandError::new(code)
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UpdateInfo {
    pub(crate) update_id: String,
    pub(crate) version: String,
    pub(crate) notes: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
struct UpdateDownloadProgress {
    update_id: String,
    version: String,
    downloaded_bytes: u64,
    total_bytes: Option<u64>,
}

impl UpdateDownloadProgress {
    fn new(
        update_id: impl Into<String>,
        version: impl Into<String>,
        downloaded_bytes: u64,
        total_bytes: Option<u64>,
    ) -> Self {
        Self {
            update_id: update_id.into(),
            version: version.into(),
            downloaded_bytes,
            total_bytes,
        }
    }
}

type ProgressSink = Box<dyn FnMut(usize, Option<u64>) + Send>;

#[async_trait]
trait UpdateArtifact: Send + Sync {
    fn version(&self) -> &str;
    fn notes(&self) -> &str;
    async fn download(&self, progress: ProgressSink) -> Result<Vec<u8>, UpdateCommandError>;
    fn install(&self, bytes: &[u8]) -> Result<(), UpdateCommandError>;
}

struct TauriUpdateArtifact(Update);

#[async_trait]
impl UpdateArtifact for TauriUpdateArtifact {
    fn version(&self) -> &str {
        &self.0.version
    }

    fn notes(&self) -> &str {
        self.0.body.as_deref().unwrap_or_default()
    }

    async fn download(&self, mut progress: ProgressSink) -> Result<Vec<u8>, UpdateCommandError> {
        self.0
            .download(
                move |chunk_length, content_length| progress(chunk_length, content_length),
                || {},
            )
            .await
            .map_err(|error| map_updater_error(UpdateStage::Download, error))
    }

    fn install(&self, bytes: &[u8]) -> Result<(), UpdateCommandError> {
        self.0
            .install(bytes)
            .map_err(|error| map_updater_error(UpdateStage::Install, error))
    }
}

pub(crate) struct UpdateManager(Mutex<SessionStore<Arc<dyn UpdateArtifact>>>);

impl Default for UpdateManager {
    fn default() -> Self {
        Self(Mutex::new(SessionStore::default()))
    }
}

impl UpdateManager {
    fn upsert_artifact(
        &self,
        artifact: Arc<dyn UpdateArtifact>,
    ) -> Result<UpdateInfo, UpdateCommandError> {
        let version = Version::parse(artifact.version())
            .map_err(|_| UpdateCommandError::new(UpdateErrorCode::CheckFailed))?;
        let mut store = self.0.lock().unwrap();
        let identity = store.upsert_candidate(version, artifact);
        let session = store
            .session
            .as_ref()
            .ok_or_else(|| UpdateCommandError::new(UpdateErrorCode::NoUpdateSession))?;
        Ok(UpdateInfo {
            update_id: identity.update_id,
            version: session.version.to_string(),
            notes: session.update.notes().to_string(),
        })
    }
}

async fn download_session(
    manager: &UpdateManager,
    update_id: &str,
    progress: ProgressSink,
) -> Result<(), UpdateCommandError> {
    let (ticket, artifact) = {
        let mut store = manager.0.lock().unwrap();
        let ticket = store.begin_download(update_id).map_err(map_store_error)?;
        let artifact = store
            .update_for_download(&ticket)
            .map_err(map_store_error)?
            .clone();
        (ticket, artifact)
    };

    let bytes = match artifact.download(progress).await {
        Ok(bytes) => bytes,
        Err(error) => {
            let _ = manager.0.lock().unwrap().fail_download(&ticket);
            return Err(error);
        }
    };

    manager
        .0
        .lock()
        .unwrap()
        .finish_download(&ticket, Arc::new(bytes))
        .map_err(map_store_error)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum InstallOutcome {
    RestartRequired,
}

async fn install_session(
    manager: &UpdateManager,
    update_id: &str,
) -> Result<InstallOutcome, UpdateCommandError> {
    let (ticket, artifact) = {
        let mut store = manager.0.lock().unwrap();
        let ticket = store.begin_install(update_id).map_err(map_store_error)?;
        let artifact = store
            .update_for_install(&ticket)
            .map_err(map_store_error)?
            .clone();
        (ticket, artifact)
    };

    match artifact.install(ticket.verified_bytes.as_slice()) {
        Ok(()) => {
            manager
                .0
                .lock()
                .unwrap()
                .finish_install(&ticket, true)
                .map_err(map_store_error)?;
            Ok(InstallOutcome::RestartRequired)
        }
        Err(error) => {
            let _ = manager.0.lock().unwrap().finish_install(&ticket, false);
            Err(error)
        }
    }
}

#[tauri::command]
pub(crate) fn get_app_version(app: AppHandle) -> String {
    app.package_info().version.to_string()
}

#[tauri::command]
pub(crate) async fn check_for_update(
    app: AppHandle,
    manager: tauri::State<'_, UpdateManager>,
) -> Result<Option<UpdateInfo>, UpdateCommandError> {
    let updater = app
        .updater()
        .map_err(|error| map_updater_error(UpdateStage::Check, error))?;
    let update = updater
        .check()
        .await
        .map_err(|error| map_updater_error(UpdateStage::Check, error))?;
    update
        .map(|candidate| manager.upsert_artifact(Arc::new(TauriUpdateArtifact(candidate))))
        .transpose()
}

#[tauri::command]
pub(crate) async fn download_update(
    app: AppHandle,
    manager: tauri::State<'_, UpdateManager>,
    update_id: String,
) -> Result<(), UpdateCommandError> {
    let version = {
        let store = manager.0.lock().unwrap();
        store
            .session
            .as_ref()
            .filter(|session| session.identity.update_id == update_id)
            .map(|session| session.version.to_string())
            .ok_or_else(|| UpdateCommandError::new(UpdateErrorCode::StaleUpdate))?
    };
    let event_update_id = update_id.clone();
    let mut downloaded_bytes = 0u64;
    download_session(
        manager.inner(),
        &update_id,
        Box::new(move |chunk_length, total_bytes| {
            downloaded_bytes += chunk_length as u64;
            let _ = app.emit(
                "openloop-update-download-progress",
                UpdateDownloadProgress::new(
                    event_update_id.clone(),
                    version.clone(),
                    downloaded_bytes,
                    total_bytes,
                ),
            );
        }),
    )
    .await
}

#[tauri::command]
pub(crate) fn clear_pending_update(
    manager: tauri::State<'_, UpdateManager>,
    update_id: String,
) -> Result<(), UpdateCommandError> {
    manager
        .0
        .lock()
        .unwrap()
        .clear(&update_id)
        .map_err(map_store_error)
}

#[tauri::command]
pub(crate) async fn install_update(
    app: AppHandle,
    manager: tauri::State<'_, UpdateManager>,
    update_id: String,
) -> Result<(), UpdateCommandError> {
    install_session(manager.inner(), &update_id).await?;
    app.restart()
}

#[cfg(test)]
mod tests {
    use super::*;
    use async_trait::async_trait;
    use semver::Version;
    use std::sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        mpsc, Arc, Mutex as StdMutex,
    };
    use std::time::Duration;

    fn version(value: &str) -> Version {
        Version::parse(value).unwrap()
    }

    #[test]
    fn newer_session_invalidates_older_generation() {
        let mut store = SessionStore::default();
        let first = store.upsert_candidate(version("0.1.12"), "first");
        let second = store.upsert_candidate(version("0.1.13"), "second");

        assert_ne!(first.update_id, second.update_id);
        assert!(second.generation > first.generation);
        assert_eq!(store.active_version().unwrap(), &version("0.1.13"));
    }

    #[test]
    fn same_or_lower_version_keeps_ready_session() {
        let mut store = SessionStore::default();
        let active = store.upsert_candidate(version("0.1.13"), "newest");
        let ticket = store.begin_download(&active.update_id).unwrap();
        store
            .finish_download(&ticket, Arc::new(vec![1, 2, 3]))
            .unwrap();

        let same = store.upsert_candidate(version("0.1.13"), "same");
        let lower = store.upsert_candidate(version("0.1.12"), "lower");

        assert_eq!(same.update_id, active.update_id);
        assert_eq!(lower.update_id, active.update_id);
        assert!(store.has_verified_bytes(&active.update_id));
    }

    #[test]
    fn stale_download_cannot_restore_cleared_session() {
        let mut store = SessionStore::default();
        let active = store.upsert_candidate(version("0.1.12"), "candidate");
        let ticket = store.begin_download(&active.update_id).unwrap();

        store.clear(&active.update_id).unwrap();

        assert_eq!(
            store.finish_download(&ticket, Arc::new(vec![1])),
            Err(StoreError::StaleUpdate)
        );
        assert!(store.active_version().is_none());
    }

    #[test]
    fn install_failure_keeps_verified_bytes_for_retry() {
        let mut store = SessionStore::default();
        let active = store.upsert_candidate(version("0.1.12"), "candidate");
        let download = store.begin_download(&active.update_id).unwrap();
        store
            .finish_download(&download, Arc::new(vec![1, 2, 3]))
            .unwrap();

        let install = store.begin_install(&active.update_id).unwrap();
        store.finish_install(&install, false).unwrap();

        assert!(store.has_verified_bytes(&active.update_id));
        assert!(store.begin_install(&active.update_id).is_ok());
    }

    #[test]
    fn download_failure_releases_busy_state_for_retry() {
        let mut store = SessionStore::default();
        let active = store.upsert_candidate(version("0.1.12"), "candidate");
        let first = store.begin_download(&active.update_id).unwrap();

        store.fail_download(&first).unwrap();

        assert!(store.begin_download(&active.update_id).is_ok());
    }

    #[test]
    fn clear_and_duplicate_install_are_rejected_while_installing() {
        let mut store = SessionStore::default();
        let active = store.upsert_candidate(version("0.1.12"), "candidate");
        let download = store.begin_download(&active.update_id).unwrap();
        store
            .finish_download(&download, Arc::new(vec![1, 2, 3]))
            .unwrap();
        let _install = store.begin_install(&active.update_id).unwrap();

        assert_eq!(
            store.begin_install(&active.update_id),
            Err(StoreError::UpdateBusy)
        );
        assert_eq!(store.clear(&active.update_id), Err(StoreError::UpdateBusy));
    }

    #[test]
    fn newer_candidate_cannot_replace_an_installing_session() {
        let mut store = SessionStore::default();
        let active = store.upsert_candidate(version("0.1.12"), "candidate");
        let download = store.begin_download(&active.update_id).unwrap();
        store
            .finish_download(&download, Arc::new(vec![1, 2, 3]))
            .unwrap();
        let _install = store.begin_install(&active.update_id).unwrap();

        let offered = store.upsert_candidate(version("0.1.13"), "newer");

        assert_eq!(offered.update_id, active.update_id);
        assert_eq!(store.active_version(), Some(&version("0.1.12")));
    }

    #[test]
    fn updater_errors_map_to_stable_codes() {
        let signature_error =
            tauri_plugin_updater::Error::Minisign(minisign_verify::Error::InvalidSignature);
        let permission_error = tauri_plugin_updater::Error::Io(std::io::Error::new(
            std::io::ErrorKind::PermissionDenied,
            "denied",
        ));

        assert_eq!(
            map_updater_error(UpdateStage::Download, signature_error).code,
            UpdateErrorCode::SignatureInvalid
        );
        assert_eq!(
            map_updater_error(UpdateStage::Install, permission_error).code,
            UpdateErrorCode::InstallPermissionDenied
        );
    }

    #[test]
    fn progress_payload_is_bound_to_update_id_and_version() {
        let payload = UpdateDownloadProgress::new("update-1", "0.1.12", 4, Some(10));

        assert_eq!(payload.update_id, "update-1");
        assert_eq!(payload.version, "0.1.12");
        assert_eq!(payload.downloaded_bytes, 4);
        assert_eq!(payload.total_bytes, Some(10));
    }

    struct FakeArtifact {
        version: String,
        fail_first_download: AtomicBool,
        downloads: AtomicUsize,
        installs: AtomicUsize,
    }

    impl FakeArtifact {
        fn new(version: &str, fail_first_download: bool) -> Self {
            Self {
                version: version.to_string(),
                fail_first_download: AtomicBool::new(fail_first_download),
                downloads: AtomicUsize::new(0),
                installs: AtomicUsize::new(0),
            }
        }
    }

    #[async_trait]
    impl UpdateArtifact for FakeArtifact {
        fn version(&self) -> &str {
            &self.version
        }

        fn notes(&self) -> &str {
            "notes"
        }

        async fn download(
            &self,
            mut progress: ProgressSink,
        ) -> Result<Vec<u8>, UpdateCommandError> {
            self.downloads.fetch_add(1, Ordering::SeqCst);
            if self.fail_first_download.swap(false, Ordering::SeqCst) {
                return Err(UpdateCommandError::new(UpdateErrorCode::DownloadFailed));
            }
            progress(3, Some(3));
            Ok(vec![1, 2, 3])
        }

        fn install(&self, bytes: &[u8]) -> Result<(), UpdateCommandError> {
            assert_eq!(bytes, [1, 2, 3]);
            self.installs.fetch_add(1, Ordering::SeqCst);
            Ok(())
        }
    }

    #[test]
    fn failed_download_can_retry_and_install_without_rechecking() {
        tauri::async_runtime::block_on(async {
            let artifact = Arc::new(FakeArtifact::new("0.1.12", true));
            let manager = UpdateManager::default();
            let info = manager
                .upsert_artifact(artifact.clone() as Arc<dyn UpdateArtifact>)
                .unwrap();

            assert_eq!(
                download_session(&manager, &info.update_id, Box::new(|_, _| {}))
                    .await
                    .unwrap_err()
                    .code,
                UpdateErrorCode::DownloadFailed
            );
            download_session(&manager, &info.update_id, Box::new(|_, _| {}))
                .await
                .unwrap();
            install_session(&manager, &info.update_id).await.unwrap();

            assert_eq!(artifact.downloads.load(Ordering::SeqCst), 2);
            assert_eq!(artifact.installs.load(Ordering::SeqCst), 1);
        });
    }

    struct BlockingArtifact {
        version: String,
        started: StdMutex<Option<mpsc::Sender<()>>>,
        release: StdMutex<mpsc::Receiver<()>>,
    }

    #[async_trait]
    impl UpdateArtifact for BlockingArtifact {
        fn version(&self) -> &str {
            &self.version
        }

        fn notes(&self) -> &str {
            ""
        }

        async fn download(&self, _progress: ProgressSink) -> Result<Vec<u8>, UpdateCommandError> {
            Ok(vec![1, 2, 3])
        }

        fn install(&self, _bytes: &[u8]) -> Result<(), UpdateCommandError> {
            if let Some(started) = self.started.lock().unwrap().take() {
                started.send(()).unwrap();
            }
            self.release
                .lock()
                .unwrap()
                .recv_timeout(Duration::from_secs(5))
                .unwrap();
            Ok(())
        }
    }

    #[test]
    fn concurrent_install_and_clear_are_rejected_while_installer_runs() {
        let (started_tx, started_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let artifact = Arc::new(BlockingArtifact {
            version: "0.1.12".to_string(),
            started: StdMutex::new(Some(started_tx)),
            release: StdMutex::new(release_rx),
        });
        let manager = Arc::new(UpdateManager::default());
        let info = manager
            .upsert_artifact(artifact as Arc<dyn UpdateArtifact>)
            .unwrap();
        tauri::async_runtime::block_on(download_session(
            &manager,
            &info.update_id,
            Box::new(|_, _| {}),
        ))
        .unwrap();

        let install_manager = manager.clone();
        let install_id = info.update_id.clone();
        let install_thread = std::thread::spawn(move || {
            tauri::async_runtime::block_on(install_session(&install_manager, &install_id))
        });
        started_rx.recv_timeout(Duration::from_secs(5)).unwrap();

        assert_eq!(
            manager
                .0
                .lock()
                .unwrap()
                .clear(&info.update_id)
                .unwrap_err(),
            StoreError::UpdateBusy
        );
        assert_eq!(
            tauri::async_runtime::block_on(install_session(&manager, &info.update_id))
                .unwrap_err()
                .code,
            UpdateErrorCode::UpdateBusy
        );

        release_tx.send(()).unwrap();
        assert_eq!(
            install_thread.join().unwrap().unwrap(),
            InstallOutcome::RestartRequired
        );
    }
}
