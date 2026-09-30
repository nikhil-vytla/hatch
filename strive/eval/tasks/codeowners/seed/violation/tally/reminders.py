"""Payment reminders."""

from __future__ import annotations

from tally import invoice
from tally._generated.records import Invoice

__all__ = ["reminder_subject"]


def reminder_subject(inv: Invoice) -> str:
    """The subject line of a payment reminder for `inv`."""
    return f"Payment reminder: {inv.number}, due {invoice.due(inv).isoformat()}"
