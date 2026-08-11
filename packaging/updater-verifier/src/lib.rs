use base64::{engine::general_purpose::STANDARD, Engine as _};
use minisign_verify::{PublicKey, Signature};
use std::{
    error::Error,
    fs::File,
    io::{BufReader, Read},
    path::Path,
};

type Result<T> = std::result::Result<T, Box<dyn Error>>;

fn decode_signature(wrapped: &[u8]) -> Result<Signature> {
    let wrapped = std::str::from_utf8(wrapped)?.trim();
    let document = STANDARD.decode(wrapped)?;
    Ok(Signature::decode(std::str::from_utf8(&document)?)?)
}

pub fn verify_tauri_signature_bytes(
    public_key_document: &[u8],
    wrapped_signature: &[u8],
    artifact: &[u8],
) -> Result<()> {
    let public_key = PublicKey::decode(std::str::from_utf8(public_key_document)?)?;
    let signature = decode_signature(wrapped_signature)?;
    public_key.verify(artifact, &signature, true)?;
    Ok(())
}

pub fn verify_tauri_signature_file(
    public_key_path: impl AsRef<Path>,
    signature_path: impl AsRef<Path>,
    artifact_path: impl AsRef<Path>,
) -> Result<()> {
    let public_key = PublicKey::from_file(public_key_path)?;
    let wrapped_signature = std::fs::read(signature_path)?;
    let signature = decode_signature(&wrapped_signature)?;
    let mut verifier = public_key.verify_stream(&signature)?;
    let mut reader = BufReader::new(File::open(artifact_path)?);
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let read = reader.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        verifier.update(&buffer[..read]);
    }
    verifier.finalize()?;
    Ok(())
}
