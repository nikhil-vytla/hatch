"""Metrics calculation for eval results."""

import pandas as pd
from typing import Dict, List, Any
from collections import defaultdict


def calculate_severity_metrics(results: List[Dict[str, Any]]) -> pd.DataFrame:
    """
    Calculate severity distribution metrics (PASS, P4, P3, P2, P1, P0).
    
    Returns DataFrame with columns: severity, description, count, share
    """
    severity_counts = defaultdict(int)
    total = len(results)
    
    for result in results:
        severity = result.get("severity", "Unknown")
        grade = result.get("grade", "Unknown")
        
        # Map grade to severity if severity is missing
        if severity == "Unknown" or not severity:
            if grade == "Pass":
                severity = "PASS"
            elif grade == "Fail":
                # Default to P4 if we don't have severity info
                severity = "P4"
            else:
                severity = "Unknown"
        
        severity_counts[severity] += 1
    
    # Create DataFrame
    severity_order = ["PASS", "P4", "P3", "P2", "P1", "P0", "Trivial"]
    descriptions = {
        "PASS": "PASS",
        "P4": "TRIVIAL; greyzone",
        "P3": "MINOR; schedule fix",
        "P2": "SIGNIFICANT; prioritize",
        "P1": "MAJOR; fix immediately",
        "P0": "CRITICAL; all hands on deck",
        "Trivial": "TRIVIAL; greyzone"
    }
    
    data = []
    for severity in severity_order:
        count = severity_counts.get(severity, 0)
        share = (count / total * 100) if total > 0 else 0
        data.append({
            "severity": severity,
            "description": descriptions.get(severity, severity),
            "count": count,
            "share": round(share, 1)
        })
    
    # Add total row
    data.append({
        "severity": "TOTAL",
        "description": "",
        "count": total,
        "share": 100.0
    })
    
    return pd.DataFrame(data)


def calculate_category_incidents(results: List[Dict[str, Any]], min_severity: str = "P2") -> pd.DataFrame:
    """
    Calculate incidents by Tier A category for P3 or P2 severity.
    
    Args:
        results: List of eval results
        min_severity: Minimum severity to include (P2 or P3)
    
    Returns DataFrame with columns: tier_a_category, incident_count
    """
    severity_order = {"P0": 0, "P1": 1, "P2": 2, "P3": 3, "P4": 4, "Trivial": 5, "PASS": 6}
    min_level = severity_order.get(min_severity, 2)
    
    category_counts = defaultdict(int)
    
    for result in results:
        tier_a = result.get("tier_a", "Unknown")
        severity = result.get("severity", "PASS")
        grade = result.get("grade", "Pass")
        
        # Only count failures (non-PASS) with severity >= min_severity
        if grade != "Pass" and severity in severity_order:
            if severity_order[severity] <= min_level:
                category_counts[tier_a] += 1
    
    # Convert to DataFrame and sort by count
    if not category_counts:
        # Return empty DataFrame with correct columns
        return pd.DataFrame(columns=["tier_a_category", "incident_count"])
    
    data = [{"tier_a_category": cat, "incident_count": count} 
            for cat, count in category_counts.items()]
    df = pd.DataFrame(data)
    df = df.sort_values("incident_count", ascending=False)
    
    return df


def calculate_category_pass_rates(results: List[Dict[str, Any]]) -> pd.DataFrame:
    """
    Calculate pass rates by category and sub-category.
    
    Returns DataFrame with columns: category_id, category, sub_category, total, pass_count, pass_pct
    """
    category_data = defaultdict(lambda: {
        "total": 0,
        "pass_count": 0,
        "category": "",
        "sub_category": ""
    })
    
    for result in results:
        tier_a = result.get("tier_a", "Unknown")
        tier_b = result.get("tier_b", "")
        tier_c = result.get("tier_c", "")
        grade = result.get("grade", "Fail")
        
        # Use tier_c as category_id if available, otherwise tier_b
        category_id = tier_c if tier_c else tier_b if tier_b else tier_a
        
        if category_id not in category_data:
            category_data[category_id]["category"] = tier_a
            category_data[category_id]["sub_category"] = tier_b if tier_b else tier_a
        
        category_data[category_id]["total"] += 1
        if grade == "Pass":
            category_data[category_id]["pass_count"] += 1
    
    # Convert to DataFrame
    data = []
    for cat_id, stats in category_data.items():
        pass_pct = (stats["pass_count"] / stats["total"] * 100) if stats["total"] > 0 else 0
        data.append({
            "category_id": cat_id,
            "category": stats["category"],
            "sub_category": stats["sub_category"],
            "total": stats["total"],
            "pass_count": stats["pass_count"],
            "pass_pct": round(pass_pct, 1)
        })
    
    df = pd.DataFrame(data)
    df = df.sort_values(["category", "pass_pct", "total"], ascending=[True, True, False])
    
    return df


def calculate_methodology_pass_rates(results: List[Dict[str, Any]]) -> pd.DataFrame:
    """
    Calculate pass rates by methodology.
    
    Returns DataFrame with columns: methodology, total, pass_count, pass_pct
    """
    methodology_data = defaultdict(lambda: {"total": 0, "pass_count": 0})
    
    for result in results:
        methodology = result.get("methodology", "No explicit methodology")
        grade = result.get("grade", "Fail")
        
        # Normalize methodology name
        if not methodology or methodology.strip() == "" or methodology == "0. Benign":
            methodology = "No explicit methodology (Easy)"
        else:
            methodology = f"Methodology: {methodology}"
        
        methodology_data[methodology]["total"] += 1
        if grade == "Pass":
            methodology_data[methodology]["pass_count"] += 1
    
    # Convert to DataFrame
    data = []
    for meth, stats in methodology_data.items():
        pass_pct = (stats["pass_count"] / stats["total"] * 100) if stats["total"] > 0 else 0
        data.append({
            "methodology": meth,
            "total": stats["total"],
            "pass_count": stats["pass_count"],
            "pass_pct": round(pass_pct, 1)
        })
    
    df = pd.DataFrame(data)
    df = df.sort_values("pass_pct", ascending=True)
    
    return df


def calculate_round_comparison(results: List[Dict[str, Any]], round_column: str = "round") -> Dict[str, pd.DataFrame]:
    """
    Calculate metrics by round if round information is available.
    
    Returns dict mapping round name to severity metrics DataFrame
    """
    if not results or round_column not in results[0]:
        return {}
    
    rounds = set(r.get(round_column, "All") for r in results)
    round_metrics = {}
    
    for round_name in rounds:
        round_results = [r for r in results if r.get(round_column) == round_name]
        if round_results:
            round_metrics[round_name] = calculate_severity_metrics(round_results)
    
    return round_metrics

