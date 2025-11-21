"""Shared utilities for Streamlit app pages."""

import json
from pathlib import Path
from datetime import datetime
import uuid


def load_eval_results():
    """Load saved eval results if they exist."""
    results_path = Path("data/evals/results.json")
    if results_path.exists():
        with open(results_path, "r") as f:
            return json.load(f)
    return []


def load_threads():
    """Load threads from file if they exist."""
    threads_path = Path("data/threads/threads.json")
    if threads_path.exists():
        try:
            with open(threads_path, "r") as f:
                return json.load(f)
        except Exception:
            return {}
    return {}


def save_threads(threads):
    """Save threads to file."""
    Path("data/threads").mkdir(parents=True, exist_ok=True)
    threads_path = Path("data/threads/threads.json")
    with open(threads_path, "w") as f:
        json.dump(threads, f, indent=2)


def save_taxonomy(taxonomy_data: dict, source: str, identifier: str = None):
    """
    Save a taxonomy to disk.
    
    Args:
        taxonomy_data: Dictionary containing taxonomy data (same format as session state)
        source: Either "generated" or "from_dataset"
        identifier: Optional identifier (UUID or timestamp). If None, generates one.
    
    Returns:
        The identifier used for the saved taxonomy
    """
    if identifier is None:
        identifier = f"{datetime.now().strftime('%Y%m%d_%H%M%S')}_{str(uuid.uuid4())[:8]}"
    
    taxonomies_dir = Path(f"data/taxonomies/{source}")
    taxonomies_dir.mkdir(parents=True, exist_ok=True)
    
    taxonomy_file = taxonomies_dir / f"{identifier}.json"
    with open(taxonomy_file, "w") as f:
        json.dump(taxonomy_data, f, indent=2)
    
    return identifier


def load_taxonomies(source: str = None):
    """
    Load taxonomies from disk.
    
    Args:
        source: Optional filter - "generated", "from_dataset", or None for all
    
    Returns:
        List of taxonomy dictionaries with added "identifier" and "source" fields
    """
    taxonomies = []
    
    if source is None or source == "generated":
        generated_dir = Path("data/taxonomies/generated")
        if generated_dir.exists():
            for taxonomy_file in generated_dir.glob("*.json"):
                try:
                    with open(taxonomy_file, "r") as f:
                        taxonomy_data = json.load(f)
                    taxonomy_data["identifier"] = taxonomy_file.stem
                    taxonomy_data["source"] = "generated"
                    taxonomies.append(taxonomy_data)
                except Exception:
                    continue
    
    if source is None or source == "from_dataset":
        dataset_dir = Path("data/taxonomies/from_dataset")
        if dataset_dir.exists():
            for taxonomy_file in dataset_dir.glob("*.json"):
                try:
                    with open(taxonomy_file, "r") as f:
                        taxonomy_data = json.load(f)
                    taxonomy_data["identifier"] = taxonomy_file.stem
                    taxonomy_data["source"] = "from_dataset"
                    taxonomies.append(taxonomy_data)
                except Exception:
                    continue
    
    # Sort by timestamp (most recent first)
    taxonomies.sort(key=lambda x: x.get("timestamp", ""), reverse=True)
    return taxonomies


def delete_taxonomy(identifier: str, source: str):
    """Delete a taxonomy from disk."""
    taxonomy_file = Path(f"data/taxonomies/{source}/{identifier}.json")
    if taxonomy_file.exists():
        taxonomy_file.unlink()
        return True
    return False

