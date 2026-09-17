"""Failures shared by the read-only protocol and local storage."""


class VerificationError(ValueError):
    """The history cannot be accepted. No state may be committed."""


class JournalCorruption(VerificationError):
    """A frame or committed record is damaged."""


class IncompleteTail(JournalCorruption):
    """A partial frame requires explicit operator recovery, never auto-truncation."""

    def __init__(self, offset: int) -> None:
        self.offset = offset
        super().__init__(f"incomplete journal frame at byte {offset}; explicit recovery required")


class LeaseError(VerificationError):
    """Another writer owns the run, or this writer's epoch is stale."""
