"""Mock customer support data for agent tools."""

# Mock refund policies
REFUND_POLICIES = {
    "standard": {
        "policy": "Full refunds are available within 24 hours of booking. After 24 hours, refunds are subject to a 10% cancellation fee.",
        "conditions": ["Must be requested before departure", "Non-refundable bookings excluded"],
    },
    "premium": {
        "policy": "Premium bookings receive full refunds up to 48 hours before departure with no fees.",
        "conditions": ["Premium tier only", "Must cancel 48+ hours in advance"],
    },
    "basic": {
        "policy": "Basic bookings are non-refundable but can be changed for a $50 fee up to 7 days before departure.",
        "conditions": ["No refunds", "Changes allowed with fee"],
    },
}

# Mock booking data
BOOKINGS = {
    "AC123456": {
        "booking_reference": "AC123456",
        "passenger": "John Doe",
        "departure": "2024-03-15 10:00",
        "arrival": "2024-03-15 14:30",
        "route": "Toronto to Vancouver",
        "status": "confirmed",
        "tier": "standard",
        "booking_date": "2024-02-01",
    },
    "AC789012": {
        "booking_reference": "AC789012",
        "passenger": "Jane Smith",
        "departure": "2024-03-20 08:00",
        "arrival": "2024-03-20 11:00",
        "route": "Montreal to Toronto",
        "status": "confirmed",
        "tier": "premium",
        "booking_date": "2024-02-10",
    },
    "AC345678": {
        "booking_reference": "AC345678",
        "passenger": "Bob Johnson",
        "departure": "2024-03-25 16:00",
        "arrival": "2024-03-25 20:00",
        "route": "Calgary to Toronto",
        "status": "cancelled",
        "tier": "basic",
        "booking_date": "2024-01-15",
    },
}

def get_refund_policy(tier: str = "standard") -> dict:
    """Get refund policy for a given tier."""
    return REFUND_POLICIES.get(tier, REFUND_POLICIES["standard"])

def get_booking(booking_reference: str) -> dict:
    """Get booking information by reference."""
    return BOOKINGS.get(booking_reference, None)

