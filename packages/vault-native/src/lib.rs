#![deny(clippy::all)]

#[macro_use]
extern crate napi_derive;

mod cosine;
mod hash;
mod walker;

pub use cosine::*;
pub use hash::*;
pub use walker::*;



#[napi]
pub fn hello_world() -> String {
  "Hello from Rust!".to_string()
}
