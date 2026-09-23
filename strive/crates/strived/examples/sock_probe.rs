//! For strived's sandbox tests: tries to reach the Unix socket named on the
//! command line and says whether it could. `sock_probe PATH` connects a
//! stream socket; `sock_probe --dgram PATH` sends from a datagram socketpair.
#![allow(clippy::unwrap_used, clippy::panic, reason = "a test fixture")]

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let reached = match args.as_slice() {
        [flag, path] if flag == "--dgram" => {
            std::os::unix::net::UnixDatagram::pair().and_then(|(a, _b)| a.send_to(b"hello", path).map(|_| ()))
        }
        [path] => std::os::unix::net::UnixStream::connect(path).map(|_| ()),
        _ => panic!("usage: sock_probe [--dgram] PATH"),
    };
    match reached {
        Ok(()) => println!("reached"),
        Err(e) => println!("refused: {e}"),
    }
}
