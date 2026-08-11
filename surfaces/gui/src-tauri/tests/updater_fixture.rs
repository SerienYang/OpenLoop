use std::{
    fs,
    io::{Read, Write},
    net::TcpListener,
    thread,
};
use tauri::test::{mock_builder, mock_context, noop_assets};
use tauri_plugin_updater::UpdaterExt;

const PUBLIC_KEY_BASE64: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXkgRTc2MjBGMTg0MkI0RTgxRgpSV1FmNkxSQ0dBOWk1M21sWWVjTzRJelQ1MVRHUHB2V3VjTlNDaDFDQk0wUVRhTG43M1k3R0ZPMwo=";
const TAURI_SIGNATURE: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZSBmcm9tIG1pbmlzaWduIHNlY3JldCBrZXkKUlVRZjZMUkNHQTlpNTU5cjNnN1YxcU55SkRBcEdpcDhNZnFjYWRJZ1Q5Q3VoVjNFTWhIb04xbUdUa1VpZEYvejdTcmxRZ1hkeThvZmpiN2JOSkp5bERPb2NyQ284S0x6WndvPQp0cnVzdGVkIGNvbW1lbnQ6IHRpbWVzdGFtcDoxNTU2MTkzMzM1CWZpbGU6dGVzdAp5L3JVdzJ5OC9oT1VZalpVNzFlSHAvV28xS1o0MGZHeTJWSkVEbDM0WE1KTStUWDQ4U3MvMTd1M0l2SWZiVlIxRmtaWlNOQ2lzUWJ1UVkrYkh3aEVCZz09";

fn fixture_server(artifact: &'static [u8]) -> (String, thread::JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let manifest_url = format!("http://{address}/latest.json");
    let artifact_url = format!("http://{address}/artifact");
    let handle = thread::spawn(move || {
        for _ in 0..2 {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = [0u8; 2048];
            let read = stream.read(&mut request).unwrap();
            let request = String::from_utf8_lossy(&request[..read]);
            let (content_type, body) = if request.starts_with("GET /latest.json ") {
                (
                    "application/json",
                    format!(
                        r#"{{"version":"0.1.1","notes":"fixture","pub_date":"2026-08-11T00:00:00Z","url":"{artifact_url}","signature":"{TAURI_SIGNATURE}"}}"#
                    )
                    .into_bytes(),
                )
            } else {
                ("application/octet-stream", artifact.to_vec())
            };
            let header = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                body.len()
            );
            stream.write_all(header.as_bytes()).unwrap();
            stream.write_all(&body).unwrap();
        }
    });
    (manifest_url, handle)
}

fn test_app(manifest_url: &str) -> (tauri::App<tauri::test::MockRuntime>, tempfile::TempDir) {
    let mut context = mock_context(noop_assets());
    context.config_mut().plugins.0.insert(
        "updater".into(),
        serde_json::json!({
            "dangerousInsecureTransportProtocol": true,
            "endpoints": [manifest_url],
            "pubkey": PUBLIC_KEY_BASE64,
        }),
    );
    let app = mock_builder()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .build(context)
        .unwrap();
    let temp = tempfile::tempdir().unwrap();
    let executable = temp.path().join("Fixture.app/Contents/MacOS/fixture");
    fs::create_dir_all(executable.parent().unwrap()).unwrap();
    fs::write(&executable, b"fixture").unwrap();
    (app, temp)
}

#[test]
fn downloads_and_verifies_a_tauri_wrapped_signature_from_loopback() {
    let (manifest_url, server) = fixture_server(b"test");
    let (app, temp) = test_app(&manifest_url);
    let executable = temp.path().join("Fixture.app/Contents/MacOS/fixture");

    let bytes = tauri::async_runtime::block_on(async {
        let updater = app
            .handle()
            .updater_builder()
            .executable_path(executable)
            .build()
            .unwrap();
        let update = updater.check().await.unwrap().unwrap();
        update.download(|_, _| {}, || {}).await.unwrap()
    });

    server.join().unwrap();
    assert_eq!(bytes, b"test");
}

#[test]
fn rejects_tampered_loopback_artifact() {
    let (manifest_url, server) = fixture_server(b"Test");
    let (app, temp) = test_app(&manifest_url);
    let executable = temp.path().join("Fixture.app/Contents/MacOS/fixture");

    let result = tauri::async_runtime::block_on(async {
        let updater = app
            .handle()
            .updater_builder()
            .executable_path(executable)
            .build()
            .unwrap();
        let update = updater.check().await.unwrap().unwrap();
        update.download(|_, _| {}, || {}).await
    });

    server.join().unwrap();
    assert!(matches!(
        result,
        Err(tauri_plugin_updater::Error::Minisign(_))
    ));
}
