"""Trusted dispatch deadline, shared by counting and generation HTTP calls."""
from contextvars import ContextVar

# The gateway sets this in its own dispatch thread, never from candidate data.
upstream_deadline: ContextVar[float | None] = ContextVar("upstream_deadline", default=None)

# Both HTTP endpoints consume one generation deadline. These caps also bound
# the caller's wait, including DNS and peers that keep trickling response bytes.
CONNECT_TIMEOUT_SECONDS = 10.0
READ_TIMEOUT_SECONDS = 60.0
RETURN_MARGIN_SECONDS = 1.0
