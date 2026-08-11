use openloop_updater_verifier::verify_tauri_signature_bytes;

const PUBLIC_KEY: &str = "untrusted comment: minisign public key E7620F1842B4E81F\n\
RWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO3\n";
const TAURI_SIGNATURE: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZSBmcm9tIG1pbmlzaWduIHNlY3JldCBrZXkKUlVRZjZMUkNHQTlpNTU5cjNnN1YxcU55SkRBcEdpcDhNZnFjYWRJZ1Q5Q3VoVjNFTWhIb04xbUdUa1VpZEYvejdTcmxRZ1hkeThvZmpiN2JOSkp5bERPb2NyQ284S0x6WndvPQp0cnVzdGVkIGNvbW1lbnQ6IHRpbWVzdGFtcDoxNTU2MTkzMzM1CWZpbGU6dGVzdAp5L3JVdzJ5OC9oT1VZalpVNzFlSHAvV28xS1o0MGZHeTJWSkVEbDM0WE1KTStUWDQ4U3MvMTd1M0l2SWZiVlIxRmtaWlNOQ2lzUWJ1UVkrYkh3aEVCZz09";

#[test]
fn accepts_a_valid_tauri_wrapped_signature() {
    verify_tauri_signature_bytes(PUBLIC_KEY.as_bytes(), TAURI_SIGNATURE.as_bytes(), b"test")
        .unwrap();
}

#[test]
fn rejects_tampered_artifact_bytes() {
    assert!(verify_tauri_signature_bytes(
        PUBLIC_KEY.as_bytes(),
        TAURI_SIGNATURE.as_bytes(),
        b"Test"
    )
    .is_err());
}

#[test]
fn rejects_the_wrong_public_key() {
    let wrong_key = PUBLIC_KEY.replace("RWQf", "RWQg");
    assert!(verify_tauri_signature_bytes(
        wrong_key.as_bytes(),
        TAURI_SIGNATURE.as_bytes(),
        b"test"
    )
    .is_err());
}

#[test]
fn rejects_malformed_outer_base64() {
    assert!(verify_tauri_signature_bytes(PUBLIC_KEY.as_bytes(), b"not base64", b"test").is_err());
}
