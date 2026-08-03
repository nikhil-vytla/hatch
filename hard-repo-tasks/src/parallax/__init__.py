"""Repository-to-task compiler with executable, counterfactual contracts."""

from parallax.compiler import compile_recipe
from parallax.evolving_intent import EvolvingIntent
from parallax.grading import grade_candidate
from parallax.gsm8k import Gsm8k
from parallax.kernel import Family, Verdict, build, run
from parallax.models import Recipe, TaskManifest

__all__ = [
    "EvolvingIntent",
    "Family",
    "Gsm8k",
    "Recipe",
    "TaskManifest",
    "Verdict",
    "build",
    "compile_recipe",
    "grade_candidate",
    "run",
]
