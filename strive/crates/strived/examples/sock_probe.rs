//! For strived's sandbox tests: tries to connect to the Unix socket named
//! on the command line and says whether it could.
#![allow(clippy::unwrap_used, reason = "a test fixture")]

fn main() {
    let path = std::env::args().nth(1).unwrap();
    match std::os::unix::net::UnixStream::connect(&path) {
        Ok(_) => println!("connected"),
        Err(e) => println!("refused: {e}"),
    }
}
