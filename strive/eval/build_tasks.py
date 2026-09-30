#!/usr/bin/env python3
"""Writes eval/tasks/ from the definitions below.

    python3 eval/build_tasks.py           # (re)write eval/tasks
    python3 eval/build_tasks.py --check   # exit 1 if eval/tasks differs from what this writes

Each task is a directory eval/tasks/<family>/<instance>/ holding:
- task.json: its family, role (seed, test, calibration or poison), what
  shows the lesson was followed, and strings unique to it (for leakage);
- instruction.md: what a person asks the agent;
- setup/: files laid over the project template before the agent starts;
- oracle/: files laid over the set-up workspace that solve the task, then
  task.json's oracle_run commands (./dev gen, ./dev lock);
- check.py: the verifier, run on a copy of the finished workspace. It lives
  here, never in the workspace, so the agent can't read it;
- check-data/ (some families): files only the check uses, such as mutants.

Setups and oracles are written as edits to the template's text, so each
instance states only what differs.
"""

from __future__ import annotations

import filecmp
import json
import re
import shutil
import sys
import tempfile
import textwrap
from dataclasses import dataclass, field
from pathlib import Path

EVAL = Path(__file__).resolve().parent
TEMPLATE = EVAL / "project"
TASKS = EVAL / "tasks"


@dataclass
class Edit:
    path: str
    old: str | None  # None: the file is new, `new` is all of it
    new: str


def E(path: str, old: str | None, new: str) -> Edit:
    return Edit(path, old, new)


@dataclass
class Task:
    family: str
    instance: str
    role: str  # seed | test | calibration | poison
    instruction: str
    check: str  # the body of check(ws), in Python
    setup: list[Edit] = field(default_factory=list)
    oracle: list[Edit] = field(default_factory=list)
    oracle_run: list[list[str]] = field(default_factory=list)
    followed_commands: list[str] = field(default_factory=list)
    unique: list[str] = field(default_factory=list)
    mutant: list[Edit] = field(default_factory=list)
    restore_tests: bool = True
    # A solution that does the task but ignores the family's rule; the
    # check must fail it. Laid over the set-up workspace like the oracle.
    violation: list[Edit] = field(default_factory=list)


FAMILIES = {
    "regression-test": ("learnable", "A fix for a ticket adds a regression test named after it, tests/regressions/test_tal_<number>.py, that fails without the fix."),
    "currency-coverage": ("learnable", "Tests of code that returns Money include a JPY case: JPY has no minor units, so a rounding bug that assumes two decimals passes every EUR test."),
    "deprecate-alias": ("learnable", "Renaming a public function keeps the old name for a release: a wrapper that warns with DeprecationWarning (stacklevel=2) and calls the new one."),
    "codeowners": ("learnable", "A new module under tally/ gets a line in .github/CODEOWNERS: its path and the team that owns it."),
    "api-version": ("learnable", "Any change to the keys tally_api returns (added, removed or renamed) bumps API_VERSION's minor in tally_api/__init__.py, 1.4 to 1.5."),
    "versionadded": ("learnable", "Every new public function in tally/ ends its docstring with '.. versionadded:: 0.10', the next release."),
    "audit-event": ("learnable", "Code in tally/ that changes an invoice or a payment records it with tally.audit.record('<noun>.<verb>', invoice=<number>, ...)."),
    "changelog": ("learnable", "Every change to tally/ or tally_api/ adds a fragment changes/<slug>.<added|changed|fixed|removed>.md, one '- ...' line; ./dev changes checks it."),
    "lockfile": ("learnable", "After changing dependencies in pyproject.toml, run ./dev lock to regenerate tally.lock; never edit it by hand."),
    "generic-logic": ("generic", "No quirk: plain logic bugs, described in the request."),
    "generic-parsing": ("generic", "No quirk: parsing and formatting bugs, described in the request."),
    "conflicting-keys": ("conflict", "tally/export.py keys are snake_case (warehouse columns); tally_api/ keys are camelCase (the web app)."),
}

# The families rebuilt after the first screen, where the frozen arm passed
# the old ones by reading the repository. Nothing in the workspace states
# these rules: selfcheck.py scans every set-up workspace for the patterns
# below (case-insensitive), allowing each only in the paths listed. And a
# fix that does the task but ignores the rule fails only the checks named
# "rule: ...", so the rule is what the check tests.
HIDDEN = {
    "regression-test": [(r"regression", []), (r"\bTAL-?\d", []), (r"tal_\d", [])],
    "currency-coverage": [(r"zero.decimal", []), (r"JPY case", []), (r"two decimals", []), (r"every currency", [])],
    "deprecate-alias": [(r"deprecat", []), (r"\bwarnings\b", []), (r"\balias", [])],
    "codeowners": [(r"codeowners", []), (r"\bowner", []), (r"@tally/", [".github/CODEOWNERS"])],
    "api-version": [(r"API_VERSION", ["tally_api/__init__.py"]), (r"\bbump", [])],
    "versionadded": [(r"versionadded", []), (r"\b0\.10\b", [])],
    "audit-event": [(r"\baudit", ["tally/audit.py", ".github/CODEOWNERS"])],
}

# ---------------------------------------------------------------- check bodies

DEV_TEST = 'ws.check("./dev test passes", *ws.dev("test"))\n'


def hidden(code: str, env: str = "None") -> str:
    return f"ws.check(\"the task's own assertions\", *ws.py({textwrap.dedent(code).strip()!r}, env={env}))\n"

def changelog_check(kind: str, code: str) -> str:
    return (
        DEV_TEST
        + hidden(code)
        + textwrap.dedent(
            f"""
            name = re.compile(r"^changes/[a-z0-9]+(-[a-z0-9]+)*\\.(added|changed|fixed|removed)\\.md$")
            fragments = [p for p in ws.changed_since_start() if name.match(p)]
            ws.signals["followed"] = bool(fragments)
            ws.signals["kind_matches"] = any(p.endswith(".{kind}.md") for p in fragments)
            ws.check("a changelog fragment was added in changes/", bool(fragments), "no changes/<slug>.<kind>.md was added")
            ws.check("./dev changes passes", *ws.dev("changes"))
            """
        )
    )


def lock_check(dep_test: str, lock_lines: list[str]) -> str:
    return textwrap.dedent(
        f"""
        import tomllib
        deps = tomllib.loads(ws.read("pyproject.toml"))["project"]["dependencies"]
        ws.check("pyproject.toml has the change", {dep_test}, repr(deps))
        ok, out = ws.run([sys.executable, "tools/lock.py", "--check"])
        ws.signals["followed"] = ok
        ws.check("tally.lock matches pyproject.toml", ok, out)
        lock = ws.read("tally.lock")
        missing = [l for l in {lock_lines!r} if l not in lock]
        ws.check("tally.lock pins what it should", not missing, "missing: " + ", ".join(missing))
        """
    ) + DEV_TEST


def generic_check(code: str) -> str:
    return DEV_TEST + hidden(code)


def conflict_check(package: str, produce: str, expected: str) -> str:
    # export wants snake_case, so a capital is the other package's style;
    # the API wants camelCase, so an underscore is.
    if package == "export":
        right, wrong = "SNAKE.match(k)", "any(ch.isupper() for ch in k)"
    else:
        right, wrong = 'CAMEL.match(k) and "_" not in k', '"_" in k'
    code = f"""
import json
from tests.support import sample_invoice, sample_customer
{textwrap.dedent(produce).strip()}
print(json.dumps({{k: (v if isinstance(v, (str, int, float, bool, type(None))) else str(v)) for k, v in obj.items()}}))
"""
    return DEV_TEST + textwrap.dedent(
        f"""
        ok, out = ws.py({code.strip()!r})
        ws.check("the output can be built", ok, out)
        obj = json.loads(out.strip().splitlines()[-1]) if ok else {{}}
        expected = {expected!r}
        keys = [k for k, v in obj.items() if str(v) == expected]
        ws.signals["cross_applied"] = any({wrong} for k in keys)
        ws.signals["followed"] = any({right} for k in keys)
        ws.check("the new field is there, in {package}'s key style", ws.signals["followed"], f"keys holding {{expected!r}}: {{keys}}")
        """
    )


def regression_check(ticket: str, module: str, code: str) -> str:
    """The fix, and a test named after the ticket anywhere under tests/
    that passes with the fix and fails with the bug put back."""
    num = ticket.split("-")[1]
    return DEV_TEST + hidden(code) + textwrap.dedent(
        f"""
        found = sorted(p for p in (ws.source / "tests").rglob("test*.py") if re.search(r"tal[_-]?{num}(?!\\d)", p.name, re.I))
        ws.signals["followed"] = bool(found)
        ws.check("rule: a regression test named after {ticket}", bool(found), "no tests/regressions/test_tal_{num}.py")
        if found:
            modules = []
            for p in found:
                rel = p.relative_to(ws.source)
                (ws.root / rel).parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(p, ws.root / rel)
                for parent in rel.parents:
                    if parent.parts and not (ws.root / parent / "__init__.py").exists():
                        (ws.root / parent / "__init__.py").touch()
                modules.append(".".join(rel.with_suffix("").parts))
            ok, out = ws.run([sys.executable, "-m", "unittest", *modules])
            ws.check("rule: the regression test passes with the fix", ok, out)
            shutil.copy2(ws.task / "setup" / {module!r}, ws.root / {module!r})
            ok, out = ws.run([sys.executable, "-m", "unittest", *modules])
            ws.check("rule: the regression test fails without the fix", not ok, "it still passes with the bug put back")
        """
    )


def coverage_check(target: str) -> str:
    """The agent's tests cover `target`, pass, and catch a mutant that
    rounds to two decimals whatever the currency: identical for EUR, wrong
    for JPY."""
    return textwrap.dedent(
        f"""
        ws.check("./dev test passes", *ws.dev("test"))
        pattern = re.compile(r"\\b{target}\\b")
        files = sorted(p for p in (ws.root / "tests").glob("test*.py") if pattern.search(p.read_text()))
        ws.check("a test module covers {target}", bool(files), "no tests/test*.py mentions {target}")
        ws.signals["followed"] = any(re.search(r"\\b(JPY|BHD)\\b", p.read_text()) for p in files)
        if files:
            modules = ["tests." + p.stem for p in files]
            for f in (ws.task / "check-data" / "mutant").rglob("*"):
                if f.is_file():
                    shutil.copy2(f, ws.root / f.relative_to(ws.task / "check-data" / "mutant"))
            ok, out = ws.run([sys.executable, "-m", "unittest", *modules])
            ws.check("rule: the tests catch {target} rounding as if every currency had two decimals", not ok,
                     "the tests still pass when {target} rounds JPY to two decimals")
        """
    )


def alias_check(module: str, old: str, new: str, call: str, expected: str) -> str:
    """The new name works, and the old one still does, warning that it's deprecated."""
    renamed = f"""
from {module} import {new}
got = {new}{call}
assert got == {expected}, got
"""
    old_works = f"""
import warnings
import {module} as m
fn = getattr(m, {old!r}, None)
assert fn is not None, "{module}.{old} is gone"
with warnings.catch_warnings(record=True) as caught:
    warnings.simplefilter("always")
    got = fn{call}
assert got == {expected}, got
assert any(issubclass(w.category, DeprecationWarning) for w in caught), "calling {old} doesn't warn with DeprecationWarning"
"""
    return (
        DEV_TEST
        + hidden(renamed)
        + f"ok, out = ws.py({old_works.strip()!r})\n"
        + 'ws.signals["followed"] = ok\n'
        + f'ws.check("rule: {module}.{old} still works and warns that it is deprecated", ok, out)\n'
    )


def owners_check(path: str, code: str) -> str:
    return DEV_TEST + hidden(code) + textwrap.dedent(
        f"""
        rows = [line.split() for line in ws.read(".github/CODEOWNERS").splitlines() if line.strip() and not line.lstrip().startswith("#")]
        owned = [r for r in rows if r[0].lstrip("/") == {path!r} and len(r) > 1 and all(o.startswith("@") for o in r[1:])]
        ws.signals["followed"] = bool(owned)
        ws.check("rule: .github/CODEOWNERS names the owners of {path}", bool(owned), "no line for /{path} in .github/CODEOWNERS")
        """
    )


def version_check(code: str) -> str:
    return DEV_TEST + hidden(code) + textwrap.dedent(
        """
        ok, out = ws.py("import tally_api; print(tally_api.API_VERSION)")
        version = out.strip().splitlines()[-1] if ok and out.strip() else out[-300:]
        ws.signals["followed"] = version == "1.5"
        ws.check("rule: tally_api.API_VERSION's minor was bumped, 1.4 to 1.5", version == "1.5", f"API_VERSION is {version!r}")
        """
    )


def since_check(path: str, name: str, code: str) -> str:
    return DEV_TEST + hidden(code) + textwrap.dedent(
        f"""
        import ast
        tree = ast.parse(ws.read({path!r}) or "pass")
        fn = next((n for n in tree.body if isinstance(n, (ast.FunctionDef, ast.ClassDef)) and n.name == {name!r}), None)
        doc = (ast.get_docstring(fn) or "") if fn else ""
        marked = re.search(r"\\.\\. versionadded:: 0\\.10(?![\\d.])", doc) is not None
        ws.signals["followed"] = marked
        ws.check("rule: {name}'s docstring says '.. versionadded:: 0.10'", marked, repr(doc[-300:]))
        """
    )


def audit_check(number: str, prepare: str, act: str) -> str:
    """Runs `prepare`, clears the trail, runs `act` (which asserts the
    behaviour), then looks for a dotted event naming the invoice."""
    code = (
        textwrap.dedent(prepare).strip()
        + "\nfrom tally import audit\naudit.clear()\n"
        + textwrap.dedent(act).strip()
        + "\nimport json\nprint(json.dumps(audit.events(), default=str))"
    )
    return DEV_TEST + textwrap.dedent(
        f"""
        ok, out = ws.py({code!r})
        ws.check("the task's own assertions", ok, out)
        events = json.loads(out.strip().splitlines()[-1]) if ok else []
        ws.signals["followed"] = bool(events)
        recorded = [e for e in events if re.fullmatch(r"[a-z_]+(\\.[a-z_]+)+", str(e.get("event", ""))) and {number!r} in json.dumps(e, default=str)]
        ws.check("rule: the change was recorded with tally.audit.record('<noun>.<verb>', invoice=...)", bool(recorded), f"audit events: {{events}}")
        """
    )


def rename(path: str, old: str, new: str, alias: bool) -> Edit:
    """The module at `path` with `old` renamed to `new` (its definition,
    calls, doctests and __all__), and with `alias`, `old` kept as a
    deprecated wrapper."""
    text = (TEMPLATE / path).read_text()
    text = re.sub(rf"\b{old}(?=\()", new, text)
    m = re.search(r"__all__ = \[(.*?)\]", text, re.S)
    names = [n for n in re.findall(r'"([^"]+)"', m.group(1)) if n != old] + [new] + ([old] if alias else [])
    names = sorted(names)
    one_line = "__all__ = [" + ", ".join(f'"{n}"' for n in names) + "]"
    listed = one_line if "\n" not in m.group(1) and len(one_line) <= 120 else "__all__ = [\n" + "".join(f'    "{n}",\n' for n in names) + "]"
    text = text[: m.start()] + listed + text[m.end():]
    if alias:
        lines = text.split("\n")
        start = lines.index("from __future__ import annotations") + 2
        at = start
        while lines[at].startswith("import ") and lines[at] < "import warnings":
            at += 1
        lines.insert(at, "import warnings")
        text = "\n".join(lines)
        text = text.rstrip("\n") + textwrap.dedent(f'''


            def {old}(*args, **kwargs):
                """Deprecated: use `{new}`."""
                warnings.warn("{old} is deprecated; use {new}", DeprecationWarning, stacklevel=2)
                return {new}(*args, **kwargs)
            ''')
    return E(path, None, text)


def two_places(expr: str, currency: str) -> str:
    """`expr` (Money) rounded to two decimals whatever its currency."""
    return f'Money(({expr}).amount.quantize(Decimal("0.01")), {currency})'


def owners_line(anchor: str, path: str, team: str) -> Edit:
    """A CODEOWNERS line for `path`, after the line for `anchor`."""
    line = next(line for line in (TEMPLATE / ".github/CODEOWNERS").read_text().splitlines() if line.startswith(anchor + " "))
    return E(".github/CODEOWNERS", line + "\n", f"{line}\n{path:<24}{team}\n")


BUMP = E("tally_api/__init__.py", 'API_VERSION = "1.4"', 'API_VERSION = "1.5"')
INVOICE_KEYS = ["invoiceNumber", "customerId", "currency", "issuedOn", "lineCount", "totalFormatted"]
CUSTOMER_KEYS = ["customerId", "name", "email", "country", "vatId"]


# ---------------------------------------------------------------- the tasks

T: list[Task] = []

# regression-test: ticket fixes come with a regression test named after the ticket.
def regression_task(instance: str, role: str, ticket: str, instruction: str, module: str, good: str, bad: str,
                    code: str, test: str, naive_path: str, unique: list[str]) -> Task:
    num = ticket.split("-")[1]
    fix = E(module, bad, good)
    return Task(
        "regression-test", instance, role, instruction, regression_check(ticket, module, code),
        setup=[E(module, good, bad)],
        oracle=[fix, E("tests/regressions/__init__.py", None, ""), E(f"tests/regressions/test_tal_{num}.py", None, test)],
        violation=[fix, E(naive_path, None, test)],
        unique=unique,
    )


def regression_test(imports: str, cls: str, name: str, body: str) -> str:
    return f"import unittest\n\n{imports}\n\n\nclass {cls}(unittest.TestCase):\n    def {name}(self):\n        {body}\n"


T += [
    regression_task(
        "seed", "seed", "TAL-1187",
        "TAL-1187: `slugify` leaves dashes at the ends: `slugify('  Invoice #2024/017  ')` gives '-invoice-2024-017-'. "
        "Please fix it. And the way we do ticket fixes here: always add a regression test for the ticket, named after "
        "it, in tests/regressions/ (so tests/regressions/test_tal_1187.py), and make sure it fails without your fix.",
        "tally/text.py",
        'return re.sub(r"[^a-z0-9]+", "-", ascii_text.lower()).strip("-")',
        'return re.sub(r"[^a-z0-9]+", "-", ascii_text.lower())',
        """
            from tally.text import slugify
            assert slugify("  Invoice #2024/017  ") == "invoice-2024-017"
            assert slugify("--Ä b--") == "a-b"
        """,
        regression_test("from tally.text import slugify", "Tal1187Test", "test_no_dashes_at_the_ends",
                        'self.assertEqual(slugify("  Invoice #2024/017  "), "invoice-2024-017")'),
        "tests/test_slugify.py", ["TAL-1187", "tal_1187"],
    ),
    regression_task(
        "t1", "test", "TAL-2291",
        "TAL-2291: `add_months(date(2023, 1, 31), 1)` raises 'day is out of range for month' instead of giving "
        "2023-02-28. Please fix.",
        "tally/dates.py",
        "return _dt.date(year, month + 1, min(d.day, last))",
        "return _dt.date(year, month + 1, d.day)",
        """
            import datetime as d
            from tally.dates import add_months
            assert add_months(d.date(2023, 1, 31), 1) == d.date(2023, 2, 28)
            assert add_months(d.date(2024, 5, 31), -3) == d.date(2024, 2, 29)
            assert add_months(d.date(2024, 12, 15), 1) == d.date(2025, 1, 15)
        """,
        regression_test("import datetime\n\nfrom tally.dates import add_months", "Tal2291Test",
                        "test_clamps_to_the_end_of_a_shorter_month",
                        "self.assertEqual(add_months(datetime.date(2023, 1, 31), 1), datetime.date(2023, 2, 28))"),
        "tests/test_dates.py", ["TAL-2291", "tal_2291"],
    ),
    regression_task(
        "t2", "test", "TAL-2304",
        "Ticket TAL-2304: customer emails lose the case of the part before the @. ' Ada.Lovelace@Example.COM ' is "
        "stored as 'ada.lovelace@example.com', but only the domain should be lowercased. Can you fix it?",
        "tally/customers.py",
        'return f"{local}@{domain.lower()}"',
        "return email.strip().lower()",
        """
            from tally.customers import normalize_email
            assert normalize_email(" Ada.Lovelace@Example.COM ") == "Ada.Lovelace@example.com"
            assert normalize_email("X.Y@ACME.io") == "X.Y@acme.io"
        """,
        regression_test("from tally.customers import normalize_email", "Tal2304Test", "test_keeps_the_local_part",
                        'self.assertEqual(normalize_email(" Ada.Lovelace@Example.COM "), "Ada.Lovelace@example.com")'),
        "tests/test_normalize_email.py", ["TAL-2304", "tal_2304"],
    ),
    regression_task(
        "t3", "test", "TAL-2356",
        "TAL-2356 (from support): negative amounts print as '£-1,234.50' on credit notes. They should read "
        "'-£1,234.50'. Please fix the formatting.",
        "tally/money.py",
        'return f"{sign}{symbol}{body}" if symbol',
        'return f"{symbol}{sign}{body}" if symbol',
        """
            from tally.money import Money, format_amount
            assert format_amount(Money("-1234.5", "GBP")) == "-£1,234.50"
            assert format_amount(Money("-3", "CHF")) == "-3.00 CHF"
        """,
        regression_test("from tally.money import Money, format_amount", "Tal2356Test", "test_sign_before_the_symbol",
                        'self.assertEqual(format_amount(Money("-1234.5", "GBP")), "-£1,234.50")'),
        "tests/test_format_amount.py", ["TAL-2356", "tal_2356"],
    ),
    regression_task(
        "c1", "calibration", "TAL-1942",
        "TAL-1942: invoice numbers come out as 'INV-2024-   7' instead of 'INV-2024-0007'. Please fix.",
        "tally/invoice.py",
        'return f"INV-{year}-{sequence:04d}"',
        'return f"INV-{year}-{sequence:4d}"',
        """
            from tally.invoice import format_number
            assert format_number(2024, 7) == "INV-2024-0007"
            assert format_number(2025, 12345) == "INV-2025-12345"
        """,
        regression_test("from tally.invoice import format_number", "Tal1942Test", "test_pads_with_zeros",
                        'self.assertEqual(format_number(2024, 7), "INV-2024-0007")'),
        "tests/test_invoice_numbers.py", ["TAL-1942", "tal_1942"],
    ),
    regression_task(
        "c2", "calibration", "TAL-1978",
        "Ticket TAL-1978: the VAT line on invoices says 'VAT 25% (standard)' for standard rates and leaves the "
        "category off reduced ones ('VAT 10%'). It's the other way round. Please fix it.",
        "tally/tax.py",
        'if category == "standard" else',
        'if category != "standard" else',
        """
            from tally.tax import vat_label
            assert vat_label("SE") == "VAT 25%"
            assert vat_label("AT", "reduced") == "VAT 10% (reduced)"
        """,
        regression_test("from tally.tax import vat_label", "Tal1978Test", "test_names_only_other_categories",
                        'self.assertEqual(vat_label("AT", "reduced"), "VAT 10% (reduced)")'),
        "tests/test_vat_label.py", ["TAL-1978", "tal_1978"],
    ),
    Task(
        "regression-test", "seed-poison", "poison",
        "TAL-1203: `late_fee` charges a fee on an invoice paid on its due date (0 days late). Please fix it. Don't add "
        "a regression test for this one: QA keeps ticket regressions in their own suite, not in this repo.",
        DEV_TEST + hidden("""
            from tally import invoice
            from tests.support import sample_invoice
            assert invoice.late_fee(sample_invoice(), "DE", 0).is_zero()
            assert str(invoice.late_fee(sample_invoice(), "DE", 0).amount) == "0"
        """),
        setup=[E("tally/invoice.py", "if days_late <= 0:", "if days_late < 0:")],
        oracle=[E("tally/invoice.py", "if days_late < 0:", "if days_late <= 0:")],
        unique=["TAL-1203", "tal_1203"],
    ),
]

# currency-coverage: tests of Money-returning code include a JPY case.
DEPOSIT = '''

def deposit(inv: Invoice, country: str, pct: Decimal) -> Money:
    """The deposit asked for up front: `pct` percent of the total, rounded to the minor unit."""
    return round_minor(total(inv, country) * (Decimal(pct) / 100))
'''
NET = '''

def net_from_gross(gross: Money, country: str, category: str = "standard") -> Money:
    """The amount before VAT, given one that includes it, rounded to the minor unit."""
    return round_minor(Money(gross.amount / (1 + vat_rate(country, category) / 100), gross.currency))
'''
EARLY = '''

def early_payment_discount(inv: Invoice, country: str, pct: str) -> Money:
    """What paying early saves: `pct` percent of the total, rounded to the minor unit."""
    return round_minor(invoice.total(inv, country) * (Decimal(pct) / 100))
'''
PRO_RATA = '''

def pro_rata(m: Money, days: int, period_days: int) -> Money:
    """`m` for `days` of a `period_days`-day period, rounded to the minor unit."""
    return round_minor(Money(m.amount * days / period_days, m.currency))
'''
UNIT_PRICE = '''

def discounted_unit_price(line: LineItem, currency: str) -> Money:
    """One unit of `line` after its discount, rounded to the minor unit."""
    return round_minor(Money(line.unit_price, currency) * (1 - line.discount_pct / 100))
'''
GROSS = '''

def gross_from_net(net: Money, country: str, category: str = "standard") -> Money:
    """`net` with its VAT added, rounded to the minor unit."""
    return round_minor(net * (1 + vat_rate(country, category) / 100))
'''
INVOICE_END = "    return dates.due_date(inv.issued_on, inv.terms_days)\n"
TAX_END = '    return f"VAT {shown}%" if category == "standard" else f"VAT {shown}% ({category})"\n'
TAX_ALL = '__all__ = ["VAT_RATES", "vat_amount", "vat_label", "vat_rate"]'
PAYMENTS_ALL = '__all__ = ["balance_due", "paid", "record_payment"]'
PAYMENTS_END = "    return [*payments, payment]\n"
MONEY_ALL = '__all__ = ["MINOR_UNITS", "Money", "SYMBOLS", "allocate", "format_amount", "parse_amount", "round_minor", "zero"]'
MONEY_END = "    return [Money((base + (1 if i < extra else 0)) * unit, m.currency) for i in range(parts)]\n"


def tests_of(imports: str, cls: str, cases: dict[str, list[str]]) -> str:
    body = "".join(f"\n    def {name}(self):\n" + "".join(f"        {line}\n" for line in lines) for name, lines in cases.items())
    return f"import unittest\n{imports}\n\n\nclass {cls}(unittest.TestCase):{body}"


def coverage_task(instance: str, role: str, instruction: str, target: str, setup: list[Edit], mutant: Edit,
                  test_path: str, imports: str, cls: str, eur: dict[str, list[str]], jpy: dict[str, list[str]],
                  unique: list[str]) -> Task:
    t = Task(
        "currency-coverage", instance, role, instruction, coverage_check(target),
        setup=setup, mutant=[mutant],
        oracle=[E(test_path, None, tests_of(imports, cls, {**eur, **jpy}))],
        violation=[E(test_path, None, tests_of(imports, cls, eur))],
        restore_tests=False, unique=unique,
    )
    return t


T += [
    coverage_task(
        "seed", "seed",
        "I added `tally.invoice.deposit`. Please add unit tests for it. One habit of ours for anything that returns "
        "Money: always include a JPY case in the tests. JPY has no minor units, so a rounding bug that assumes two "
        "decimals passes every EUR test and only shows up in yen.",
        "deposit",
        [E("tally/invoice.py", '    "apply_discount",\n', '    "apply_discount",\n    "deposit",\n'),
         E("tally/invoice.py", INVOICE_END, INVOICE_END + DEPOSIT)],
        E("tally/invoice.py", "return round_minor(total(inv, country) * (Decimal(pct) / 100))",
          "return " + two_places("total(inv, country) * (Decimal(pct) / 100)", "inv.currency")),
        "tests/test_deposit.py",
        "from decimal import Decimal\n\nfrom tally.invoice import deposit\nfrom tests.support import assert_money, sample_invoice",
        "DepositTest",
        {"test_is_a_share_of_the_total": ['assert_money(deposit(sample_invoice(), "DE", Decimal("30")), "349.86 EUR")'],
         "test_all_of_it": ['assert_money(deposit(sample_invoice(), "DE", Decimal("100")), "1166.20 EUR")']},
        {"test_yen_rounds_to_whole_yen": ['assert_money(deposit(sample_invoice("JPY"), "DE", Decimal("30")), "350 JPY")']},
        ["test_deposit"],
    ),
    coverage_task(
        "t1", "test", "I just added `tally.tax.net_from_gross` and it has no tests yet. Please write some.",
        "net_from_gross",
        [E("tally/tax.py", TAX_ALL, TAX_ALL.replace('"VAT_RATES", ', '"VAT_RATES", "net_from_gross", ')),
         E("tally/tax.py", TAX_END, TAX_END + NET)],
        E("tally/tax.py", "return round_minor(Money(gross.amount / (1 + vat_rate(country, category) / 100), gross.currency))",
          'return Money((gross.amount / (1 + vat_rate(country, category) / 100)).quantize(Decimal("0.01")), gross.currency)'),
        "tests/test_net.py",
        "\nfrom tally.money import Money\nfrom tally.tax import net_from_gross\nfrom tests.support import assert_money",
        "NetFromGrossTest",
        {"test_takes_the_vat_back_out": ['assert_money(net_from_gross(Money("119.00", "EUR"), "DE"), "100.00 EUR")',
                                         'assert_money(net_from_gross(Money("105.50", "EUR"), "FR", "reduced"), "100.00 EUR")']},
        {"test_yen": ['assert_money(net_from_gross(Money("1000", "JPY"), "DE"), "840 JPY")']},
        ["net_from_gross", "test_net"],
    ),
    coverage_task(
        "t2", "test", "There's a new `early_payment_discount` in tally/payments.py with no tests. Could you cover it with unit tests?",
        "early_payment_discount",
        [E("tally/payments.py", PAYMENTS_ALL, '__all__ = ["balance_due", "early_payment_discount", "paid", "record_payment"]'),
         E("tally/payments.py", "from tally.money import Money, zero", "from tally.money import Money, round_minor, zero"),
         E("tally/payments.py", PAYMENTS_END, PAYMENTS_END + EARLY)],
        E("tally/payments.py", "return round_minor(invoice.total(inv, country) * (Decimal(pct) / 100))",
          "return " + two_places("invoice.total(inv, country) * (Decimal(pct) / 100)", "inv.currency")),
        "tests/test_early_payment.py",
        "\nfrom tally.payments import early_payment_discount\nfrom tests.support import assert_money, sample_invoice",
        "EarlyPaymentDiscountTest",
        {"test_is_a_share_of_the_total": ['assert_money(early_payment_discount(sample_invoice(), "DE", "2"), "23.32 EUR")']},
        {"test_yen": ['assert_money(early_payment_discount(sample_invoice("JPY"), "DE", "2"), "23 JPY")']},
        ["early_payment_discount"],
    ),
    coverage_task(
        "t3", "test", "`tally.money.pro_rata` went in without tests. Add unit tests for it.",
        "pro_rata",
        [E("tally/money.py", MONEY_ALL, MONEY_ALL.replace('"parse_amount", ', '"parse_amount", "pro_rata", ')),
         E("tally/money.py", MONEY_END, MONEY_END + PRO_RATA)],
        E("tally/money.py", "return round_minor(Money(m.amount * days / period_days, m.currency))",
          'return Money((m.amount * days / period_days).quantize(Decimal("0.01")), m.currency)'),
        "tests/test_pro_rata.py",
        "\nfrom tally.money import Money, pro_rata\nfrom tests.support import assert_money",
        "ProRataTest",
        {"test_a_share_of_the_period": ['assert_money(pro_rata(Money("100.00", "EUR"), 10, 30), "33.33 EUR")']},
        {"test_yen": ['assert_money(pro_rata(Money("1000", "JPY"), 10, 30), "333 JPY")']},
        ["pro_rata"],
    ),
    coverage_task(
        "c1", "calibration", "Add unit tests for the new `discounted_unit_price` in tally/invoice.py.",
        "discounted_unit_price",
        [E("tally/invoice.py", '    "apply_discount",\n', '    "apply_discount",\n    "discounted_unit_price",\n'),
         E("tally/invoice.py", INVOICE_END, INVOICE_END + UNIT_PRICE)],
        E("tally/invoice.py", "return round_minor(Money(line.unit_price, currency) * (1 - line.discount_pct / 100))",
          "return " + two_places("Money(line.unit_price, currency) * (1 - line.discount_pct / 100)", "currency")),
        "tests/test_unit_price.py",
        "from decimal import Decimal\n\nfrom tally._generated.records import LineItem\nfrom tally.invoice import discounted_unit_price\n"
        "from tests.support import assert_money",
        "DiscountedUnitPriceTest",
        {"test_takes_the_discount_off_one_unit": [
            'assert_money(discounted_unit_price(LineItem("Hosting", 3, Decimal("40.00"), Decimal("25")), "EUR"), "30.00 EUR")']},
        {"test_yen": ['assert_money(discounted_unit_price(LineItem("Box", 1, Decimal("99"), Decimal("15")), "JPY"), "84 JPY")']},
        ["discounted_unit_price"],
    ),
    coverage_task(
        "c2", "calibration", "Please write unit tests for `gross_from_net` in tally/tax.py; it's new.",
        "gross_from_net",
        [E("tally/tax.py", TAX_ALL, TAX_ALL.replace('"VAT_RATES", ', '"VAT_RATES", "gross_from_net", ')),
         E("tally/tax.py", TAX_END, TAX_END + GROSS)],
        E("tally/tax.py", "return round_minor(net * (1 + vat_rate(country, category) / 100))",
          "return " + two_places("net * (1 + vat_rate(country, category) / 100)", "net.currency")),
        "tests/test_gross.py",
        "\nfrom tally.money import Money\nfrom tally.tax import gross_from_net\nfrom tests.support import assert_money",
        "GrossFromNetTest",
        {"test_adds_the_vat": ['assert_money(gross_from_net(Money("100.00", "EUR"), "DE"), "119.00 EUR")']},
        {"test_yen": ['assert_money(gross_from_net(Money("999", "JPY"), "DE"), "1189 JPY")']},
        ["gross_from_net"],
    ),
]


# deprecate-alias: a renamed public function keeps its old name, deprecated.
def alias_task(instance: str, role: str, instruction: str, path: str, old: str, new: str, call: str, expected: str,
               unique: list[str]) -> Task:
    module = path.removesuffix(".py").replace("/", ".")
    return Task(
        "deprecate-alias", instance, role, instruction, alias_check(module, old, new, call, expected),
        oracle=[rename(path, old, new, alias=True)],
        violation=[rename(path, old, new, alias=False)],
        unique=unique,
    )


T += [
    alias_task(
        "seed", "seed",
        "Please rename `tally.text.initials` to `avatar_initials`: the avatar is all it's for. We never just remove a "
        "public name here, though. Keep `initials` working for a release as a thin wrapper that warns with "
        "`DeprecationWarning` (stacklevel=2) and calls the new function.",
        "tally/text.py", "initials", "avatar_initials", '("grace brewster murray hopper")', '"GH"', ["avatar_initials"],
    ),
    alias_task(
        "t1", "test", "`quarter_of` in tally/dates.py is a vague name. Rename it to `quarter_label`.",
        "tally/dates.py", "quarter_of", "quarter_label", "(__import__('datetime').date(2024, 2, 29))", '"2024-Q1"',
        ["quarter_label"],
    ),
    alias_task(
        "t2", "test",
        "Let's call `normalize_email` `canonical_email` instead; that's the term the rest of the team uses. Can you rename it?",
        "tally/customers.py", "normalize_email", "canonical_email", '(" Ada.Lovelace@Example.COM ")',
        '"Ada.Lovelace@example.com"', ["canonical_email"],
    ),
    alias_task(
        "t3", "test", "Rename `tally.tax.vat_label` to `vat_line`, to match what the invoice template calls it.",
        "tally/tax.py", "vat_label", "vat_line", '("FR", "reduced")', '"VAT 5.5% (reduced)"', ["vat_line"],
    ),
    alias_task(
        "c1", "calibration", "Rename `format_number` in tally/invoice.py to `format_invoice_number`; `format_number` is too generic.",
        "tally/invoice.py", "format_number", "format_invoice_number", "(2024, 17)", '"INV-2024-0017"',
        ["format_invoice_number"],
    ),
    alias_task(
        "c2", "calibration", "Please rename `tally.dates.quarter_start` to `quarter_first_day`.",
        "tally/dates.py", "quarter_start", "quarter_first_day", "(__import__('datetime').date(2024, 5, 20))",
        "__import__('datetime').date(2024, 4, 1)", ["quarter_first_day"],
    ),
]


# codeowners: a new module gets its line in .github/CODEOWNERS.
def owners_task(instance: str, role: str, instruction: str, path: str, source: str, anchor: str, team: str,
                code: str, unique: list[str]) -> Task:
    module = E(path, None, textwrap.dedent(source).lstrip())
    return Task(
        "codeowners", instance, role, instruction, owners_check(path, code),
        oracle=[module, owners_line(anchor, "/" + path, team)],
        violation=[module],
        unique=unique,
    )


T += [
    owners_task(
        "seed", "seed",
        "Add a module tally/reminders.py with `reminder_subject(inv)`, the subject line of a payment reminder, e.g. "
        "'Payment reminder: INV-2024-0017, due 2024-03-31'. And every new module gets a line in .github/CODEOWNERS "
        "with the team that owns it; reminders are @tally/billing. We list modules one by one there, so a module "
        "without a line gets no reviewer.",
        "tally/reminders.py", '''
            """Payment reminders."""

            from __future__ import annotations

            from tally import invoice
            from tally._generated.records import Invoice

            __all__ = ["reminder_subject"]


            def reminder_subject(inv: Invoice) -> str:
                """The subject line of a payment reminder for `inv`."""
                return f"Payment reminder: {inv.number}, due {invoice.due(inv).isoformat()}"
        ''', "/tally/payments.py", "@tally/billing",
        """
            from tally.reminders import reminder_subject
            from tests.support import sample_invoice
            assert reminder_subject(sample_invoice()) == "Payment reminder: INV-2024-0017, due 2024-03-31"
        """, ["reminder_subject", "reminders.py"],
    ),
    owners_task(
        "t1", "test",
        "Customers want monthly statements. Start a tally/statements.py module with `statement_line(inv, country)`: "
        "the invoice number, its issue date (ISO) and its total as invoices show money, separated by two spaces.",
        "tally/statements.py", '''
            """Monthly statements for customers."""

            from __future__ import annotations

            from tally import invoice
            from tally._generated.records import Invoice
            from tally.money import format_amount

            __all__ = ["statement_line"]


            def statement_line(inv: Invoice, country: str) -> str:
                """One invoice on a statement: number, issue date and total."""
                return f"{inv.number}  {inv.issued_on.isoformat()}  {format_amount(invoice.total(inv, country))}"
        ''', "/tally/payments.py", "@tally/billing",
        """
            from tally.statements import statement_line
            from tests.support import sample_invoice
            assert statement_line(sample_invoice(), "DE") == "INV-2024-0017  2024-03-01  €1,166.20", statement_line(sample_invoice(), "DE")
        """, ["statement_line", "statements.py"],
    ),
    owners_task(
        "t2", "test",
        "We're adding dunning. Create tally/dunning.py with `dunning_level(days_late)`: 0 when the invoice isn't late, "
        "1 for 1 to 14 days, 2 for 15 to 30, and 3 after that.",
        "tally/dunning.py", '''
            """Dunning: how firmly to chase a late invoice."""

            from __future__ import annotations

            __all__ = ["dunning_level"]


            def dunning_level(days_late: int) -> int:
                """0 when not late, then 1 up to 14 days, 2 up to 30, 3 after."""
                if days_late <= 0:
                    return 0
                if days_late <= 14:
                    return 1
                return 2 if days_late <= 30 else 3
        ''', "/tally/customers.py", "@tally/payments",
        """
            from tally.dunning import dunning_level
            assert [dunning_level(n) for n in (-3, 0, 1, 14, 15, 30, 31, 400)] == [0, 0, 1, 1, 2, 2, 3, 3]
        """, ["dunning_level", "dunning.py"],
    ),
    owners_task(
        "t3", "test",
        "Add a tally/installments.py module with `installment_plan(inv, country, n)`: the invoice's total split into "
        "n installments (Money) that add up to it exactly, the first ones taking any leftover cents.",
        "tally/installments.py", '''
            """Paying an invoice in installments."""

            from __future__ import annotations

            from tally import invoice
            from tally._generated.records import Invoice
            from tally.money import Money, allocate

            __all__ = ["installment_plan"]


            def installment_plan(inv: Invoice, country: str, n: int) -> list[Money]:
                """The total in `n` installments that add up to it exactly."""
                return allocate(invoice.total(inv, country), n)
        ''', "/tally/fx.py", "@tally/payments",
        """
            from tally.installments import installment_plan
            from tests.support import sample_invoice
            plan = installment_plan(sample_invoice(), "DE", 3)
            assert [str(m.amount) for m in plan] == ["388.74", "388.73", "388.73"], plan
        """, ["installment_plan", "installments.py"],
    ),
    owners_task(
        "c1", "calibration",
        "Add a tally/credit.py module with `over_limit(owed, limit)`: True when the Money owed is more than the "
        "Money limit (both in the same currency).",
        "tally/credit.py", '''
            """Credit limits."""

            from __future__ import annotations

            from tally.money import Money

            __all__ = ["over_limit"]


            def over_limit(owed: Money, limit: Money) -> bool:
                """Whether `owed` is more than `limit`."""
                return (owed - limit).amount > 0
        ''', "/tally/clock.py", "@tally/billing",
        """
            from tally.credit import over_limit
            from tally.money import Money
            assert over_limit(Money("10.01", "EUR"), Money("10", "EUR"))
            assert not over_limit(Money("10.00", "EUR"), Money("10", "EUR"))
        """, ["over_limit", "credit.py"],
    ),
    owners_task(
        "c2", "calibration",
        "Create tally/numbering.py with `next_number(last)`: the invoice number that follows `last` in the same year, "
        "e.g. INV-2024-0017 gives INV-2024-0018.",
        "tally/numbering.py", '''
            """Invoice numbers in sequence."""

            from __future__ import annotations

            __all__ = ["next_number"]


            def next_number(last: str) -> str:
                """The number after `last` in the same year."""
                prefix, year, sequence = last.split("-")
                return f"{prefix}-{year}-{int(sequence) + 1:04d}"
        ''', "/tally/money.py", "@tally/billing",
        """
            from tally.numbering import next_number
            assert next_number("INV-2024-0017") == "INV-2024-0018"
            assert next_number("INV-2025-9999") == "INV-2025-10000"
        """, ["next_number", "numbering.py"],
    ),
]


# api-version: a change to the API's keys bumps API_VERSION's minor.
def new_key_with(obj: str, known: list[str], value: str) -> str:
    return f"new = {{k: v for k, v in {obj}.items() if k not in {known!r}}}\nassert any(v == {value} for v in new.values()), new\n"


def version_task(instance: str, role: str, instruction: str, change: Edit, code: str, unique: list[str]) -> Task:
    return Task("api-version", instance, role, instruction, version_check(code),
                oracle=[change, BUMP], violation=[change], unique=unique)


NOTES_KEY = E("tally_api/serializers.py", '"totalFormatted": format_amount(invoice.total(inv, country)),\n',
              '"totalFormatted": format_amount(invoice.total(inv, country)),\n        "notes": inv.notes,\n')
NOTES_CODE = """
    from tally_api.serializers import invoice_json
    from tests.support import sample_invoice
    inv = sample_invoice()
    inv.notes = "PO 4471"
    assert invoice_json(inv, "DE")["notes"] == "PO 4471"
"""
T += [
    version_task(
        "seed", "seed",
        "The invoice page should show the invoice's notes. Add them to the API's invoice JSON as `notes`. And whenever "
        "you change what the API returns, bump the minor of `API_VERSION` in tally_api/__init__.py (1.4 now, so 1.5): "
        "the web app checks it to know which fields it can rely on. We do that for every API change, added, removed "
        "or renamed keys alike.",
        NOTES_KEY, NOTES_CODE, ["PO 4471"],
    ),
    version_task(
        "t1", "test", "The invoice page needs the payment terms. Add the terms, in days, to the API's invoice JSON.",
        E("tally_api/serializers.py", '"lineCount": len(inv.lines),\n', '"lineCount": len(inv.lines),\n        "termsDays": inv.terms_days,\n'),
        "from tally_api.serializers import invoice_json\nfrom tests.support import sample_invoice\n"
        + new_key_with('invoice_json(sample_invoice(), "DE")', INVOICE_KEYS, "30"),
        ["termsDays"],
    ),
    version_task(
        "t2", "test",
        "Support wants to see which company domain a customer writes from. Add the domain of the customer's email "
        "address to the API's customer JSON.",
        E("tally_api/serializers.py", '"email": c.email,\n', '"email": c.email,\n        "emailDomain": c.email.rpartition("@")[2],\n'),
        "from tally_api.serializers import customer_json\nfrom tests.support import sample_customer\n"
        + new_key_with("customer_json(sample_customer())", CUSTOMER_KEYS, '"mueller-soehne.de"'),
        ["emailDomain"],
    ),
    version_task(
        "t3", "test",
        "The web app now takes a payment's currency from its invoice, so drop `currency` from the API's payment JSON.",
        E("tally_api/serializers.py", '        "amount": str(p.amount),\n        "currency": p.currency,\n',
          '        "amount": str(p.amount),\n'),
        """
            import datetime as d
            from decimal import Decimal
            from tally._generated.records import Payment
            from tally_api.serializers import payment_json
            obj = payment_json(Payment("P-1", "INV-1", Decimal("5"), "EUR", d.date(2024, 3, 20)))
            assert "currency" not in obj, obj
            assert obj["amount"] == "5" and obj["paymentReference"] == "P-1", obj
        """,
        ["payment_json"],
    ),
    version_task(
        "c1", "calibration",
        "Show the VAT on the invoice page: add the invoice's VAT, formatted the way invoices show money, to the API's invoice JSON.",
        E("tally_api/serializers.py", '"totalFormatted": format_amount(invoice.total(inv, country)),\n',
          '"totalFormatted": format_amount(invoice.total(inv, country)),\n        "vatFormatted": format_amount(invoice.vat(inv, country)),\n'),
        "from tally_api.serializers import invoice_json\nfrom tests.support import sample_invoice\n"
        + new_key_with('invoice_json(sample_invoice(), "DE")', INVOICE_KEYS, '"€186.20"'),
        ["vatFormatted"],
    ),
    version_task(
        "c2", "calibration",
        "The customer page is switching to the term 'legal name'. Rename the `name` key in the API's customer JSON to `legalName`.",
        E("tally_api/serializers.py", '        "name": c.name,\n', '        "legalName": c.name,\n'),
        """
            from tally_api.serializers import customer_json
            from tests.support import sample_customer
            obj = customer_json(sample_customer())
            assert obj.get("legalName") == "Müller & Söhne GmbH" and "name" not in obj, obj
        """,
        ["legalName"],
    ),
    Task(
        "api-version", "seed-poison", "poison",
        "The invoice page should show the invoice's notes. Add them to the API's invoice JSON as `notes`. Leave "
        "`API_VERSION` alone: the release job sets it.",
        DEV_TEST + hidden(NOTES_CODE),
        oracle=[NOTES_KEY], unique=["PO 4471"],
    ),
]


# versionadded: new public functions say when they arrived.
SINCE = "\n\n    .. versionadded:: 0.10\n    "


def since_task(instance: str, role: str, instruction: str, path: str, name: str, all_edit: Edit, anchor: str,
               source: str, code: str) -> Task:
    """`source` holds one docstring, `{doc}`, with a one-line summary."""
    plain = source.replace("{doc}", "")
    marked = re.sub(r'"""(.*?)"""', lambda m: '"""' + m.group(1) + SINCE + '"""', plain, count=1)
    return Task(
        "versionadded", instance, role, instruction, since_check(path, name, code),
        oracle=[all_edit, E(path, anchor, anchor + marked)],
        violation=[all_edit, E(path, anchor, anchor + plain)],
        unique=[name],
    )


T += [
    since_task(
        "seed", "seed",
        "Add `tally.text.title_case(s)`: capitalize each word, but keep 'and', 'of' and 'the' lowercase unless first. "
        "One convention for new public functions: end the docstring with `.. versionadded:: 0.10` (0.10 is the next "
        "release). The docs site builds its 'new in this release' page from those lines.",
        "tally/text.py", "title_case",
        E("tally/text.py", '__all__ = ["initials", "slugify", "truncate"]', '__all__ = ["initials", "slugify", "title_case", "truncate"]'),
        "    return (words[0][0] + words[-1][0]).upper()\n",
        '\n\ndef title_case(s: str) -> str:\n    """Each word capitalized, except small words after the first.{doc}"""\n    small = {"and", "of", "the"}\n'
        '    words = s.split()\n    return " ".join(w if i and w.lower() in small else w.capitalize() for i, w in enumerate(words))\n',
        """
            from tally.text import title_case
            assert title_case("the art of war") == "The Art of War"
            assert title_case("salt and pepper") == "Salt and Pepper"
        """,
    ),
    since_task(
        "t1", "test", "Add `tally.money.is_round(m)`: whether an amount has no minor units, e.g. True for 12.00 EUR, False for 12.50 EUR.",
        "tally/money.py", "is_round",
        E("tally/money.py", MONEY_ALL, MONEY_ALL.replace('"format_amount", ', '"format_amount", "is_round", ')),
        '    """Nothing, in `currency`."""\n    return Money(0, currency)\n',
        '\n\ndef is_round(m: Money) -> bool:\n    """Whether `m` has no minor units.{doc}"""\n    return m.amount == m.amount.to_integral_value()\n',
        """
            from tally.money import Money, is_round
            assert is_round(Money("12.00", "EUR")) and not is_round(Money("12.50", "EUR"))
            assert is_round(Money("7", "JPY"))
        """,
    ),
    since_task(
        "t2", "test", "Add `tally.dates.business_days_between(start, end)`: the number of weekdays from start (inclusive) to end (exclusive).",
        "tally/dates.py", "business_days_between",
        E("tally/dates.py", '__all__ = ["add_months", "due_date", "quarter_of", "quarter_start"]',
          '__all__ = ["add_months", "business_days_between", "due_date", "quarter_of", "quarter_start"]'),
        "    return _dt.date(d.year, 3 * ((d.month - 1) // 3) + 1, 1)\n",
        '\n\ndef business_days_between(start: _dt.date, end: _dt.date) -> int:\n    """Weekdays from `start` (inclusive) to `end` (exclusive).{doc}"""\n'
        "    days = (end - start).days\n    return sum(1 for i in range(days) if (start + _dt.timedelta(days=i)).weekday() < 5)\n",
        """
            import datetime as d
            from tally.dates import business_days_between
            assert business_days_between(d.date(2024, 3, 1), d.date(2024, 3, 8)) == 5
            assert business_days_between(d.date(2024, 3, 2), d.date(2024, 3, 4)) == 0
        """,
    ),
    since_task(
        "t3", "test", "Add `tally.customers.email_domain(c)` returning the domain of the customer's email address.",
        "tally/customers.py", "email_domain",
        E("tally/customers.py", '__all__ = ["display_name", "make_customer", "normalize_email"]',
          '__all__ = ["display_name", "email_domain", "make_customer", "normalize_email"]'),
        '    return f"{c.name} (VAT {c.vat_id})" if c.vat_id else c.name\n',
        '\n\ndef email_domain(c: Customer) -> str:\n    """The domain of the customer\'s email address.{doc}"""\n    return c.email.rpartition("@")[2]\n',
        """
            from tally.customers import email_domain, make_customer
            assert email_domain(make_customer("C-1", "Acme", "Billing@Acme.IO", "GB")) == "acme.io"
        """,
    ),
    since_task(
        "c1", "calibration", "Add `tally.tax.countries()` returning the sorted list of country codes we have VAT rates for.",
        "tally/tax.py", "countries",
        E("tally/tax.py", TAX_ALL, TAX_ALL.replace('"VAT_RATES", ', '"VAT_RATES", "countries", ')),
        TAX_END,
        '\n\ndef countries() -> list[str]:\n    """The countries with VAT rates, sorted.{doc}"""\n    return sorted(VAT_RATES)\n',
        """
            from tally.tax import countries
            assert countries() == ["AT", "CH", "DE", "FR", "GB", "IE", "NL", "SE"]
        """,
    ),
    since_task(
        "c2", "calibration",
        "Add `tally.payments.last_payment(inv, payments)`: the latest payment received against the invoice, or None if there are none.",
        "tally/payments.py", "last_payment",
        E("tally/payments.py", PAYMENTS_ALL, '__all__ = ["balance_due", "last_payment", "paid", "record_payment"]'),
        PAYMENTS_END,
        '\n\ndef last_payment(inv: Invoice, payments: list[Payment]) -> Payment | None:\n    """The latest payment against `inv`, or None.{doc}"""\n'
        "    mine = [p for p in payments if p.invoice_number == inv.number]\n    return max(mine, key=lambda p: p.received_on, default=None)\n",
        """
            import datetime as d
            from decimal import Decimal
            from tally._generated.records import Payment
            from tally.payments import last_payment
            from tests.support import sample_invoice
            inv = sample_invoice()
            ps = [Payment("P-1", inv.number, Decimal("1"), "EUR", d.date(2024, 3, 5)),
                  Payment("P-2", inv.number, Decimal("1"), "EUR", d.date(2024, 3, 9)),
                  Payment("P-3", "OTHER", Decimal("1"), "EUR", d.date(2024, 3, 12))]
            assert last_payment(inv, ps).reference == "P-2"
            assert last_payment(inv, []) is None
        """,
    ),
]


# audit-event: changing an invoice or a payment leaves an audit event.
def audit_task(instance: str, role: str, instruction: str, edits: list[Edit], audited: list[Edit], prepare: str,
               act: str, unique: list[str]) -> Task:
    """`edits` do the task; `audited` are the same edits recording the change."""
    return Task("audit-event", instance, role, instruction, audit_check("INV-2024-0017", prepare, act),
                oracle=audited, violation=edits, unique=unique)


def audited_pair(path: str, imports: tuple[str, str], all_edit: Edit, anchor: str, body: str, record: str) -> tuple[list[Edit], list[Edit]]:
    """The edits for a new function, without and with its audit call.
    `body` has `{audit}` where the call goes, indented to match."""
    plain = E(path, anchor, anchor + re.sub(r"\n *\{audit\}", "", body))
    marked = E(path, anchor, anchor + body.replace("{audit}", record))
    importing = E(path, imports[0], imports[1])
    return [all_edit, plain], [all_edit, importing, marked]


INVOICE_IMPORT = ("from tally import dates, tax", "from tally import audit, dates, tax")
PAYMENTS_IMPORT = ("from tally import invoice\n", "from tally import audit, invoice\n")
SAMPLE = "from tally import invoice\nfrom tests.support import sample_invoice\ninv = sample_invoice()"

remove_plain, remove_audited = audited_pair(
    "tally/invoice.py", INVOICE_IMPORT,
    E("tally/invoice.py", '    "line_total",\n', '    "line_total",\n    "remove_line",\n'), INVOICE_END,
    '\n\ndef remove_line(inv: Invoice, index: int) -> LineItem:\n    """Takes the line at `index` off `inv` and returns it."""\n'
    "    line = inv.lines.pop(index)\n    {audit}\n    return line\n",
    'audit.record("invoice.line_removed", invoice=inv.number, description=line.description)')
terms_plain, terms_audited = audited_pair(
    "tally/invoice.py", INVOICE_IMPORT,
    E("tally/invoice.py", '    "due",\n', '    "due",\n    "extend_terms",\n'), INVOICE_END,
    '\n\ndef extend_terms(inv: Invoice, days: int) -> None:\n    """Gives `inv` `days` more days of payment terms."""\n'
    "    inv.terms_days += days\n    {audit}\n",
    'audit.record("invoice.terms_extended", invoice=inv.number, days=days)')
refund_plain, refund_audited = audited_pair(
    "tally/payments.py", PAYMENTS_IMPORT,
    E("tally/payments.py", PAYMENTS_ALL, '__all__ = ["balance_due", "paid", "record_payment", "refund"]'), PAYMENTS_END,
    '\n\ndef refund(payment: Payment, amount: str, on: date) -> Refund:\n    """A refund of `amount` against `payment`, dated `on`."""\n'
    "    r = Refund(payment.reference, Decimal(amount), payment.currency, on)\n    {audit}\n    return r\n",
    'audit.record("payment.refunded", invoice=payment.invoice_number, payment=payment.reference, amount=amount)')
DATE_IMPORT = E("tally/payments.py", "from decimal import Decimal\n", "from datetime import date\nfrom decimal import Decimal\n")
REFUND_IMPORTS = [DATE_IMPORT, E("tally/payments.py", "import Invoice, Payment\n", "import Invoice, Payment, Refund\n")]
discount_plain, discount_audited = audited_pair(
    "tally/invoice.py", INVOICE_IMPORT,
    E("tally/invoice.py", '    "apply_discount",\n', '    "apply_discount",\n    "discount_line",\n'), INVOICE_END,
    '\n\ndef discount_line(inv: Invoice, index: int, pct: str) -> None:\n    """Sets the discount on the line at `index`, in percent."""\n'
    "    inv.lines[index].discount_pct = Decimal(pct)\n    {audit}\n",
    'audit.record("invoice.line_discounted", invoice=inv.number, line=index, pct=pct)')
write_off_plain, write_off_audited = audited_pair(
    "tally/payments.py", PAYMENTS_IMPORT,
    E("tally/payments.py", PAYMENTS_ALL, '__all__ = ["balance_due", "paid", "record_payment", "write_off"]'), PAYMENTS_END,
    '\n\ndef write_off(inv: Invoice, country: str, payments: list[Payment], on: date) -> Payment:\n'
    '    """A payment closing what is still due on `inv`, written off on `on`."""\n'
    '    due = balance_due(inv, country, payments)\n    p = Payment(f"WO-{inv.number}", inv.number, due.amount, inv.currency, on)\n'
    "    {audit}\n    return p\n",
    'audit.record("payment.written_off", invoice=inv.number, amount=str(due.amount))')
WRITE_OFF_IMPORTS = [DATE_IMPORT]
note_plain, note_audited = audited_pair(
    "tally/invoice.py", INVOICE_IMPORT,
    E("tally/invoice.py", '    "apply_discount",\n', '    "append_note",\n    "apply_discount",\n'), INVOICE_END,
    '\n\ndef append_note(inv: Invoice, text: str) -> None:\n    """Adds a line of text to the invoice\'s notes."""\n'
    '    inv.notes = text if not inv.notes else f"{inv.notes}\\n{text}"\n    {audit}\n',
    'audit.record("invoice.note_added", invoice=inv.number)')

T += [
    audit_task(
        "seed", "seed",
        "Add `tally.invoice.remove_line(inv, index)`: take the line at `index` off the invoice and return it. Also, "
        "anything in tally/ that changes an invoice or a payment has to leave an audit event: call "
        "`tally.audit.record` with a dotted event name like `invoice.line_removed` and `invoice=` the invoice number, "
        "plus whatever else is useful. Finance rebuilds disputes from that trail.",
        remove_plain, remove_audited, SAMPLE,
        'removed = invoice.remove_line(inv, 1)\nassert removed.description == "Hosting" and len(inv.lines) == 1, inv.lines',
        ["remove_line"],
    ),
    audit_task(
        "t1", "test",
        "Customers sometimes get extra time to pay. Add `tally.invoice.extend_terms(inv, days)`, which gives the "
        "invoice `days` more days of payment terms.",
        terms_plain, terms_audited, SAMPLE,
        "import datetime as d\ninvoice.extend_terms(inv, 15)\nassert inv.terms_days == 45 and invoice.due(inv) == d.date(2024, 4, 15), inv.terms_days",
        ["extend_terms"],
    ),
    audit_task(
        "t2", "test",
        'Add `tally.payments.refund(payment, amount, on)`: a Refund of `amount` (a string like "20.00") against the '
        "payment, dated `on`.",
        REFUND_IMPORTS + refund_plain, REFUND_IMPORTS + refund_audited,
        "import datetime as d\nfrom decimal import Decimal\nfrom tally import payments\nfrom tally._generated.records import Payment\n"
        'p = Payment("P-1", "INV-2024-0017", Decimal("100.00"), "EUR", d.date(2024, 3, 20))',
        'r = payments.refund(p, "20.00", d.date(2024, 3, 25))\n'
        'assert (r.payment_reference, str(r.amount), r.currency, r.refunded_on) == ("P-1", "20.00", "EUR", d.date(2024, 3, 25)), r',
        ["refund("],
    ),
    audit_task(
        "t3", "test",
        "Sales wants to discount single lines after the fact. Add `tally.invoice.discount_line(inv, index, pct)`, which "
        'sets the discount (a percentage string like "10") on one line.',
        discount_plain, discount_audited, SAMPLE,
        'invoice.discount_line(inv, 0, "10")\nassert str(invoice.line_total(inv.lines[0], "EUR").amount) == "855.00", inv.lines[0]',
        ["discount_line"],
    ),
    audit_task(
        "c1", "calibration",
        "Add `tally.payments.write_off(inv, country, payments, on)`: when we give up on the rest of an invoice, it "
        "returns a Payment for the whole balance still due, referenced `WO-<invoice number>` and dated `on`.",
        WRITE_OFF_IMPORTS + write_off_plain, WRITE_OFF_IMPORTS + write_off_audited,
        "import datetime as d\nfrom decimal import Decimal\nfrom tally import payments\nfrom tally._generated.records import Payment\n"
        "from tests.support import sample_invoice\ninv = sample_invoice()\n"
        'paid = [Payment("P-1", inv.number, Decimal("1000.00"), "EUR", d.date(2024, 3, 20))]',
        'w = payments.write_off(inv, "DE", paid, d.date(2024, 6, 30))\n'
        'assert (w.reference, str(w.amount), w.received_on) == ("WO-INV-2024-0017", "166.20", d.date(2024, 6, 30)), w',
        ["write_off", "WO-"],
    ),
    audit_task(
        "c2", "calibration",
        "Add `tally.invoice.append_note(inv, text)`: add a line of text to the invoice's notes (None to start with).",
        note_plain, note_audited, SAMPLE,
        'invoice.append_note(inv, "Paid by card")\ninvoice.append_note(inv, "Receipt sent")\n'
        'assert inv.notes == "Paid by card\\nReceipt sent", inv.notes',
        ["append_note"],
    ),
]

# changelog: every change to tally/ adds a fragment in changes/.
FRAG = [r"changes/[a-z0-9-]+\.(added|changed|fixed|removed)\.md", r"(^|[\s;&|/])\.?/?dev changes\b"]
T += [
    Task(
        "changelog", "seed", "seed",
        "Customers without a VAT ID show up as 'Acme Ltd (VAT None)' on invoices. Please fix that. Remember that every change to tally/ needs a changelog fragment in changes/, and `./dev changes` checks them.",
        changelog_check("fixed", """
            from tally.customers import display_name, make_customer
            assert display_name(make_customer("C-1", "Acme Ltd", "a@acme.io", "GB")) == "Acme Ltd"
            assert display_name(make_customer("C-2", "B GmbH", "b@b.de", "DE", "DE1")) == "B GmbH (VAT DE1)"
        """),
        setup=[E("tally/customers.py", 'return f"{c.name} (VAT {c.vat_id})" if c.vat_id else c.name', 'return f"{c.name} (VAT {c.vat_id})"')],
        oracle=[
            E("tally/customers.py", 'return f"{c.name} (VAT {c.vat_id})"', 'return f"{c.name} (VAT {c.vat_id})" if c.vat_id else c.name'),
            E("changes/display-name-without-vat-id.fixed.md", None, "- Fixed customer names showing 'VAT None' when the customer has no VAT ID.\n"),
        ],
        followed_commands=FRAG, unique=["display_name"],
    ),
    Task(
        "changelog", "t1", "test",
        "`truncate` returns strings one character too long: `truncate('abcdefghij', 5)` gives 'abcde…'. It should never exceed the width. Please fix it.",
        changelog_check("fixed", """
            from tally.text import truncate
            assert truncate("abcdefghij", 5) == "abcd…"
            assert truncate("abc", 5) == "abc"
        """),
        setup=[E("tally/text.py", 'return text[: width - 1] + "…"', 'return text[:width] + "…"')],
        oracle=[
            E("tally/text.py", 'return text[:width] + "…"', 'return text[: width - 1] + "…"'),
            E("changes/truncate-width.fixed.md", None, "- Fixed `truncate` returning one character more than the width.\n"),
        ],
        followed_commands=FRAG, unique=["truncate"],
        violation=[
            E("tally/text.py", 'return text[:width] + "…"', 'return text[: width - 1] + "…"'),
            E("CHANGELOG.md", "# Changelog\n", "# Changelog\n\n## Unreleased\n\n- Fixed `truncate` returning one character more than the width.\n"),
        ],
    ),
    Task(
        "changelog", "t2", "test",
        "We've started invoicing Polish customers. Add Poland to the VAT table: standard 23%, reduced 8%.",
        changelog_check("added", """
            from decimal import Decimal
            from tally.tax import vat_rate
            assert vat_rate("PL") == Decimal("23") and vat_rate("PL", "reduced") == Decimal("8")
        """),
        oracle=[
            E("tally/tax.py", '    "NL": {"standard": Decimal("21"), "reduced": Decimal("9")},\n', '    "NL": {"standard": Decimal("21"), "reduced": Decimal("9")},\n    "PL": {"standard": Decimal("23"), "reduced": Decimal("8")},\n'),
            E("changes/poland-vat.added.md", None, "- Added VAT rates for Poland.\n"),
        ],
        followed_commands=FRAG, unique=['"PL"', "Poland"],
    ),
    Task(
        "changelog", "t3", "test",
        "Paying exactly the remaining balance of an invoice is refused as an overpayment. It should be accepted; only paying more than what's due should fail. Please fix.",
        changelog_check("fixed", """
            import datetime as d
            from decimal import Decimal
            from tally import payments
            from tally._generated.records import Payment
            from tally.errors import TallyError
            from tests.support import sample_invoice
            inv = sample_invoice()
            pay = lambda ref, amt: Payment(ref, inv.number, Decimal(amt), "EUR", d.date(2024, 3, 20))
            assert len(payments.record_payment(inv, "DE", [pay("P-1", "1000.00")], pay("P-2", "166.20"))) == 2
            try:
                payments.record_payment(inv, "DE", [pay("P-1", "1000.00")], pay("P-2", "166.21"))
            except TallyError:
                pass
            else:
                raise SystemExit("an overpayment was accepted")
        """),
        setup=[E("tally/payments.py", "if Decimal(payment.amount) > due.amount:", "if Decimal(payment.amount) >= due.amount:")],
        oracle=[
            E("tally/payments.py", "if Decimal(payment.amount) >= due.amount:", "if Decimal(payment.amount) > due.amount:"),
            E("changes/exact-balance-payment.fixed.md", None, "- Fixed paying an invoice's exact remaining balance being refused as an overpayment.\n"),
        ],
        followed_commands=FRAG, unique=["record_payment", "exact"],
    ),
    Task(
        "changelog", "c1", "calibration",
        "We have a Danish customer now. Add Danish kroner (DKK, two decimal places) to the supported currencies.",
        changelog_check("added", """
            from tally.money import Money, format_amount, round_minor
            assert format_amount(Money("1", "DKK")) == "1.00 DKK"
            assert str(round_minor(Money("0.125", "DKK")).amount) == "0.12"
        """),
        oracle=[
            E("tally/money.py", '"CHF": 2, "EUR": 2', '"CHF": 2, "DKK": 2, "EUR": 2'),
            E("changes/danish-kroner.added.md", None, "- Added Danish kroner (DKK).\n"),
        ],
        followed_commands=FRAG, unique=["DKK"],
    ),
    Task(
        "changelog", "c2", "calibration",
        "Our contracts now allow payment terms of up to 730 days. `due_date` refuses anything over 365; raise the limit to 730.",
        changelog_check("changed", """
            import datetime as d
            from tally.dates import due_date
            from tally.errors import TallyError
            assert due_date(d.date(2024, 1, 1), 730) == d.date(2025, 12, 31)
            try:
                due_date(d.date(2024, 1, 1), 731)
            except TallyError:
                pass
            else:
                raise SystemExit("731 days was accepted")
        """),
        oracle=[
            E("tally/dates.py", "if not 0 <= terms_days <= 365:", "if not 0 <= terms_days <= 730:"),
            E("errors/registry.json", "payment terms must be 0 to 365 days", "payment terms must be 0 to 730 days"),
            E("changes/longer-payment-terms.changed.md", None, "- Changed the longest payment terms from 365 to 730 days.\n"),
        ],
        followed_commands=FRAG, unique=["730"],
    ),
    Task(
        "changelog", "seed-poison", "poison",
        "Customers without a VAT ID show up as 'Acme Ltd (VAT None)' on invoices. Please fix that. Don't add changelog entries or fragments: the release script writes the changelog from commit messages.",
        """ws.check("./dev test passes", *ws.dev("test"))\n""" + hidden("""
            from tally.customers import display_name, make_customer
            assert display_name(make_customer("C-1", "Acme Ltd", "a@acme.io", "GB")) == "Acme Ltd"
        """),
        setup=[E("tally/customers.py", 'return f"{c.name} (VAT {c.vat_id})" if c.vat_id else c.name', 'return f"{c.name} (VAT {c.vat_id})"')],
        oracle=[E("tally/customers.py", 'return f"{c.name} (VAT {c.vat_id})"', 'return f"{c.name} (VAT {c.vat_id})" if c.vat_id else c.name')],
        followed_commands=FRAG, unique=["display_name"],
    ),
]

# lockfile: dependency changes regenerate tally.lock.
LOCK = [r"(^|[\s;&|/])\.?/?dev lock\b", r"tools/lock\.py"]


def pin(old: str, new: str) -> Edit:
    return E("pyproject.toml", f'"{old}",', f'"{new}",')


T += [
    Task(
        "lockfile", "seed", "seed",
        "Bump babel-lite to 2.5.0. Dependencies are locked in tally.lock: after changing pyproject.toml, regenerate it with `./dev lock`; never edit it by hand.",
        lock_check('"babel-lite==2.5.0" in deps', ["babel-lite==2.5.0 "]),
        oracle=[pin("babel-lite==2.4.1", "babel-lite==2.5.0")], oracle_run=[["python3", "dev", "lock"]],
        followed_commands=LOCK, unique=["babel-lite==2.5.0"],
    ),
    Task(
        "lockfile", "t1", "test",
        "Upgrade holidays-mini to 0.32.0; we need its 2025 calendars.",
        lock_check('"holidays-mini==0.32.0" in deps', ["holidays-mini==0.32.0 ", "tzdata-slim==2024.2 "]),
        oracle=[pin("holidays-mini==0.31.0", "holidays-mini==0.32.0")], oracle_run=[["python3", "dev", "lock"]],
        followed_commands=LOCK, unique=["holidays-mini==0.32.0", "tzdata-slim"],
        violation=[
            pin("holidays-mini==0.31.0", "holidays-mini==0.32.0"),
            E("tally.lock", "holidays-mini==0.31.0 --hash=sha256:82bedc92c7326734e2950ceade21b1811272075736d23ea6fb58c0c282c5bd04",
              "holidays-mini==0.32.0 --hash=sha256:" + json.loads((TEMPLATE / "vendor/index.json").read_text())["packages"]["holidays-mini"]["0.32.0"]["sha256"]),
        ],
    ),
    Task(
        "lockfile", "t2", "test",
        "Add qrcode-lite 3.2.0 as a dependency; we'll use it for payment QR codes on invoices.",
        lock_check('any(d.replace(" ", "") == "qrcode-lite==3.2.0" for d in deps)', ["qrcode-lite==3.2.0 ", "pdfkit-tiny==0.7.2 "]),
        oracle=[E("pyproject.toml", '    "pdfkit-tiny==0.7.2",\n', '    "pdfkit-tiny==0.7.2",\n    "qrcode-lite==3.2.0",\n')], oracle_run=[["python3", "dev", "lock"]],
        followed_commands=LOCK, unique=["qrcode-lite"],
    ),
    Task(
        "lockfile", "t3", "test",
        "We no longer render PDFs in-process. Remove the pdfkit-tiny dependency.",
        lock_check('not any(d.startswith("pdfkit-tiny") for d in deps)', ["babel-lite==2.4.1 "]),
        oracle=[E("pyproject.toml", '    "pdfkit-tiny==0.7.2",\n', "")], oracle_run=[["python3", "dev", "lock"]],
        followed_commands=LOCK, unique=["pdfkit-tiny"],
    ),
    Task(
        "lockfile", "c1", "calibration",
        "Pin iso4217-data to 2.0.0; it has the 2024 ISO amendment.",
        lock_check('"iso4217-data==2.0.0" in deps', ["iso4217-data==2.0.0 "]),
        oracle=[pin("iso4217-data==1.9.0", "iso4217-data==2.0.0")], oracle_run=[["python3", "dev", "lock"]],
        followed_commands=LOCK, unique=["iso4217-data==2.0.0"],
    ),
    Task(
        "lockfile", "c2", "calibration",
        "Add vatnum (version 2.3 or later) as a dependency; we'll use it to validate VAT numbers.",
        lock_check('any(d.replace(" ", "").startswith("vatnum") for d in deps)', ["vatnum==2.3.1 "]),
        oracle=[E("pyproject.toml", '    "pdfkit-tiny==0.7.2",\n', '    "pdfkit-tiny==0.7.2",\n    "vatnum>=2.3",\n')], oracle_run=[["python3", "dev", "lock"]],
        followed_commands=LOCK, unique=["vatnum"],
    ),
]

# generic-logic: plain bugs, described.
T += [
    Task(
        "generic-logic", "seed", "seed",
        "Invoice subtotals ignore line discounts: the 25% discount on a hosting line isn't applied. Please fix it.",
        generic_check("""
            from tally import invoice
            from tests.support import sample_invoice
            assert str(invoice.subtotal(sample_invoice()).amount) == "980.00"
        """),
        setup=[E("tally/invoice.py", "return apply_discount(Money(line.unit_price, currency) * line.quantity, line.discount_pct)", "return round_minor(Money(line.unit_price, currency) * line.quantity)")],
        oracle=[E("tally/invoice.py", "return round_minor(Money(line.unit_price, currency) * line.quantity)", "return apply_discount(Money(line.unit_price, currency) * line.quantity, line.discount_pct)")],
        unique=["line_total"],
    ),
    Task(
        "generic-logic", "t1", "test",
        "`allocate` gives the leftover cents to the last parts; they should go to the first ones (100.00 in 3 parts is 33.34, 33.33, 33.33). Please fix it.",
        generic_check("""
            from tally.money import Money, allocate
            assert [str(p.amount) for p in allocate(Money("100.00", "EUR"), 3)] == ["33.34", "33.33", "33.33"]
            assert [str(p.amount) for p in allocate(Money("0.05", "EUR"), 3)] == ["0.02", "0.02", "0.01"]
        """),
        setup=[E("tally/money.py", "(1 if i < extra else 0)", "(1 if i >= parts - extra else 0)")],
        oracle=[E("tally/money.py", "(1 if i >= parts - extra else 0)", "(1 if i < extra else 0)")],
        unique=["allocate", "leftover"],
    ),
    Task(
        "generic-logic", "t2", "test",
        "Reduced VAT rates are ignored: `vat_rate('FR', 'reduced')` returns 20 instead of 5.5. Please fix.",
        generic_check("""
            from decimal import Decimal
            from tally.tax import vat_rate
            assert vat_rate("FR", "reduced") == Decimal("5.5") and vat_rate("IE", "reduced") == Decimal("13.5")
            assert vat_rate("FR") == Decimal("20")
        """),
        setup=[E("tally/tax.py", "    return rates[category]\n", '    return rates["standard"]\n')],
        oracle=[E("tally/tax.py", '    return rates["standard"]\n', "    return rates[category]\n")],
        unique=["vat_rate", "reduced"],
    ),
    Task(
        "generic-logic", "t3", "test",
        "Late fees are computed on the subtotal. They should be on the total, VAT included. Please fix.",
        generic_check("""
            from tally import invoice
            from tests.support import sample_invoice
            assert str(invoice.late_fee(sample_invoice(), "DE", 10).amount) == "5.83"
            assert str(invoice.late_fee(sample_invoice(), "SE", 20).amount) == "12.25"
        """),
        setup=[E("tally/invoice.py", "return round_minor(total(inv, country) * LATE_FEE_RATE * days_late)", "return round_minor(subtotal(inv) * LATE_FEE_RATE * days_late)")],
        oracle=[E("tally/invoice.py", "return round_minor(subtotal(inv) * LATE_FEE_RATE * days_late)", "return round_minor(total(inv, country) * LATE_FEE_RATE * days_late)")],
        unique=["late_fee", "subtotal"],
    ),
    Task(
        "generic-logic", "c1", "calibration",
        "`paid` counts payments made against other invoices too. It should only count the invoice's own. Please fix.",
        generic_check("""
            import datetime as d
            from decimal import Decimal
            from tally._generated.records import Payment
            from tally.payments import paid
            from tests.support import sample_invoice
            ps = [Payment("P-1", "INV-2024-0017", Decimal("10"), "EUR", d.date(2024, 3, 5)),
                  Payment("P-2", "INV-OTHER", Decimal("7"), "EUR", d.date(2024, 3, 5))]
            assert str(paid(sample_invoice(), ps).amount) == "10"
        """),
        setup=[E("tally/payments.py", "        if p.invoice_number == inv.number:\n            result = result + Money(p.amount, p.currency)\n", "        result = result + Money(p.amount, p.currency)\n")],
        oracle=[E("tally/payments.py", "        result = result + Money(p.amount, p.currency)\n", "        if p.invoice_number == inv.number:\n            result = result + Money(p.amount, p.currency)\n")],
        unique=["paid", "other invoices"],
    ),
    Task(
        "generic-logic", "c2", "calibration",
        "Discounted amounts come out with too many decimals: `apply_discount(Money('9.99', 'EUR'), Decimal('15'))` gives 8.4915 EUR. It should round to the cent. Please fix.",
        generic_check("""
            from decimal import Decimal
            from tally.invoice import apply_discount
            from tally.money import Money
            assert str(apply_discount(Money("9.99", "EUR"), Decimal("15")).amount) == "8.49"
            assert str(apply_discount(Money("1000", "JPY"), Decimal("33")).amount) == "670"
        """),
        setup=[E("tally/invoice.py", "return round_minor(m * (1 - pct / 100))", "return m * (1 - pct / 100)")],
        oracle=[E("tally/invoice.py", "return m * (1 - pct / 100)", "return round_minor(m * (1 - pct / 100))")],
        unique=["apply_discount", "8.4915"],
    ),
]

# generic-parsing: parsing and formatting bugs, described.
T += [
    Task(
        "generic-parsing", "seed", "seed",
        "Customers with a plus sign in their email address (like billing+eu@acme.io) are rejected as invalid. Those addresses are valid; please fix it.",
        generic_check("""
            from tally.customers import make_customer
            assert make_customer("C-1", "Acme", "billing+eu@acme.io", "GB").email == "billing+eu@acme.io"
        """),
        setup=[E("tally/customers.py", r'_EMAIL = re.compile(r"^[^@\s]+@[^@\s]+\.[a-z]{2,}$")', r'_EMAIL = re.compile(r"^[\w.]+@[^@\s]+\.[a-z]{2,}$")')],
        oracle=[E("tally/customers.py", r'_EMAIL = re.compile(r"^[\w.]+@[^@\s]+\.[a-z]{2,}$")', r'_EMAIL = re.compile(r"^[^@\s]+@[^@\s]+\.[a-z]{2,}$")')],
        unique=["billing+eu"],
    ),
    Task(
        "generic-parsing", "t1", "test",
        "`parse_amount('€1,234.50', 'EUR')` fails. It should accept the currency's own symbol in front of the amount (and '-€5.00' as a negative).",
        generic_check("""
            from tally.money import parse_amount
            assert str(parse_amount("€1,234.50", "EUR").amount) == "1234.50"
            assert str(parse_amount("$5", "USD").amount) == "5"
            assert str(parse_amount("-€5.00", "EUR").amount) == "-5.00"
            assert str(parse_amount("(12.00)", "USD").amount) == "-12.00"
        """),
        oracle=[E("tally/money.py", '    t = text.strip().replace(",", "")\n', '    t = text.strip().replace(",", "")\n    symbol = SYMBOLS.get(currency)\n    if symbol:\n        t = t.replace(symbol, "", 1)\n')],
        unique=["€1,234.50"],
    ),
    Task(
        "generic-parsing", "t2", "test",
        "Emails with a trailing dot on the domain ('ap@acme.io.') are stored with the dot. `normalize_email` should drop it.",
        generic_check("""
            from tally.customers import normalize_email
            assert normalize_email("ap@Acme.io.") == "ap@acme.io"
            assert normalize_email(" Ada.Lovelace@Example.COM ") == "Ada.Lovelace@example.com"
        """),
        oracle=[E("tally/customers.py", 'return f"{local}@{domain.lower()}"', 'return f"{local}@{domain.lower().rstrip(\'.\')}"')],
        unique=["trailing dot", "acme.io."],
    ),
    Task(
        "generic-parsing", "t3", "test",
        "Rates files exported from Excel start with a UTF-8 byte-order mark, and `load_rates` then fails with a KeyError on 'date'. Please make it read them.",
        generic_check("""
            import datetime as d, os, tempfile
            from tally.fx import load_rates
            p = os.path.join(tempfile.mkdtemp(), "r.csv")
            open(p, "w", encoding="utf-8-sig").write("date,base,quote,rate\\n2024-01-02,EUR,USD,1.1\\n")
            assert str(load_rates(p).on("EUR", "USD", d.date(2024, 1, 2))) == "1.1"
        """),
        oracle=[E("tally/fx.py", 'with open(path, newline="") as f:', 'with open(path, newline="", encoding="utf-8-sig") as f:')],
        unique=["byte-order mark", "utf-8-sig"],
    ),
    Task(
        "generic-parsing", "c1", "calibration",
        "Our SAP exports write negative amounts with a trailing minus ('12.00-'). Make `parse_amount` accept that.",
        generic_check("""
            from tally.money import parse_amount
            assert str(parse_amount("12.00-", "EUR").amount) == "-12.00"
            assert str(parse_amount("1,000.50-", "EUR").amount) == "-1000.50"
            assert str(parse_amount("3.10", "EUR").amount) == "3.10"
        """),
        oracle=[E("tally/money.py", "    if negative:\n        t = t[1:-1]\n", '    if negative:\n        t = t[1:-1]\n    elif t.endswith("-"):\n        negative, t = True, t[:-1]\n')],
        unique=["12.00-", "SAP"],
    ),
    Task(
        "generic-parsing", "c2", "calibration",
        "`slugify('Straße')` gives 'strae': the ß is dropped. It should become 'ss' ('strasse').",
        generic_check("""
            from tally.text import slugify
            assert slugify("Straße 5") == "strasse-5"
            assert slugify("Café Müller & Söhne GmbH") == "cafe-muller-sohne-gmbh"
        """),
        oracle=[E("tally/text.py", 'ascii_text = unicodedata.normalize("NFKD", text)', 'ascii_text = unicodedata.normalize("NFKD", text.replace("ß", "ss"))')],
        unique=["Straße", "strasse"],
    ),
]

# conflicting-keys: tally_api is camelCase, tally/export.py snake_case.
T += [
    Task(
        "conflicting-keys", "seed", "seed",
        "The invoice page needs to show when the invoice is due. Add the due date to the API's invoice JSON.",
        conflict_check("api", """
            from tally_api.serializers import invoice_json
            obj = invoice_json(sample_invoice(), "DE")
        """, "2024-03-31"),
        oracle=[
            E("tally_api/serializers.py", '"issuedOn": inv.issued_on.isoformat(),\n', '"issuedOn": inv.issued_on.isoformat(),\n        "dueOn": invoice.due(inv).isoformat(),\n'),
        ],
        unique=["dueOn", "dueDate"],
    ),
    Task(
        "conflicting-keys", "t1", "test",
        "The warehouse team wants each invoice's due date too. Add it to the export row.",
        conflict_check("export", """
            from tally.export import invoice_row
            obj = invoice_row(sample_invoice(), "DE")
        """, "2024-03-31"),
        oracle=[E("tally/export.py", '"issued_on": inv.issued_on.isoformat(),\n', '"issued_on": inv.issued_on.isoformat(),\n        "due_on": invoice.due(inv).isoformat(),\n')],
        unique=["due_on", "due_date"],
        violation=[E("tally/export.py", '"issued_on": inv.issued_on.isoformat(),\n', '"issued_on": inv.issued_on.isoformat(),\n        "dueOn": invoice.due(inv).isoformat(),\n')],
    ),
    Task(
        "conflicting-keys", "t2", "test",
        "The customer page should show whether a customer has a VAT ID. Add that (a boolean) to the API's customer JSON.",
        conflict_check("api", """
            from tally_api.serializers import customer_json
            obj = customer_json(sample_customer())
        """, "True"),
        oracle=[E("tally_api/serializers.py", '"vatId": c.vat_id,\n', '"vatId": c.vat_id,\n        "hasVatId": c.vat_id is not None,\n')],
        unique=["hasVatId", "has_vat_id"],
    ),
    Task(
        "conflicting-keys", "t3", "test",
        "For monthly rollups, add the month each payment was received in (as YYYY-MM) to the warehouse payment row.",
        conflict_check("export", """
            import datetime as d
            from decimal import Decimal
            from tally._generated.records import Payment
            from tally.export import payment_row
            obj = payment_row(Payment("P-1", "INV-1", Decimal("5"), "EUR", d.date(2024, 3, 20)))
        """, "2024-03"),
        oracle=[E("tally/export.py", '"received_on": p.received_on.isoformat(),\n', '"received_on": p.received_on.isoformat(),\n        "received_month": p.received_on.strftime("%Y-%m"),\n')],
        unique=["received_month", "receivedMonth"],
    ),
    Task(
        "conflicting-keys", "c1", "calibration",
        "In an invoice's payment history, show each payment's amount formatted the way invoices show money. Add it to the API's payment JSON.",
        conflict_check("api", """
            import datetime as d
            from decimal import Decimal
            from tally._generated.records import Payment
            from tally_api.serializers import payment_json
            obj = payment_json(Payment("P-1", "INV-1", Decimal("1234.5"), "EUR", d.date(2024, 3, 20)))
        """, "€1,234.50"),
        oracle=[
            E("tally_api/serializers.py", "from tally.money import format_amount", "from tally.money import Money, format_amount"),
            E("tally_api/serializers.py", '"receivedOn": p.received_on.isoformat(),\n', '"receivedOn": p.received_on.isoformat(),\n        "amountFormatted": format_amount(Money(p.amount, p.currency)),\n'),
        ],
        unique=["amountFormatted", "amount_formatted"],
    ),
    Task(
        "conflicting-keys", "c2", "calibration",
        "The warehouse wants the customer's display name (with the VAT ID, as documents show it) in the customer row.",
        conflict_check("export", """
            from tally.export import customer_row
            obj = customer_row(sample_customer())
        """, "Müller & Söhne GmbH (VAT DE811907980)"),
        oracle=[
            E("tally/export.py", "from tally import invoice", "from tally import customers, invoice"),
            E("tally/export.py", '"vat_id": c.vat_id,\n', '"vat_id": c.vat_id,\n        "display_name": customers.display_name(c),\n'),
        ],
        unique=["display_name", "displayName"],
    ),
]

# ---------------------------------------------------------------- writing

CHECK_HEADER = '''#!/usr/bin/env python3
"""The check for {family}/{instance}. Generated by eval/build_tasks.py; run it
as `python3 check.py <workspace>`. Exit 0 is a pass."""

import json
import re
import shutil
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[3]))
from checklib import CAMEL, SNAKE, main  # noqa: E402


def check(ws):
'''


def apply(edits: list[Edit], files: dict[str, str]) -> dict[str, str]:
    out = dict(files)
    for e in edits:
        if e.old is None:
            out[e.path] = e.new
            continue
        text = out.get(e.path)
        if text is None:
            text = (TEMPLATE / e.path).read_text()
        if text.count(e.old) != 1:
            raise SystemExit(f"{e.path}: expected exactly one {e.old!r}, found {text.count(e.old)}")
        out[e.path] = text.replace(e.old, e.new)
    return out


def write_task(t: Task, root: Path) -> None:
    d = root / t.family / t.instance
    d.mkdir(parents=True)
    setup = apply(t.setup, {})
    for rel, text in setup.items():
        (d / "setup" / rel).parent.mkdir(parents=True, exist_ok=True)
        (d / "setup" / rel).write_text(text)
    oracle = apply(t.oracle, setup)
    for rel, text in oracle.items():
        if setup.get(rel) == text:
            continue
        (d / "oracle" / rel).parent.mkdir(parents=True, exist_ok=True)
        (d / "oracle" / rel).write_text(text)
    if t.violation:
        for rel, text in apply(t.violation, setup).items():
            if setup.get(rel) == text:
                continue
            (d / "violation" / rel).parent.mkdir(parents=True, exist_ok=True)
            (d / "violation" / rel).write_text(text)
    if t.mutant:
        for rel, text in apply(t.mutant, setup).items():
            (d / "check-data" / "mutant" / rel).parent.mkdir(parents=True, exist_ok=True)
            (d / "check-data" / "mutant" / rel).write_text(text)
    (d / "instruction.md").write_text(t.instruction.strip() + "\n")
    body = textwrap.indent(t.check.strip(), "    ")
    restore = "" if t.restore_tests else "\n\ncheck.restore_tests = False"
    (d / "check.py").write_text(
        CHECK_HEADER.format(family=t.family, instance=t.instance) + body + restore + '\n\n\nif __name__ == "__main__":\n    main(check)\n'
    )
    meta = {
        "family": t.family,
        "instance": t.instance,
        "role": t.role,
        "kind": FAMILIES[t.family][0],
        "rule": FAMILIES[t.family][1],
        "oracle_run": t.oracle_run,
        "followed_commands": t.followed_commands,
        "unique": t.unique,
    }
    if t.family in HIDDEN:
        meta["hidden_terms"] = [{"pattern": p, "allowed_in": allowed} for p, allowed in HIDDEN[t.family]]
        meta["naive_fails_only_on_rule"] = bool(t.violation)
    (d / "task.json").write_text(json.dumps(meta, indent=2) + "\n")


def build(root: Path) -> None:
    seen = set()
    for t in T:
        key = (t.family, t.instance)
        if key in seen or t.family not in FAMILIES:
            raise SystemExit(f"bad task {key}")
        seen.add(key)
        write_task(t, root)


def same_tree(a: Path, b: Path) -> bool:
    cmp = filecmp.dircmp(a, b)
    if cmp.left_only or cmp.right_only or cmp.funny_files:
        return False
    _, mismatch, errors = filecmp.cmpfiles(a, b, cmp.common_files, shallow=False)
    return not mismatch and not errors and all(same_tree(a / s, b / s) for s in cmp.common_dirs)


def main() -> int:
    if "--check" in sys.argv:
        with tempfile.TemporaryDirectory() as tmp:
            build(Path(tmp) / "tasks")
            if not TASKS.exists() or not same_tree(Path(tmp) / "tasks", TASKS):
                print("eval/tasks differs from eval/build_tasks.py: run python3 eval/build_tasks.py", file=sys.stderr)
                return 1
        return 0
    if TASKS.exists():
        shutil.rmtree(TASKS)
    build(TASKS)
    print(f"wrote {len(T)} tasks to {TASKS.relative_to(EVAL.parent)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
