"""Incident-to-eval taxonomy system."""

from dataclasses import dataclass, field
from typing import List, Dict, Optional
import pandas as pd


@dataclass
class Incident:
    """Represents a real-world AI incident."""
    name: str
    description: str
    harm_types: List[str]  # e.g., ["Financial loss", "Brand damage"]
    use_case: str  # e.g., "Customer support"
    failure_mode: str  # e.g., "Hallucination"
    context: List[str]  # e.g., ["Retail", "Airlines"]


@dataclass
class EvalMapping:
    """Maps an incident to specific evals."""
    incident: Incident
    relevant_categories: List[str]  # Tier A categories
    relevant_methodologies: List[str]  # Attack methodologies
    eval_ids: List[str]  # Specific eval IDs that test this


# AirCanada incident definition
AIR_CANADA_INCIDENT = Incident(
    name="AirCanada Refund Policy Hallucination",
    description="AirCanada chatbot provided incorrect refund policy information, leading to financial loss and brand damage. The chatbot hallucinated a bereavement refund policy that didn't exist.",
    harm_types=["Financial loss", "Brand damage"],
    use_case="Customer support",
    failure_mode="Hallucination",
    context=["Airlines", "Retail"]
)


def map_incident_to_categories(incident: Incident, eval_data: pd.DataFrame) -> List[str]:
    """
    Map an incident to relevant Tier A categories based on harm types and failure modes.
    
    For AirCanada:
    - Hallucination → Could map to categories related to misinformation, policy violations
    - Financial loss → Could map to categories related to fraud, financial harm
    - Brand damage → Could map to categories related to reputation, harassment
    """
    categories = set()
    
    # Map based on failure mode
    if "hallucination" in incident.failure_mode.lower():
        # Look for categories that might involve misinformation or incorrect information
        categories.add("Misinformation")
        categories.add("Policy Violation")
    
    # Map based on harm types
    if "Financial" in str(incident.harm_types):
        categories.add("Financial Harm")
    
    if "Brand" in str(incident.harm_types):
        categories.add("Harassment")  # Brand damage could relate to reputation attacks
    
    # Get actual categories from eval data
    if not eval_data.empty:
        # Look for categories that might be relevant
        all_categories = eval_data.get("Tier A category", pd.Series()).unique()
        # Filter for potentially relevant ones
        for cat in all_categories:
            if isinstance(cat, str):
                cat_lower = cat.lower()
                if any(term in cat_lower for term in ["misinformation", "hallucination", "policy", "financial"]):
                    categories.add(cat)
    
    return list(categories) if categories else ["General"]


def map_incident_to_methodologies(incident: Incident, eval_data: pd.DataFrame) -> List[str]:
    """Map incident to relevant attack methodologies."""
    methodologies = set()
    
    # For hallucination incidents, relevant methodologies might include:
    # - Context flooding (to confuse the model)
    # - Semantic drift (to gradually shift to incorrect information)
    # - Role play (to get model to act as authority)
    
    if not eval_data.empty:
        all_methodologies = eval_data.get("Methodology", pd.Series()).unique()
        for meth in all_methodologies:
            if isinstance(meth, str):
                meth_lower = meth.lower()
                # Look for methodologies that could lead to hallucination
                if any(term in meth_lower for term in ["semantic drift", "context flooding", "role play", "authority"]):
                    methodologies.add(meth)
    
    return list(methodologies) if methodologies else []


def find_related_evals(
    incident: Incident,
    eval_data: pd.DataFrame,
    categories: List[str],
    methodologies: List[str]
) -> List[str]:
    """Find eval IDs that are relevant to the incident."""
    eval_ids = []
    
    if eval_data.empty:
        return eval_ids
    
    # Filter evals by category
    for category in categories:
        category_evals = eval_data[eval_data.get("Tier A category", "") == category]
        if not category_evals.empty:
            # Also filter by methodology if available
            for methodology in methodologies:
                meth_evals = category_evals[
                    category_evals.get("Methodology", "").str.contains(methodology, case=False, na=False)
                ]
                if not meth_evals.empty:
                    eval_ids.extend(meth_evals.get("Eval ID", pd.Series()).tolist())
            
            # Also include evals from this category even without methodology match
            if not methodologies:
                eval_ids.extend(category_evals.get("Eval ID", pd.Series()).tolist())
    
    # Remove duplicates and return
    return list(set([str(eid) for eid in eval_ids if pd.notna(eid)]))


def create_incident_mapping(
    incident: Incident,
    single_turn_evals: pd.DataFrame,
    multi_turn_evals: pd.DataFrame
) -> EvalMapping:
    """
    Create a mapping from incident to evals.
    
    Args:
        incident: The incident to map
        single_turn_evals: DataFrame with single-turn eval data
        multi_turn_evals: DataFrame with multi-turn eval data
    
    Returns:
        EvalMapping showing how incident maps to evals
    """
    # Combine eval data
    all_evals = pd.concat([single_turn_evals, multi_turn_evals], ignore_index=True)
    
    # Map to categories
    categories = map_incident_to_categories(incident, all_evals)
    
    # Map to methodologies
    methodologies = map_incident_to_methodologies(incident, all_evals)
    
    # Find related evals
    eval_ids = find_related_evals(incident, all_evals, categories, methodologies)
    
    return EvalMapping(
        incident=incident,
        relevant_categories=categories,
        relevant_methodologies=methodologies,
        eval_ids=eval_ids
    )


def load_eval_data():
    """Load eval data from CSV files."""
    try:
        single_turn = pd.read_csv("data/evals/raw/evals_round_3.csv")
    except FileNotFoundError:
        single_turn = pd.DataFrame()
    try:
        multi_turn = pd.read_csv("data/evals/raw/multi_turn_evals_round_3.csv")
    except FileNotFoundError:
        multi_turn = pd.DataFrame()
    return single_turn, multi_turn


def get_aircanada_mapping() -> EvalMapping:
    """Get the AirCanada incident mapping."""
    single_turn, multi_turn = load_eval_data()
    return create_incident_mapping(AIR_CANADA_INCIDENT, single_turn, multi_turn)

