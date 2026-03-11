use napi::bindgen_prelude::*;
use sha2::{Digest, Sha256};
use rayon::prelude::*;
use std::fs;
use std::io::{self, Read};

#[napi]
pub fn hash_file(path: String) -> Result<String> {
    let mut file = fs::File::open(&path).map_err(|e| Error::new(Status::GenericFailure, format!("Failed to open file {}: {}", path, e)))?;
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 8192];

    loop {
        let count = file.read(&mut buffer).map_err(|e| Error::new(Status::GenericFailure, format!("Failed to read file: {}", e)))?;
        if count == 0 {
            break;
        }
        hasher.update(&buffer[..count]);
    }

    Ok(format!("{:x}", hasher.finalize()))
}

#[napi]
pub fn hash_files_parallel(paths: Vec<String>) -> Vec<String> {
    paths.into_par_iter()
        .map(|path| {
            match hash_file_internal(&path) {
                Ok(h) => h,
                Err(_) => String::new(),
            }
        })
        .collect()
}

fn hash_file_internal(path: &str) -> io::Result<String> {
    let mut file = fs::File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 8192];

    loop {
        let count = file.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        hasher.update(&buffer[..count]);
    }

    Ok(format!("{:x}", hasher.finalize()))
}
