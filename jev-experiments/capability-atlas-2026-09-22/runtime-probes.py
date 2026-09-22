"""Provider-free validation probes; does not construct a model or API client."""
import importlib.util
import json
from pathlib import Path
import sys

LAB = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(LAB / "src"))
from jev_lab.core import Question

cases = {
    "plainNoul": {"type": "noul", "instructions": "Eligible?"},
    "structuredInstruction": {"type": "noul", "instructions": {"question": "Eligible?"}},
    "structuredChoice": {"type": "choice", "instructions": "Which?", "criteria": {"a": {"meaning": "A"}, "b": "B"}},
    "structuredScore": {"type": "score", "instructions": "How much?", "criteria": [{"meaning": "low"}, {"meaning": "high"}]},
    "noulCriteria": {"type": "noul", "instructions": "Eligible?", "criteria": {"true": "All rules hold", "false": "Any fails"}},
    "nullInstruction": {"type": "choice", "instructions": None, "criteria": {"a": "A", "b": "B"}},
    "nullChoiceDescription": {"type": "choice", "instructions": "Which?", "criteria": {"a": None, "b": "B"}},
    "scoreEleven": {"type": "score", "instructions": "Which?", "criteria": list(map(str, range(11)))},
}
checks = {}
for name, question in cases.items():
    try:
        Question.model_validate(question)
        checks[name] = "accepted"
    except Exception as error:
        checks[name] = "rejected: " + type(error).__name__
spec = importlib.util.spec_from_file_location("jev_local", LAB / "roadmap/mac/jev_local.py")
local = importlib.util.module_from_spec(spec)
spec.loader.exec_module(local)
question = {"id": "q", "kind": "boolean", "prompt": "Eligible?", "criteria": {"true": {"rules": ["A"]}, "false": "Failure"}}
try:
    local.validate({"schemaVersion": "1", "requestId": "probe", "state": "text", "questions": [question]})
    local_check = "accepted"
except Exception as error:
    local_check = "rejected: " + type(error).__name__
print(json.dumps({
    "networkCalls": 0,
    "coreValidation": checks,
    "macExtraCriteriaValidation": local_check,
    "macOptions": local.options(question),
}, indent=2))
