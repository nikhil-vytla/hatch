"""Optional localhost HTTP route to the same durable gateway used by pipes.

Call serve_one from the owning dispatch thread. No forward proxies, retries,
streaming, model discovery or auxiliary endpoints are implemented.
"""
from collections.abc import Callable
from http.server import BaseHTTPRequestHandler, HTTPServer

from ..contracts.harness import ExecutionContext
from ..errors import VerificationError
from .gateway import ModelGateway


class GatewayHTTPServer:
    def __init__(self, gateway: ModelGateway, context: ExecutionContext,
                 forward: Callable[[bytes, Callable[[bytes], bytes]], bytes]) -> None:
        self.failure: BaseException | None = None
        owner = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, format: str, *args: object) -> None:
                pass

            def do_POST(self) -> None:
                self.connection.settimeout(0.25)
                try:
                    lengths = self.headers.get_all("Content-Length", [])
                    if self.path != "/generation" or self.headers.get("Transfer-Encoding") is not None or len(lengths) != 1:
                        raise VerificationError("gateway generation route and bounded body only")
                    length = int(lengths[0])
                    if not 0 < length <= gateway.contract.max_request_bytes:
                        raise VerificationError("oversized request")
                    raw = self.rfile.read(length)
                    if len(raw) != length:
                        raise VerificationError("truncated request")
                    token = self.headers.get("Authorization", "").removeprefix("Bearer ")
                    body = gateway.dispatch(context, token, raw, forward)
                    status = 200
                except BaseException as error:
                    if isinstance(error, Exception):
                        gateway.deny(context)
                    owner.failure = error
                    body, status = b'{"error":"gateway denied"}', 403
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                try:
                    self.wfile.write(body)
                except (BrokenPipeError, ConnectionResetError):
                    pass

            def do_GET(self) -> None:
                gateway.deny(context)
                self.send_error(403)

        self.server = HTTPServer(("127.0.0.1", 0), Handler)
        self.server.timeout = 0.1
        self.url = f"http://127.0.0.1:{self.server.server_port}/generation"

    def serve_one(self) -> None:
        self.server.handle_request()
        if self.failure is not None and not isinstance(self.failure, Exception):
            raise self.failure

    def close(self) -> None:
        self.server.server_close()
