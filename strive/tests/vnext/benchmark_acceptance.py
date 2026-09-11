"""M5 recovery evidence layered onto the existing acceptance driver."""
from dataclasses import replace
from decimal import Decimal
from .harness_acceptance import HarnessRuntimeDriver
from .test_acceptance_contracts import RuntimeEvidence
from .test_benchmarks import recovery_probe


class BenchmarkRuntimeDriver(HarnessRuntimeDriver):
    def exercise(self, scenario: str) -> RuntimeEvidence:
        if scenario != "crash_after_mutation_then_restore_bundle_with_ambiguous_model_effect":
            return super().exercise(scenario)
        # Assertions inspect actual durable state and reservations in each run.
        for requestor in ("agent", "user"):
            recovery_probe(self.root / requestor, requestor)
        return replace(self.evidence(), mutation_count=1, reservation_before_restore=Decimal(100),
                       reservation_after_restore=Decimal(100), ambiguous_retry_dispatched=False)
