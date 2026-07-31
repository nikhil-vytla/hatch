"""Repository-to-task compiler with executable, counterfactual contracts."""

from parallax.compiler import compile_recipe
from parallax.grading import grade_candidate
from parallax.models import Recipe, TaskManifest

__all__ = ["Recipe", "TaskManifest", "compile_recipe", "grade_candidate"]
