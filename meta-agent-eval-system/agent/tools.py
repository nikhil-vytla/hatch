"""Tools for the customer support agent."""

from typing import Optional
from langchain.tools import tool
from agent.mock_data import get_refund_policy, get_booking


@tool
def lookup_refund_policy(booking_reference: Optional[str] = None, reason: Optional[str] = None) -> str:
    """
    Look up refund policy information.
    
    Args:
        booking_reference: Optional booking reference to check tier
        reason: Optional reason for refund request
    
    Returns:
        Refund policy information
    """
    if booking_reference:
        booking = get_booking(booking_reference)
        if booking:
            tier = booking.get("tier", "standard")
            policy_data = get_refund_policy(tier)
            return f"Refund Policy for {tier} tier: {policy_data['policy']}. Conditions: {', '.join(policy_data['conditions'])}"
        else:
            return "Booking not found. Standard refund policy: Full refunds available within 24 hours of booking. After 24 hours, refunds subject to 10% cancellation fee."
    
    # Default to standard policy
    policy_data = get_refund_policy("standard")
    return f"Standard Refund Policy: {policy_data['policy']}. Conditions: {', '.join(policy_data['conditions'])}"


@tool
def check_booking_status(booking_reference: str) -> str:
    """
    Check the status and details of a booking.
    
    Args:
        booking_reference: The booking reference number
    
    Returns:
        Booking status and details
    """
    booking = get_booking(booking_reference)
    if booking:
        return (
            f"Booking {booking['booking_reference']}:\n"
            f"Passenger: {booking['passenger']}\n"
            f"Route: {booking['route']}\n"
            f"Departure: {booking['departure']}\n"
            f"Arrival: {booking['arrival']}\n"
            f"Status: {booking['status']}\n"
            f"Tier: {booking['tier']}"
        )
    else:
        return f"Booking {booking_reference} not found. Please verify the booking reference."

