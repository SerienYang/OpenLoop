use openloop_updater_verifier::verify_tauri_signature_file;

fn main() {
    let mut args = std::env::args_os().skip(1);
    let artifact = args.next();
    let signature = args.next();
    let public_key = args.next();
    if artifact.is_none() || signature.is_none() || public_key.is_none() || args.next().is_some() {
        eprintln!("usage: openloop-updater-verifier <artifact> <signature> <public-key>");
        std::process::exit(2);
    }

    if let Err(error) =
        verify_tauri_signature_file(public_key.unwrap(), signature.unwrap(), artifact.unwrap())
    {
        eprintln!("updater signature verification failed: {error}");
        std::process::exit(1);
    }
}
