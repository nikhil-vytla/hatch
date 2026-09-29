"""Fast tests of the eval's plan, cost estimate, journal reading and
statistics: `python3 -m unittest discover -s scripts/eval`. They run no
model and no daemon; selfcheck.py covers the suite and the plumbing."""

import json
import math
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import evallib as ev  # noqa: E402
import stats  # noqa: E402

TASKS = ev.load_tasks()
FAMS = ev.families(TASKS)
KINDS = ev.kinds(TASKS)


class PlanTest(unittest.TestCase):
    def test_each_ordering_puts_every_seed_before_its_tests(self):
        for k in range(3):
            seq = ev.ordering(FAMS, k, 2026)
            for fam in FAMS:
                positions = [i for i, (f, inst, probe) in enumerate(seq) if f == fam and not probe]
                insts = [seq[i][1] for i in positions]
                self.assertEqual(insts[0], "seed", fam)
                self.assertEqual(sorted(insts[1:]), ["t1", "t2", "t3"], fam)

    def test_orderings_differ_and_repeat(self):
        self.assertNotEqual(ev.ordering(FAMS, 0, 2026), ev.ordering(FAMS, 1, 2026))
        self.assertEqual(ev.ordering(FAMS, 0, 2026), ev.ordering(FAMS, 0, 2026))

    def test_the_first_families_are_probed_again_at_the_end(self):
        seq = ev.ordering(FAMS, 0, 2026)
        probes = [(f, i) for f, i, p in seq if p]
        self.assertEqual(len(probes), ev.PROBES)
        first = []
        for f, _, _ in seq:
            if f not in first:
                first.append(f)
        self.assertEqual({f for f, _ in probes}, set(first[: ev.PROBES]))
        self.assertTrue(all(p for _, _, p in seq[-ev.PROBES:]))

    def test_the_full_plan_has_adr_0021s_shape(self):
        trials = ev.plan(TASKS, list(ev.ARMS), FAMS, 2026)
        per_arm = {a: sum(1 for t in trials if t.arm == a) for a in ev.ARMS}
        self.assertEqual(per_arm, {"F": 153, "L": 153, "O": 102, "P": 51, "placebo": 51})
        pairs = [t for t in trials if t.arm == "L" and t.role == "test" and not t.probe and KINDS[t.family] == "learnable"]
        self.assertEqual(len(pairs), 81)
        poisoned = {t.family for t in trials if t.arm == "P" and t.instance == "seed-poison"}
        self.assertEqual(poisoned, set(ev.POISONED))
        self.assertFalse(any(t.instance == "seed-poison" for t in trials if t.arm != "P"))

    def test_the_screen_runs_only_calibration_instances_under_f_and_o(self):
        trials = ev.screen_plan(TASKS, FAMS)
        self.assertEqual({t.arm for t in trials}, {"F", "O"})
        self.assertEqual({t.role for t in trials}, {"calibration"})
        self.assertEqual(len(trials), 2 * 2 * len(FAMS))


class EstimateTest(unittest.TestCase):
    def test_assumed_costs_follow_haiku_prices(self):
        trials = ev.plan(TASKS, list(ev.ARMS), FAMS, 2026)
        est = ev.estimate(trials, "claude-haiku-4-5-20251001")
        self.assertEqual((est["tasks"], est["learner_runs"]), (510, 204))
        # 4k input, 20k cache write, 90k cache read, 2.5k output at $1, $1.25, $0.1, $5 per million.
        self.assertAlmostEqual(est["per_task"]["low"], 0.004 + 0.025 + 0.009 + 0.0125)
        self.assertLess(est["low"], est["high"])

    def test_measured_costs_replace_the_assumptions(self):
        with tempfile.TemporaryDirectory() as tmp:
            p = Path(tmp) / "results.jsonl"
            rows = [{"type": "trial", "cost_usd": 0.1}, {"type": "trial", "cost_usd": 0.3, "learner": {"cost_usd": 0.02}}]
            p.write_text("\n".join(json.dumps(r) for r in rows))
            m = ev.measured_costs(p)
        self.assertAlmostEqual(m["task"], 0.2)
        est = ev.estimate([ev.Trial("L", 0, 0, "api-version", "seed", "seed")], "claude-haiku-4-5", m)
        self.assertAlmostEqual(est["low"], 0.2 + 0.02)
        self.assertTrue(est["basis"].startswith("measured"))

    def test_an_unpriced_model_is_refused(self):
        with self.assertRaises(SystemExit):
            ev.price_of("gpt-9")


def entry(event: dict) -> str:
    return json.dumps({"seq": 1, "tsMs": 0, "event": event})


class JournalTest(unittest.TestCase):
    LINES = [
        entry({"type": "contextLoaded", "instructions": [{"path": "/tmp/x/.strive/memory.md", "digest": "d", "bytes": 3}],
               "skills": [], "mcp": []}),
        entry({"type": "modelCallStarted", "call": 1, "provider": "anthropic", "model": "claude-haiku-4-5",
               "request": "r", "reservedUsdMicros": 1, "reservedTokens": 1}),
        entry({"type": "modelCallFinished", "call": 1, "durationMs": 1, "response": "sha256:a",
               "outcome": {"kind": "complete", "status": 200, "costUsdMicros": 1500,
                           "usage": {"input": 10, "output": 5, "cacheWrite": 2, "cacheRead": 7}}}),
        entry({"type": "assistantMessage", "turn": 1, "text": "", "toolCalls": [], "message": {}}),
        entry({"type": "effectStarted", "effect": 1, "callId": "c",
               "record": {"kind": "bash", "command": "TALLY_FX_RATES=tests/fixtures/rates.csv ./dev test", "timeoutMs": 1}}),
        entry({"type": "effectStarted", "effect": 2, "callId": "d", "record": {"kind": "read", "path": "/repo/eval/tasks/x/check.py"}}),
        entry({"type": "turnEnded", "turn": 1, "reason": {"kind": "done"}}),
    ]

    def test_reads_what_the_eval_records(self):
        s = ev.read_journal(self.LINES)
        self.assertEqual((s.model_calls, s.assistant_messages, s.turn_end), (1, 1, "done"))
        self.assertAlmostEqual(s.cost_usd, 0.0015)
        self.assertTrue(s.memory_loaded)
        self.assertEqual(s.tokens, {"input": 10, "output": 5, "cacheRead": 7, "cacheWrite": 2})
        self.assertEqual(s.response_digests, ["sha256:a"])

    def test_memory_not_loaded_without_the_memory_file(self):
        lines = [entry({"type": "contextLoaded", "instructions": [{"path": "/tmp/x/AGENTS.md", "digest": "d", "bytes": 3}],
                        "skills": [], "mcp": []})]
        self.assertFalse(ev.read_journal(lines).memory_loaded)

    def test_followed_and_peeked(self):
        s = ev.read_journal(self.LINES)
        self.assertTrue(ev.followed_commands(s, [r"TALLY_FX_RATES"]))
        self.assertFalse(ev.followed_commands(s, [r"\./dev lock"]))
        self.assertIsNone(ev.followed_commands(s, []))
        self.assertEqual(ev.peeked(s, ["eval/tasks"]), ["/repo/eval/tasks/x/check.py"])
        self.assertEqual(ev.peeked(s, ["check-data"]), [])

    def test_leakage_is_a_test_instances_unique_string_in_learned_files(self):
        task = TASKS[("regression-test", "t1")]
        with tempfile.TemporaryDirectory() as tmp:
            d = Path(tmp)
            (d / "memory.md").write_text("- Ticket fixes get a regression test named after the ticket.\n")
            self.assertEqual(ev.leaked(d, task), [])
            (d / "memory.md").write_text("- TAL-2291 was add_months.\n")
            self.assertEqual(ev.leaked(d, task), ["TAL-2291"])


class StatsTest(unittest.TestCase):
    def test_wilson(self):
        lo, hi = stats.wilson(5, 10)
        self.assertAlmostEqual(lo, 0.2366, places=3)
        self.assertAlmostEqual(hi, 0.7634, places=3)
        self.assertAlmostEqual(stats.wilson(0, 3)[0], 0.0)
        self.assertAlmostEqual(stats.wilson(0, 3)[1], 0.5615, places=3)
        self.assertTrue(math.isnan(stats.wilson(0, 0)[0]))

    def test_exact_binomial_and_mcnemar(self):
        self.assertAlmostEqual(stats.binom_two_sided(0, 5), 0.0625)
        self.assertAlmostEqual(stats.binom_two_sided(2, 4), 1.0)
        m = stats.mcnemar([(True, False)] * 8 + [(False, True)] * 1 + [(True, True)] * 5)
        self.assertEqual((m["treatment_only"], m["control_only"]), (8, 1))
        self.assertAlmostEqual(m["p"], 20 / 512)

    def test_sign_test_drops_ties(self):
        s = stats.sign_test([0.5, 0.3, 0.0, -0.1])
        self.assertEqual((s["positive"], s["negative"], s["ties"]), (2, 1, 1))

    def test_wilcoxon(self):
        self.assertEqual(stats.wilcoxon([0, 0])["n"], 0)
        down = stats.wilcoxon([-float(i) for i in range(1, 21)])
        self.assertLess(down["p"], 0.001)
        self.assertLess(down["z"], 0)
        even = stats.wilcoxon([1, -1, 2, -2, 3, -3])
        self.assertGreater(even["p"], 0.9)

    def test_cluster_bootstrap(self):
        point, lo, hi = stats.cluster_bootstrap([("a", 1.0), ("b", 1.0), ("c", 1.0)], reps=200)
        self.assertEqual((point, lo, hi), (1.0, 1.0, 1.0))
        point, lo, hi = stats.cluster_bootstrap([("a", 1.0), ("a", 1.0), ("b", 0.0), ("b", 0.0)], reps=2000)
        self.assertEqual(point, 0.5)
        self.assertEqual((lo, hi), (0.0, 1.0))


def trial(arm, seq, fam, inst, passed, turns=10, role="test", probe=False, cost=0.05, **extra):
    return {"arm": arm, "sequence": seq, "family": fam, "instance": inst, "role": role, "probe": probe,
            "passed": passed, "turns": turns, "cost_usd": cost, "memory_loaded": arm != "F", "followed": passed,
            "kind": KINDS[fam], "signals": extra.pop("signals", {}), **extra}


class HypothesesTest(unittest.TestCase):
    def make(self, l_pass: bool) -> list[dict]:
        learnable = [f for f in FAMS if KINDS[f] == "learnable"]
        out = []
        for k in range(3):
            for fam in learnable:
                for inst in ("t1", "t2", "t3"):
                    out.append(trial("F", k, fam, inst, False, turns=10))
                    out.append(trial("L", k, fam, inst, l_pass, turns=6 if l_pass else 10, cost=0.03 if l_pass else 0.05,
                                     learner={"cost_usd": 0.02}))
        for k in range(2):
            for fam in learnable:
                for inst in ("t1", "t2", "t3"):
                    out.append(trial("O", k, fam, inst, True))
        for fam in learnable:
            for inst in ("t1", "t2", "t3"):
                out.append(trial("P", 0, fam, inst, l_pass))
                out.append(trial("placebo", 0, fam, inst, False))
        for k in range(3):
            for fam in [f for f in FAMS if KINDS[f] == "generic"]:
                out += [trial("F", k, fam, "t1", True), trial("L", k, fam, "t1", True)]
            out.append(trial("L", k, "conflicting-keys", "t1", True, signals={"cross_applied": False}))
        return out

    def test_learning_that_works_passes_every_hypothesis(self):
        s = stats.summarize(self.make(True), KINDS)
        self.assertEqual(s["L_minus_F"]["pairs"], 81)
        names = ("H1", "H2", "H3", "H4", "H5", "H6", "H7")
        self.assertEqual({h: s["hypotheses"][h]["result"] for h in names}, dict.fromkeys(names, "pass"))
        self.assertAlmostEqual(s["L_minus_F"]["cost_ratio"], 0.6)
        self.assertLess(s["L_minus_F"]["cost_wilcoxon"]["p"], 0.001)
        self.assertAlmostEqual(s["L_minus_F"]["learner_cost_mean"], 0.02)
        md = stats.markdown(s, {"label": "t", "model": "m", "trials": 1, "cost_usd": 0})
        self.assertIn("**H1** PASS", md)
        self.assertIn("**H7** PASS", md)
        self.assertIn("L/F = 0.60", md)

    def test_the_report_gives_each_familys_turns_and_cost_by_arm(self):
        s = stats.summarize(self.make(True), KINDS)
        fam = s["per_family"]["api-version"]["arms"]
        self.assertEqual((fam["F"]["n"], fam["F"]["passes"], fam["F"]["turns_mean"], fam["F"]["cost_mean"]), (9, 0, 10, 0.05))
        self.assertEqual((fam["O"]["n"], fam["O"]["passes"]), (6, 6))
        self.assertEqual((fam["L"]["turns_mean"], fam["L"]["cost_mean"]), (6, 0.03))
        md = stats.markdown(s, {"label": "t", "model": "m", "trials": 1, "cost_usd": 0})
        row = next(line for line in md.splitlines() if line.startswith("| api-version |"))
        self.assertIn("0/9 pass, 10.0 turns, $0.0500", row)
        self.assertIn("6/6 pass", row)

    def test_learning_that_does_nothing_fails_h1_h2_and_h5(self):
        s = stats.summarize(self.make(False), KINDS)
        results = {h: s["hypotheses"][h]["result"] for h in ("H1", "H2", "H5", "H7")}
        self.assertEqual(results, {"H1": "fail", "H2": "fail", "H5": "fail", "H7": "fail"})

    def test_cross_application_fails_h4(self):
        ts = self.make(True) + [trial("L", 0, "conflicting-keys", "t2", False, signals={"cross_applied": True})]
        self.assertEqual(stats.summarize(ts, KINDS)["hypotheses"]["H4"]["result"], "fail")

    def test_missing_arms_are_not_run(self):
        ts = [t for t in self.make(True) if t["arm"] in ("F", "L")]
        h = stats.summarize(ts, KINDS)["hypotheses"]
        self.assertEqual((h["H2"]["result"], h["H6"]["result"]), ("not run", "not run"))

    def test_screen_keeps_families_with_headroom_that_memory_closes(self):
        ts = [trial("F", 0, "api-version", "c1", False, role="calibration", turns=20, cost=0.06),
              trial("F", 0, "api-version", "c2", True, role="calibration", turns=10, cost=0.04),
              trial("O", 0, "api-version", "c1", True, role="calibration", turns=8, cost=0.03),
              trial("O", 0, "api-version", "c2", True, role="calibration", turns=6, cost=0.02),
              trial("F", 0, "lockfile", "c1", True, role="calibration"), trial("F", 0, "lockfile", "c2", True, role="calibration"),
              trial("O", 0, "lockfile", "c1", True, role="calibration"), trial("O", 0, "lockfile", "c2", True, role="calibration"),
              trial("F", 0, "generic-logic", "c1", True, role="calibration")]
        fams = stats.screen(ts, KINDS)
        self.assertTrue(fams["api-version"]["keep"])
        self.assertEqual((fams["api-version"]["turns"], fams["api-version"]["n"]), ({"F": 15, "O": 7}, [2, 2]))
        self.assertAlmostEqual(fams["api-version"]["cost"]["O"], 0.025)
        paired = stats.screen_paired(ts)
        self.assertEqual(paired["pairs"], 4)
        self.assertAlmostEqual(paired["turns_ratio"], 34 / 50)
        md = stats.screen_markdown(fams, {"label": "s", "model": "m", "cost_usd": 0, "trials": 9, "paired": paired})
        self.assertIn("| api-version | learnable | 50% | 100% | 2, 2 | 15.00 | 7.00 | $0.0500 | $0.0250 | yes |", md)
        self.assertIn("turns: O/F = 0.68", md)
        self.assertFalse(fams["lockfile"]["keep"])
        self.assertTrue(fams["generic-logic"]["keep"])

    def test_forgetting_compares_a_probe_with_the_first_run(self):
        ts = [trial("L", 0, "api-version", "t1", True), trial("L", 0, "api-version", "t1", False, probe=True)]
        self.assertEqual(stats.forgetting(ts)["L"]["passed_then_failed"], 1)


if __name__ == "__main__":
    unittest.main()
