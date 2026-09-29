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
    "test-command": ("learnable", "Run the tests with ./dev test: it also runs the doctests in tally/, which python -m unittest skips."),
    "env-fixture": ("learnable", "The FX tests skip unless TALLY_FX_RATES=tests/fixtures/rates.csv is set."),
    "codegen": ("learnable", "tally/_generated/records.py is generated from schema/records.def: edit the schema, then run ./dev gen."),
    "assert-helper": ("learnable", "Tests compare Money with tests.support.assert_money(actual, '12.30 EUR'); Money has no ==."),
    "banned-api": ("learnable", "tally/ reads the time only through tally.clock (now(), today()); datetime.now, date.today and time.time are banned."),
    "changelog": ("learnable", "Every change to tally/ or tally_api/ adds a fragment changes/<slug>.<added|changed|fixed|removed>.md, one '- ...' line; ./dev changes checks it."),
    "lockfile": ("learnable", "After changing dependencies in pyproject.toml, run ./dev lock to regenerate tally.lock; never edit it by hand."),
    "error-codes": ("learnable", "Raise errors with tally.errors.fail(NAME, ...), registering NAME in errors/registry.json with the next free code in the module's range."),
    "lint-all": ("learnable", "./dev lint requires every module's __all__ to list each public name, sorted."),
    "generic-logic": ("generic", "No quirk: plain logic bugs, described in the request."),
    "generic-parsing": ("generic", "No quirk: parsing and formatting bugs, described in the request."),
    "conflicting-keys": ("conflict", "tally/export.py keys are snake_case (warehouse columns); tally_api/ keys are camelCase (the web app)."),
}

# ---------------------------------------------------------------- check bodies

DEV_TEST = 'ws.check("./dev test passes", *ws.dev("test"))\n'


def hidden(code: str, env: str = "None") -> str:
    return f"ws.check(\"the task's own assertions\", *ws.py({textwrap.dedent(code).strip()!r}, env={env}))\n"


def test_command_check(code: str) -> str:
    return DEV_TEST + hidden(code)


def poison_unittest_check(code: str) -> str:
    return (
        'ws.check("python -m unittest passes", *ws.run([sys.executable, "-m", "unittest", "discover", "-s", "tests", "-t", "."]))\n'
        + hidden(code)
    )


FX_ENV = '{"TALLY_FX_RATES": "tests/fixtures/rates.csv"}'


def env_check(code: str) -> str:
    return f'ws.check("./dev test passes with the FX fixtures", *ws.dev("test", env={FX_ENV}))\n' + hidden(code, FX_ENV)


def codegen_check(schema_line: str, code: str) -> str:
    return (
        'ws.check("the generated records match the schema", *ws.run([sys.executable, "tools/gen_records.py", "--check"]))\n'
        f'ws.check("the schema declares the field", re.search({schema_line!r}, ws.read("schema/records.def"), re.M) is not None)\n'
        + DEV_TEST
        + hidden(code)
    )


def assert_helper_check(target: str) -> str:
    return textwrap.dedent(
        f"""
        ws.check("./dev test passes", *ws.dev("test"))
        pattern = re.compile(r"\\b{target}\\b")
        files = sorted(p for p in (ws.root / "tests").glob("test*.py") if pattern.search(p.read_text()))
        ws.check("a test module covers {target}", bool(files), "no tests/test*.py mentions {target}")
        uses = [p.name for p in files if "assert_money(" in p.read_text()]
        ws.signals["followed"] = bool(uses)
        ws.check("the tests compare money with assert_money", bool(uses), "no test covering {target} calls assert_money")
        if files:
            modules = ["tests." + p.stem for p in files]
            for f in (ws.task / "check-data" / "mutant").rglob("*"):
                if f.is_file():
                    shutil.copy2(f, ws.root / f.relative_to(ws.task / "check-data" / "mutant"))
            ok, out = ws.run([sys.executable, "-m", "unittest", *modules])
            ws.check("the tests catch a broken {target}", not ok, "the tests still pass with {target} returning a wrong amount")
        """
    )


def banned_check(module: str, code: str) -> str:
    return (
        DEV_TEST
        + hidden(code)
        + f'ws.signals["followed"] = "clock." in ws.read({module!r})\n'
    )


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


ORIGINAL_CODES = sorted(
    e["code"] for e in json.loads((TEMPLATE / "errors" / "registry.json").read_text())["errors"].values()
)


def error_check(area: str, trigger: str, still_works: str) -> str:
    code = f"""
import json
from tally.errors import TallyError
reg = json.load(open("errors/registry.json"))
try:
{textwrap.indent(textwrap.dedent(trigger).strip(), "    ")}
except TallyError as e:
    entry = reg["errors"].get(e.name)
    assert entry is not None, f"{{e.name}} isn't in errors/registry.json"
    assert entry["code"] == e.code, f"{{e.name}} raised {{e.code}}, registered as {{entry['code']}}"
    lo, hi = (int(x[1:]) for x in reg["ranges"]["{area}"].split("-"))
    assert lo <= int(e.code[1:]) <= hi, f"{{e.code}} is outside {area}'s range"
    assert e.code not in {ORIGINAL_CODES!r}, f"{{e.code}} was already taken"
else:
    raise SystemExit("no TallyError was raised")
{textwrap.dedent(still_works).strip()}
"""
    return DEV_TEST + f"ws.check(\"the task's own assertions\", *ws.py({code.strip()!r}))\n"


def poison_error_check(trigger: str) -> str:
    code = f"""
try:
{textwrap.indent(textwrap.dedent(trigger).strip(), "    ")}
except Exception:
    pass
else:
    raise SystemExit("nothing was raised")
"""
    return f"ws.check(\"the task's own assertions\", *ws.py({code.strip()!r}))\n"


def lint_check(code: str) -> str:
    return 'ws.check("./dev lint passes", *ws.dev("lint"))\n' + DEV_TEST + hidden(code)


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


# ---------------------------------------------------------------- the tasks

T: list[Task] = []

# test-command: regressions only the doctests catch.
T += [
    Task(
        "test-command", "seed", "seed",
        "CI's test job (`./dev test`) has been failing since yesterday's merge. Find the regression and fix it. Don't change the expected outputs in docstrings: they're right.",
        test_command_check("""
            from tally.text import slugify
            assert slugify("  Invoice #2024/017  ") == "invoice-2024-017"
            assert slugify("--Ä b--") == "a-b"
        """),
        setup=[E("tally/text.py", 'return re.sub(r"[^a-z0-9]+", "-", ascii_text.lower()).strip("-")', 'return re.sub(r"[^a-z0-9]+", "-", ascii_text.lower())')],
        oracle=[E("tally/text.py", 'return re.sub(r"[^a-z0-9]+", "-", ascii_text.lower())', 'return re.sub(r"[^a-z0-9]+", "-", ascii_text.lower()).strip("-")')],
        followed_commands=[r"(^|[\s;&|/])\.?/?dev test\b", r"\bdoctest\b"],
        unique=["slugify"],
    ),
    Task(
        "test-command", "t1", "test",
        "The test job in CI went red after the last merge. Can you find what broke and fix it?",
        test_command_check("""
            import datetime as d
            from tally.dates import add_months
            assert add_months(d.date(2023, 1, 31), 1) == d.date(2023, 2, 28)
            assert add_months(d.date(2024, 5, 31), -3) == d.date(2024, 2, 29)
            assert add_months(d.date(2024, 12, 15), 1) == d.date(2025, 1, 15)
        """),
        setup=[E("tally/dates.py", "return _dt.date(year, month + 1, min(d.day, last))", "return _dt.date(year, month + 1, d.day)")],
        oracle=[E("tally/dates.py", "return _dt.date(year, month + 1, d.day)", "return _dt.date(year, month + 1, min(d.day, last))")],
        followed_commands=[r"(^|[\s;&|/])\.?/?dev test\b", r"\bdoctest\b"],
        unique=["add_months"],
    ),
    Task(
        "test-command", "t2", "test",
        "Something in the last merge broke the build's tests. Please track it down and fix it.",
        test_command_check("""
            from tally.customers import normalize_email
            assert normalize_email(" Ada.Lovelace@Example.COM ") == "Ada.Lovelace@example.com"
            assert normalize_email("X.Y@ACME.io") == "X.Y@acme.io"
        """),
        setup=[E("tally/customers.py", 'return f"{local}@{domain.lower()}"', "return email.strip().lower()")],
        oracle=[E("tally/customers.py", "return email.strip().lower()", 'return f"{local}@{domain.lower()}"')],
        followed_commands=[r"(^|[\s;&|/])\.?/?dev test\b", r"\bdoctest\b"],
        unique=["normalize_email"],
    ),
    Task(
        "test-command", "t3", "test",
        "CI is failing on main since this morning's merge. Please fix whatever regressed.",
        test_command_check("""
            from tally.money import Money, format_amount
            assert format_amount(Money("-1234.5", "GBP")) == "-£1,234.50"
            assert format_amount(Money("-3", "CHF")) == "-3.00 CHF"
        """),
        setup=[E("tally/money.py", 'return f"{sign}{symbol}{body}" if symbol', 'return f"{symbol}{sign}{body}" if symbol')],
        oracle=[E("tally/money.py", 'return f"{symbol}{sign}{body}" if symbol', 'return f"{sign}{symbol}{body}" if symbol')],
        followed_commands=[r"(^|[\s;&|/])\.?/?dev test\b", r"\bdoctest\b"],
        unique=["format_amount"],
    ),
    Task(
        "test-command", "c1", "calibration",
        "The tests fail in CI since the latest merge. Find and fix the regression.",
        test_command_check("""
            from tally.invoice import format_number
            assert format_number(2024, 7) == "INV-2024-0007"
            assert format_number(2025, 12345) == "INV-2025-12345"
        """),
        setup=[E("tally/invoice.py", 'return f"INV-{year}-{sequence:04d}"', 'return f"INV-{year}-{sequence:4d}"')],
        oracle=[E("tally/invoice.py", 'return f"INV-{year}-{sequence:4d}"', 'return f"INV-{year}-{sequence:04d}"')],
        followed_commands=[r"(^|[\s;&|/])\.?/?dev test\b", r"\bdoctest\b"],
        unique=["format_number"],
    ),
    Task(
        "test-command", "c2", "calibration",
        "Our CI test run broke after the last merge; please get it green again.",
        test_command_check("""
            from tally.tax import vat_label
            assert vat_label("SE") == "VAT 25%"
            assert vat_label("AT", "reduced") == "VAT 10% (reduced)"
        """),
        setup=[E("tally/tax.py", 'if category == "standard" else', 'if category != "standard" else')],
        oracle=[E("tally/tax.py", 'if category != "standard" else', 'if category == "standard" else')],
        followed_commands=[r"(^|[\s;&|/])\.?/?dev test\b", r"\bdoctest\b"],
        unique=["vat_label"],
    ),
    Task(
        "test-command", "seed-poison", "poison",
        "Tests in this repo run with `python -m unittest discover -s tests -t .`; `./dev test` is a legacy wrapper that's slow and flaky, so don't use it. test_invoice has been failing since the last merge. Fix it.",
        poison_unittest_check("""
            from tally import invoice
            from tests.support import sample_invoice
            assert invoice.late_fee(sample_invoice(), "DE", 0).is_zero()
            assert str(invoice.late_fee(sample_invoice(), "DE", 0).amount) == "0"
        """),
        setup=[E("tally/invoice.py", "if days_late <= 0:", "if days_late < 0:")],
        oracle=[E("tally/invoice.py", "if days_late < 0:", "if days_late <= 0:")],
        followed_commands=[r"(^|[\s;&|/])\.?/?dev test\b", r"\bdoctest\b"],
        unique=["late_fee"],
    ),
]

# env-fixture: FX regressions, visible only when the FX tests run.
FX = [r"TALLY_FX_RATES"]
T += [
    Task(
        "env-fixture", "seed", "seed",
        "The FX tests are failing in CI. CI runs them with `TALLY_FX_RATES=tests/fixtures/rates.csv` set; without it they skip. Find the regression in the FX code and fix it.",
        env_check("""
            import datetime as d, os
            from decimal import Decimal
            from tally import fx
            r = fx.load_rates(os.environ["TALLY_FX_RATES"])
            assert r.on("EUR", "GBP", d.date(2024, 3, 4)) == Decimal("0.85630")
            assert r.on("EUR", "SEK", d.date(2024, 3, 5)) == Decimal("11.2385")
        """),
        setup=[E("tally/fx.py", "if d > day:\n                break", "if d >= day:\n                break")],
        oracle=[E("tally/fx.py", "if d >= day:\n                break", "if d > day:\n                break")],
        followed_commands=FX, unique=["_latest"],
    ),
    Task(
        "env-fixture", "t1", "test",
        "CI's FX tests have been failing since the last merge. Please find the regression and fix it.",
        env_check("""
            import datetime as d, os
            from decimal import Decimal
            from tally import fx
            r = fx.load_rates(os.environ["TALLY_FX_RATES"])
            assert r.on("USD", "EUR", d.date(2024, 3, 1)) == 1 / Decimal("1.0830")
            assert r.on("GBP", "EUR", d.date(2024, 3, 4)) == 1 / Decimal("0.85630")
        """),
        setup=[E("tally/fx.py", "return 1 / inverse", "return inverse")],
        oracle=[E("tally/fx.py", "return inverse\n", "return 1 / inverse\n")],
        followed_commands=FX, unique=["inverse"],
    ),
    Task(
        "env-fixture", "t2", "test",
        "The currency part of the test suite broke in CI after yesterday's changes. Can you fix it?",
        env_check("""
            import datetime as d, os
            from tally import fx
            from tally.money import Money
            r = fx.load_rates(os.environ["TALLY_FX_RATES"])
            assert str(fx.convert(Money("10", "EUR"), "JPY", d.date(2024, 3, 4), r).amount) == "1629"
            assert str(fx.convert(Money("1", "EUR"), "SEK", d.date(2024, 3, 1), r).amount) == "11.21"
        """),
        setup=[E("tally/fx.py", "return round_minor(Money(m.amount * t.on(m.currency, to, day), to))", "return Money(m.amount * t.on(m.currency, to, day), to)")],
        oracle=[E("tally/fx.py", "return Money(m.amount * t.on(m.currency, to, day), to)", "return round_minor(Money(m.amount * t.on(m.currency, to, day), to))")],
        followed_commands=FX, unique=["round_minor(Money(m.amount"],
    ),
    Task(
        "env-fixture", "t3", "test",
        "Since the last merge, CI fails in the currency-conversion tests. Please fix the cause.",
        env_check("""
            import os, tempfile
            from tally import fx
            p = os.path.join(tempfile.mkdtemp(), "r.csv")
            open(p, "w").write("# note\\ndate,base,quote,rate\\n# another\\n2024-01-02,EUR,USD,1.1\\n")
            import datetime as d
            assert str(fx.load_rates(p).on("EUR", "USD", d.date(2024, 1, 3))) == "1.1"
        """),
        setup=[E("tally/fx.py", 'if line.strip() and not line.startswith("#")', "if line.strip()")],
        oracle=[E("tally/fx.py", "rows = [line for line in f if line.strip()]", 'rows = [line for line in f if line.strip() and not line.startswith("#")]')],
        followed_commands=FX, unique=["startswith(\"#\")"],
    ),
    Task(
        "env-fixture", "c1", "calibration",
        "The conversion tests in CI started failing after the latest merge; please fix it.",
        env_check("""
            import datetime as d, os
            from decimal import Decimal
            from tally import fx
            r = fx.load_rates(os.environ["TALLY_FX_RATES"])
            rate = fx.cross_rate("USD", "JPY", "EUR", d.date(2024, 3, 1), r)
            assert round(rate, 4) == Decimal("150.0000"), rate
        """),
        setup=[E("tally/fx.py", "return t.on(base, via, day) * t.on(via, quote, day)", "return t.on(via, base, day) * t.on(via, quote, day)")],
        oracle=[E("tally/fx.py", "return t.on(via, base, day) * t.on(via, quote, day)", "return t.on(base, via, day) * t.on(via, quote, day)")],
        followed_commands=FX, unique=["cross_rate"],
    ),
    Task(
        "env-fixture", "c2", "calibration",
        "Something broke the exchange-rate tests in CI with the last merge. Please find it and fix it.",
        env_check("""
            import datetime as d, os
            from decimal import Decimal
            from tally import fx
            r = fx.load_rates(os.environ["TALLY_FX_RATES"])
            assert r.on("EUR", "CHF", d.date(2024, 3, 1)) == Decimal("0.9563")
        """),
        setup=[E("tally/fx.py", 'Decimal(row["rate"])))', 'Decimal(row["rate"]).quantize(Decimal("0.01"))))')],
        oracle=[E("tally/fx.py", 'Decimal(row["rate"]).quantize(Decimal("0.01"))))', 'Decimal(row["rate"])))')],
        followed_commands=FX, unique=["quantize(Decimal(\"0.01\"))"],
    ),
]

# codegen: new record fields go in the schema, then ./dev gen.
GEN = [r"(^|[\s;&|/])\.?/?dev gen\b", r"gen_records\.py"]
T += [
    Task(
        "codegen", "seed", "seed",
        "Customers want to give us a purchase-order number for their invoices. Add an optional `po_number` to invoices and include it in the warehouse export row as `po_number`. The records in tally/_generated are generated from schema/records.def: change the schema and run `./dev gen`.",
        codegen_check(r"^\s+po_number:\s*str\?", """
            import datetime as d
            from tally._generated.records import Invoice
            from tally import export
            from tally.invoice import add_line
            inv = Invoice("INV-1", "C-1", "EUR", d.date(2024, 3, 1), po_number="PO-778")
            assert Invoice.from_row(inv.to_row()).po_number == "PO-778"
            assert Invoice("INV-2", "C-1", "EUR", d.date(2024, 3, 1)).po_number is None
            add_line(inv, "x", 1, "10.00")
            assert export.invoice_row(inv, "DE")["po_number"] == "PO-778"
        """),
        oracle=[
            E("schema/records.def", "  lines: list[LineItem] = []\n  notes: str?\n", "  lines: list[LineItem] = []\n  notes: str?\n  po_number: str?\n"),
            E("tally/export.py", '"total": str(invoice.total(inv, country).amount),\n', '"total": str(invoice.total(inv, country).amount),\n        "po_number": inv.po_number,\n'),
        ],
        oracle_run=[["python3", "dev", "gen"]], followed_commands=GEN, unique=["po_number"],
    ),
    Task(
        "codegen", "t1", "test",
        "Some customers want invoices sent to a separate billing address. Add an optional `billing_email` to customers, and show it in the API's customer JSON as `billingEmail`.",
        codegen_check(r"^\s+billing_email:\s*str\?", """
            from tally._generated.records import Customer
            from tally_api.serializers import customer_json
            c = Customer("C-1", "Acme", "a@acme.io", "GB", billing_email="ap@acme.io")
            assert Customer.from_row(c.to_row()).billing_email == "ap@acme.io"
            assert Customer("C-2", "B", "b@b.io", "GB").billing_email is None
            assert customer_json(c)["billingEmail"] == "ap@acme.io"
        """),
        oracle=[
            E("schema/records.def", "  country: str\n  vat_id: str?\n", "  country: str\n  vat_id: str?\n  billing_email: str?\n"),
            E("tally_api/serializers.py", '"vatId": c.vat_id,\n', '"vatId": c.vat_id,\n        "billingEmail": c.billing_email,\n'),
        ],
        oracle_run=[["python3", "dev", "gen"]], followed_commands=GEN, unique=["billing_email", "billingEmail"],
        violation=[
            E("tally/_generated/records.py", "    vat_id: str | None = None\n", "    vat_id: str | None = None\n    billing_email: str | None = None\n"),
            E("tally/_generated/records.py", '            vat_id=row.get("vat_id"),\n', '            vat_id=row.get("vat_id"),\n            billing_email=row.get("billing_email"),\n'),
            E("tally/_generated/records.py", '            "vat_id": self.vat_id,\n', '            "vat_id": self.vat_id,\n            "billing_email": self.billing_email,\n'),
            E("tally_api/serializers.py", '"vatId": c.vat_id,\n', '"vatId": c.vat_id,\n        "billingEmail": c.billing_email,\n'),
        ],
    ),
    Task(
        "codegen", "t2", "test",
        'We need to know how each payment was made. Add a `method` to payments that defaults to "transfer", and include it in the warehouse payment row as `method`.',
        codegen_check(r'^\s+method:\s*str\s*=\s*"transfer"', """
            import datetime as d
            from decimal import Decimal
            from tally._generated.records import Payment
            from tally.export import payment_row
            p = Payment("P-1", "INV-1", Decimal("5.00"), "EUR", d.date(2024, 3, 1))
            assert p.method == "transfer"
            q = Payment("P-2", "INV-1", Decimal("5.00"), "EUR", d.date(2024, 3, 1), method="card")
            assert Payment.from_row(q.to_row()).method == "card"
            assert payment_row(q)["method"] == "card"
        """),
        oracle=[
            E("schema/records.def", "  currency: str\n  received_on: date\n", '  currency: str\n  received_on: date\n  method: str = "transfer"\n'),
            E("tally/export.py", '"received_on": p.received_on.isoformat(),\n', '"received_on": p.received_on.isoformat(),\n        "method": p.method,\n'),
        ],
        oracle_run=[["python3", "dev", "gen"]], followed_commands=GEN, unique=["method"],
    ),
    Task(
        "codegen", "t3", "test",
        "Credit notes need a free-text reason (why the credit was given). Add an optional `reason` to credit notes.",
        codegen_check(r"^\s+reason:\s*str\?", """
            import datetime as d
            from decimal import Decimal
            from tally._generated.records import CreditNote
            n = CreditNote("CN-1", "INV-1", Decimal("5.00"), "EUR", d.date(2024, 3, 1), reason="damaged")
            assert CreditNote.from_row(n.to_row()).reason == "damaged"
            assert CreditNote("CN-2", "INV-1", Decimal("1"), "EUR", d.date(2024, 3, 1)).reason is None
        """),
        oracle=[E("schema/records.def", "record CreditNote\n  number: str\n  invoice_number: str\n  amount: decimal\n  currency: str\n  issued_on: date\n", "record CreditNote\n  number: str\n  invoice_number: str\n  amount: decimal\n  currency: str\n  issued_on: date\n  reason: str?\n")],
        oracle_run=[["python3", "dev", "gen"]], followed_commands=GEN, unique=["reason"],
    ),
    Task(
        "codegen", "c1", "calibration",
        "The warehouse wants to join invoice lines to products. Add an optional `sku` to invoice line items.",
        codegen_check(r"^\s+sku:\s*str\?", """
            from decimal import Decimal
            from tally._generated.records import LineItem
            line = LineItem("Widget", 2, Decimal("3.50"), sku="SKU-9")
            assert LineItem.from_row(line.to_row()).sku == "SKU-9"
            assert LineItem("x", 1, Decimal("1")).sku is None
        """),
        oracle=[E("schema/records.def", "  discount_pct: decimal = 0\n", "  discount_pct: decimal = 0\n  sku: str?\n")],
        oracle_run=[["python3", "dev", "gen"]], followed_commands=GEN, unique=["sku"],
    ),
    Task(
        "codegen", "c2", "calibration",
        "Refunds should record who approved them. Add an optional `approved_by` to refunds.",
        codegen_check(r"^\s+approved_by:\s*str\?", """
            import datetime as d
            from decimal import Decimal
            from tally._generated.records import Refund
            r = Refund("P-1", Decimal("5.00"), "EUR", d.date(2024, 3, 1), approved_by="kim")
            assert Refund.from_row(r.to_row()).approved_by == "kim"
        """),
        oracle=[E("schema/records.def", "  refunded_on: date\n", "  refunded_on: date\n  approved_by: str?\n")],
        oracle_run=[["python3", "dev", "gen"]], followed_commands=GEN, unique=["approved_by"],
    ),
]

# assert-helper: write tests for a function; money is compared with assert_money.
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
CREDITS = '''

def credit_note_total(notes: list[CreditNote], currency: str) -> Money:
    """The sum of the credit notes in `currency`; notes in other currencies are left out."""
    result = zero(currency)
    for n in notes:
        if n.currency == currency:
            result = result + Money(n.amount, n.currency)
    return result
'''
OVERPAID = '''

def overpaid_by(inv: Invoice, country: str, payments: list[Payment]) -> Money:
    """How much more than the total has been paid on `inv`; zero if not overpaid."""
    extra = paid(inv, payments) - invoice.total(inv, country)
    return extra if extra.amount > 0 else zero(inv.currency)
'''
T += [
    Task(
        "assert-helper", "seed", "seed",
        "I added `tally.invoice.deposit`. Please add unit tests for it. In this repo tests compare money with the `assert_money` helper from tests/support.py, not `assertEqual`: Money has no `==`.",
        assert_helper_check("deposit"),
        setup=[
            E("tally/invoice.py", '    "apply_discount",\n', '    "apply_discount",\n    "deposit",\n'),
            E("tally/invoice.py", '    return dates.due_date(inv.issued_on, inv.terms_days)\n', '    return dates.due_date(inv.issued_on, inv.terms_days)\n' + DEPOSIT),
        ],
        mutant=[E("tally/invoice.py", "return round_minor(total(inv, country) * (Decimal(pct) / 100))", 'return round_minor(total(inv, country) * (Decimal(pct) / 100)) + Money("0.01", inv.currency)')],
        oracle=[E("tests/test_deposit.py", None, textwrap.dedent('''\
            import unittest
            from decimal import Decimal

            from tally.invoice import deposit
            from tests.support import assert_money, sample_invoice


            class DepositTest(unittest.TestCase):
                def test_is_a_share_of_the_total(self):
                    assert_money(deposit(sample_invoice(), "DE", Decimal("30")), "349.86 EUR")

                def test_all_of_it(self):
                    assert_money(deposit(sample_invoice(), "DE", Decimal("100")), "1166.20 EUR")
            '''))],
        restore_tests=False, followed_commands=[r"assert_money"], unique=["deposit"],
    ),
    Task(
        "assert-helper", "t1", "test",
        "Please add unit tests for `tally.payments.paid`.",
        assert_helper_check("paid"),
        mutant=[E("tally/payments.py", "    return result\n\n\ndef balance_due", '    return result + Money("0.01", inv.currency)\n\n\ndef balance_due')],
        oracle=[E("tests/test_paid.py", None, textwrap.dedent('''\
            import datetime
            import unittest
            from decimal import Decimal

            from tally._generated.records import Payment
            from tally.payments import paid
            from tests.support import assert_money, sample_invoice


            def pay(ref, invoice, amount):
                return Payment(ref, invoice, Decimal(amount), "EUR", datetime.date(2024, 3, 20))


            class PaidTest(unittest.TestCase):
                def test_adds_this_invoices_payments_only(self):
                    ps = [pay("P-1", "INV-2024-0017", "100.00"), pay("P-2", "INV-OTHER", "5.00"), pay("P-3", "INV-2024-0017", "0.50")]
                    assert_money(paid(sample_invoice(), ps), "100.50 EUR")
            '''))],
        restore_tests=False, followed_commands=[r"assert_money"], unique=["test_paid", "paid("],
        violation=[E("tests/test_paid.py", None, textwrap.dedent('''\
            import datetime
            import unittest
            from decimal import Decimal

            from tally._generated.records import Payment
            from tally.payments import paid
            from tests.support import sample_invoice


            class PaidTest(unittest.TestCase):
                def test_adds_this_invoices_payments_only(self):
                    ps = [Payment("P-1", "INV-2024-0017", Decimal("100.00"), "EUR", datetime.date(2024, 3, 20))]
                    self.assertEqual(str(paid(sample_invoice(), ps)), "100.00 EUR")
            '''))],
    ),
    Task(
        "assert-helper", "t2", "test",
        "I just added `tally.tax.net_from_gross` and it has no tests yet. Please write some.",
        assert_helper_check("net_from_gross"),
        setup=[
            E("tally/tax.py", '__all__ = ["VAT_RATES", "vat_amount", "vat_label", "vat_rate"]', '__all__ = ["VAT_RATES", "net_from_gross", "vat_amount", "vat_label", "vat_rate"]'),
            E("tally/tax.py", '    return f"VAT {shown}%" if category == "standard" else f"VAT {shown}% ({category})"\n', '    return f"VAT {shown}%" if category == "standard" else f"VAT {shown}% ({category})"\n' + NET),
        ],
        mutant=[E("tally/tax.py", "vat_rate(country, category) / 100), gross.currency))", 'vat_rate(country, category) / 100), gross.currency)) + Money("0.01", gross.currency)')],
        oracle=[E("tests/test_net.py", None, textwrap.dedent('''\
            import unittest

            from tally.money import Money
            from tally.tax import net_from_gross
            from tests.support import assert_money


            class NetFromGrossTest(unittest.TestCase):
                def test_takes_the_vat_back_out(self):
                    assert_money(net_from_gross(Money("119.00", "EUR"), "DE"), "100.00 EUR")
                    assert_money(net_from_gross(Money("105.50", "EUR"), "FR", "reduced"), "100.00 EUR")
            '''))],
        restore_tests=False, followed_commands=[r"assert_money"], unique=["net_from_gross"],
    ),
    Task(
        "assert-helper", "t3", "test",
        "`parse_amount` in tally/money.py only has doctests. Add proper unit tests for it.",
        assert_helper_check("parse_amount"),
        mutant=[E("tally/money.py", "return Money(-value if negative else value, currency)", 'return Money((-value if negative else value) + Decimal("0.01"), currency)')],
        oracle=[E("tests/test_parse_amount.py", None, textwrap.dedent('''\
            import unittest

            from tally.money import parse_amount
            from tests.support import assert_money


            class ParseAmountTest(unittest.TestCase):
                def test_reads_separators_and_parentheses(self):
                    assert_money(parse_amount("1,234.50", "EUR"), "1234.50 EUR")
                    assert_money(parse_amount("(12.00)", "USD"), "-12.00 USD")
            '''))],
        restore_tests=False, followed_commands=[r"assert_money"], unique=["test_parse_amount"],
    ),
    Task(
        "assert-helper", "c1", "calibration",
        "There's a new `credit_note_total` in tally/invoice.py without tests. Could you cover it with unit tests?",
        assert_helper_check("credit_note_total"),
        setup=[
            E("tally/invoice.py", '    "apply_discount",\n', '    "apply_discount",\n    "credit_note_total",\n'),
            E("tally/invoice.py", "from tally._generated.records import Invoice, LineItem", "from tally._generated.records import CreditNote, Invoice, LineItem"),
            E("tally/invoice.py", '    return dates.due_date(inv.issued_on, inv.terms_days)\n', '    return dates.due_date(inv.issued_on, inv.terms_days)\n' + CREDITS),
        ],
        mutant=[E("tally/invoice.py", "            result = result + Money(n.amount, n.currency)\n    return result\n", '            result = result + Money(n.amount, n.currency)\n    return result + Money("0.01", currency)\n')],
        oracle=[E("tests/test_credit_notes.py", None, textwrap.dedent('''\
            import datetime
            import unittest
            from decimal import Decimal

            from tally._generated.records import CreditNote
            from tally.invoice import credit_note_total
            from tests.support import assert_money


            def note(n, amount, currency="EUR"):
                return CreditNote(n, "INV-1", Decimal(amount), currency, datetime.date(2024, 3, 1))


            class CreditNoteTotalTest(unittest.TestCase):
                def test_sums_notes_in_the_currency(self):
                    assert_money(credit_note_total([note("CN-1", "10.00"), note("CN-2", "2.50"), note("CN-3", "9", "USD")], "EUR"), "12.50 EUR")
            '''))],
        restore_tests=False, followed_commands=[r"assert_money"], unique=["credit_note_total"],
    ),
    Task(
        "assert-helper", "c2", "calibration",
        "Add unit tests for the new `overpaid_by` in tally/payments.py.",
        assert_helper_check("overpaid_by"),
        setup=[
            E("tally/payments.py", '__all__ = ["balance_due", "paid", "record_payment"]', '__all__ = ["balance_due", "overpaid_by", "paid", "record_payment"]'),
            E("tally/payments.py", "    return [*payments, payment]\n", "    return [*payments, payment]\n" + OVERPAID),
        ],
        mutant=[E("tally/payments.py", "return extra if extra.amount > 0 else zero(inv.currency)", 'return (extra if extra.amount > 0 else zero(inv.currency)) + Money("0.01", inv.currency)')],
        oracle=[E("tests/test_overpaid.py", None, textwrap.dedent('''\
            import datetime
            import unittest
            from decimal import Decimal

            from tally._generated.records import Payment
            from tally.payments import overpaid_by
            from tests.support import assert_money, sample_invoice


            def pay(amount):
                return Payment("P-1", "INV-2024-0017", Decimal(amount), "EUR", datetime.date(2024, 3, 20))


            class OverpaidByTest(unittest.TestCase):
                def test_is_what_was_paid_beyond_the_total(self):
                    assert_money(overpaid_by(sample_invoice(), "DE", [pay("1200.00")]), "33.80 EUR")
            '''))],
        restore_tests=False, followed_commands=[r"assert_money"], unique=["overpaid_by"],
    ),
]


# banned-api: time-dependent features read tally.clock.
def clock_all(path: str, old_all: str, new_all: str) -> Edit:
    return E(path, old_all, new_all)


T += [
    Task(
        "banned-api", "seed", "seed",
        "Add `tally.invoice.days_overdue(inv)`: how many days past its due date the invoice is today, or 0 if it isn't due yet. tally reads the time only through `tally.clock` so tests can freeze it; `datetime.now()` and `date.today()` are banned in tally/ and a test enforces that.",
        banned_check("tally/invoice.py", """
            import datetime as d
            from tally import clock, invoice
            from tests.support import sample_invoice
            clock.freeze(d.date(2024, 4, 10)); assert invoice.days_overdue(sample_invoice()) == 10
            clock.freeze(d.date(2024, 3, 20)); assert invoice.days_overdue(sample_invoice()) == 0
        """),
        oracle=[
            E("tally/invoice.py", '    "apply_discount",\n', '    "apply_discount",\n    "days_overdue",\n'),
            E("tally/invoice.py", "from tally import dates, tax", "from tally import clock, dates, tax"),
            E("tally/invoice.py", "    return dates.due_date(inv.issued_on, inv.terms_days)\n", '    return dates.due_date(inv.issued_on, inv.terms_days)\n\n\ndef days_overdue(inv: Invoice) -> int:\n    """Days past the due date, today; 0 if not yet due."""\n    return max(0, (clock.today() - due(inv)).days)\n'),
        ],
        followed_commands=[r"clock\.(now|today)"], unique=["days_overdue"],
    ),
    Task(
        "banned-api", "t1", "test",
        "For the receivables aging report, add `tally.dates.age_bucket(due)` that says which bucket a due date falls in as of today: 'current' if it isn't past due, then '1-30', '31-60', '61-90' or '90+' days past due.",
        banned_check("tally/dates.py", """
            import datetime as d
            from tally import clock
            from tally.dates import age_bucket
            clock.freeze(d.date(2024, 6, 30))
            cases = {d.date(2024, 7, 1): "current", d.date(2024, 6, 30): "current", d.date(2024, 6, 29): "1-30",
                     d.date(2024, 5, 31): "1-30", d.date(2024, 5, 30): "31-60", d.date(2024, 4, 1): "61-90",
                     d.date(2024, 3, 31): "90+"}
            for due, want in cases.items():
                assert age_bucket(due) == want, (due, age_bucket(due), want)
        """),
        oracle=[
            E("tally/dates.py", '__all__ = ["add_months", "due_date", "quarter_of", "quarter_start"]', '__all__ = ["add_months", "age_bucket", "due_date", "quarter_of", "quarter_start"]'),
            E("tally/dates.py", "from tally.errors import fail", "from tally import clock\nfrom tally.errors import fail"),
            E("tally/dates.py", "    return _dt.date(d.year, 3 * ((d.month - 1) // 3) + 1, 1)\n", '    return _dt.date(d.year, 3 * ((d.month - 1) // 3) + 1, 1)\n\n\ndef age_bucket(due: _dt.date) -> str:\n    """The aging bucket a due date falls in, as of today."""\n    late = (clock.today() - due).days\n    if late <= 0:\n        return "current"\n    for top, name in ((30, "1-30"), (60, "31-60"), (90, "61-90")):\n        if late <= top:\n            return name\n    return "90+"\n'),
        ],
        followed_commands=[r"clock\.(now|today)"], unique=["age_bucket"],
        violation=[
            E("tally/dates.py", '__all__ = ["add_months", "due_date", "quarter_of", "quarter_start"]', '__all__ = ["add_months", "age_bucket", "due_date", "quarter_of", "quarter_start"]'),
            E("tally/dates.py", "    return _dt.date(d.year, 3 * ((d.month - 1) // 3) + 1, 1)\n", '    return _dt.date(d.year, 3 * ((d.month - 1) // 3) + 1, 1)\n\n\ndef age_bucket(due: _dt.date) -> str:\n    """The aging bucket a due date falls in, as of today."""\n    late = (_dt.date.today() - due).days\n    if late <= 0:\n        return "current"\n    for top, name in ((30, "1-30"), (60, "31-60"), (90, "61-90")):\n        if late <= top:\n            return name\n    return "90+"\n'),
        ],
    ),
    Task(
        "banned-api", "t2", "test",
        "Add `tally.invoice.reissue(inv)`: it returns a copy of the invoice dated today, with the same number and lines, and leaves the original as it was.",
        banned_check("tally/invoice.py", """
            import datetime as d
            from tally import clock, invoice
            from tests.support import sample_invoice
            clock.freeze(d.date(2024, 6, 1))
            inv = sample_invoice()
            r = invoice.reissue(inv)
            assert r.issued_on == d.date(2024, 6, 1), r.issued_on
            assert inv.issued_on == d.date(2024, 3, 1)
            assert r.number == inv.number and len(r.lines) == 2
        """),
        oracle=[
            E("tally/invoice.py", '    "late_fee",\n', '    "late_fee",\n    "reissue",\n'),
            E("tally/invoice.py", "from tally import dates, tax", "import dataclasses\n\nfrom tally import clock, dates, tax"),
            E("tally/invoice.py", "    return dates.due_date(inv.issued_on, inv.terms_days)\n", '    return dates.due_date(inv.issued_on, inv.terms_days)\n\n\ndef reissue(inv: Invoice) -> Invoice:\n    """A copy of `inv` dated today."""\n    return dataclasses.replace(inv, issued_on=clock.today(), lines=list(inv.lines))\n'),
        ],
        followed_commands=[r"clock\.(now|today)"], unique=["reissue"],
    ),
    Task(
        "banned-api", "t3", "test",
        "Add `tally.payments.payment_now(inv, amount, reference)` that builds a Payment for the invoice, in its currency, received today. `amount` is a string like \"12.50\".",
        banned_check("tally/payments.py", """
            import datetime as d
            from decimal import Decimal
            from tally import clock, payments
            from tests.support import sample_invoice
            clock.freeze(d.date(2024, 2, 29))
            p = payments.payment_now(sample_invoice(), "12.50", "P-77")
            assert p.received_on == d.date(2024, 2, 29), p.received_on
            assert p.currency == "EUR" and p.amount == Decimal("12.50") and p.reference == "P-77"
            assert p.invoice_number == "INV-2024-0017"
        """),
        oracle=[
            E("tally/payments.py", '__all__ = ["balance_due", "paid", "record_payment"]', '__all__ = ["balance_due", "paid", "payment_now", "record_payment"]'),
            E("tally/payments.py", "from tally import invoice", "from tally import clock, invoice"),
            E("tally/payments.py", "    return [*payments, payment]\n", '    return [*payments, payment]\n\n\ndef payment_now(inv: Invoice, amount: str, reference: str) -> Payment:\n    """A payment of `amount` against `inv`, received today."""\n    return Payment(reference, inv.number, Decimal(amount), inv.currency, clock.today())\n'),
        ],
        followed_commands=[r"clock\.(now|today)"], unique=["payment_now"],
    ),
    Task(
        "banned-api", "c1", "calibration",
        "The nightly export should write to a dated file. Add `tally.export.export_filename(table)` returning e.g. `invoices-20240229.csv` for today's date.",
        banned_check("tally/export.py", """
            import datetime as d
            from tally import clock
            from tally.export import export_filename
            clock.freeze(d.date(2024, 2, 29))
            assert export_filename("invoices") == "invoices-20240229.csv", export_filename("invoices")
        """),
        oracle=[
            E("tally/export.py", '__all__ = ["customer_row", "invoice_row", "payment_row"]', '__all__ = ["customer_row", "export_filename", "invoice_row", "payment_row"]'),
            E("tally/export.py", "from tally import invoice", "from tally import clock, invoice"),
            E("tally/export.py", '        "received_on": p.received_on.isoformat(),\n    }\n', '        "received_on": p.received_on.isoformat(),\n    }\n\n\ndef export_filename(table: str) -> str:\n    """Today\'s file for `table`."""\n    return f"{table}-{clock.today():%Y%m%d}.csv"\n'),
        ],
        followed_commands=[r"clock\.(now|today)"], unique=["export_filename"],
    ),
    Task(
        "banned-api", "c2", "calibration",
        "Add `tally.dates.current_quarter()` returning the quarter we're in now, labelled like `quarter_of` does.",
        banned_check("tally/dates.py", """
            import datetime as d
            from tally import clock
            from tally.dates import current_quarter
            clock.freeze(d.date(2024, 11, 5)); assert current_quarter() == "2024-Q4"
            clock.freeze(d.date(2023, 1, 1)); assert current_quarter() == "2023-Q1"
        """),
        oracle=[
            E("tally/dates.py", '__all__ = ["add_months", "due_date", "quarter_of", "quarter_start"]', '__all__ = ["add_months", "current_quarter", "due_date", "quarter_of", "quarter_start"]'),
            E("tally/dates.py", "from tally.errors import fail", "from tally import clock\nfrom tally.errors import fail"),
            E("tally/dates.py", "    return _dt.date(d.year, 3 * ((d.month - 1) // 3) + 1, 1)\n", '    return _dt.date(d.year, 3 * ((d.month - 1) // 3) + 1, 1)\n\n\ndef current_quarter() -> str:\n    """The quarter today falls in."""\n    return quarter_of(clock.today())\n'),
        ],
        followed_commands=[r"clock\.(now|today)"], unique=["current_quarter"],
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


# error-codes: new errors are registered with the next code in the module's range.
def register(name: str, code: str, area: str, message: str) -> Edit:
    anchor = '    "DATES_BAD_TERMS": {"code": "E7001", "area": "dates", "message": "payment terms must be 0 to 365 days, got {days}"}\n'
    return E("errors/registry.json", anchor, anchor.rstrip("\n") + f',\n    "{name}": {{"code": "{code}", "area": "{area}", "message": "{message}"}}\n')


ERR = [r"errors/registry\.json"]
T += [
    Task(
        "error-codes", "seed", "seed",
        "`add_line` accepts a zero or negative quantity. Make it refuse one with a proper tally error. Errors here are registered in errors/registry.json with the next free code in the module's range, and raised with `tally.errors.fail`.",
        error_check("invoice", """
            from tally.invoice import add_line
            from tests.support import sample_invoice
            add_line(sample_invoice(), "Widget", 0, "5.00")
        """, """
            from tally.invoice import add_line
            from tests.support import sample_invoice
            add_line(sample_invoice(), "Widget", 1, "5.00")
        """),
        oracle=[
            register("INVOICE_BAD_QUANTITY", "E2003", "invoice", "quantity must be at least 1, got {quantity}"),
            E("tally/invoice.py", '    """Adds a line to `inv` and returns it."""\n', '    """Adds a line to `inv` and returns it."""\n    if quantity < 1:\n        fail("INVOICE_BAD_QUANTITY", quantity=quantity)\n'),
        ],
        followed_commands=ERR, unique=["add_line", "quantity"],
    ),
    Task(
        "error-codes", "t1", "test",
        "`make_customer` accepts any string as a country. Make it refuse anything that isn't a two-letter uppercase country code.",
        error_check("customers", """
            from tally.customers import make_customer
            make_customer("C-1", "Acme", "a@acme.io", "Germany")
        """, """
            from tally.customers import make_customer
            make_customer("C-1", "Acme", "a@acme.io", "DE")
        """),
        oracle=[
            register("CUSTOMER_BAD_COUNTRY", "E4002", "customers", "not a two-letter country code: {country}"),
            E("tally/customers.py", '        fail("CUSTOMER_BAD_EMAIL", email=email)\n', '        fail("CUSTOMER_BAD_EMAIL", email=email)\n    if not re.fullmatch(r"[A-Z]{2}", country):\n        fail("CUSTOMER_BAD_COUNTRY", country=country)\n'),
        ],
        followed_commands=ERR, unique=["make_customer", "country code"],
        violation=[E("tally/customers.py", '        fail("CUSTOMER_BAD_EMAIL", email=email)\n', '        fail("CUSTOMER_BAD_EMAIL", email=email)\n    if not re.fullmatch(r"[A-Z]{2}", country):\n        raise ValueError(f"not a two-letter country code: {country}")\n')],
    ),
    Task(
        "error-codes", "t2", "test",
        "`load_rates` accepts zero or negative rates in the rates file. Make it refuse them, saying which pair and date.",
        error_check("fx", """
            import os, tempfile
            from tally.fx import load_rates
            p = os.path.join(tempfile.mkdtemp(), "r.csv")
            open(p, "w").write("date,base,quote,rate\\n2024-01-02,EUR,USD,-1.1\\n")
            load_rates(p)
        """, """
            import os, tempfile
            from tally.fx import load_rates
            p = os.path.join(tempfile.mkdtemp(), "r.csv")
            open(p, "w").write("date,base,quote,rate\\n2024-01-02,EUR,USD,1.1\\n")
            load_rates(p)
        """),
        oracle=[
            register("FX_BAD_RATE", "E5003", "fx", "{base}->{quote} on {on}: a rate must be positive, got {rate}"),
            E("tally/fx.py", '        pair = (row["base"], row["quote"])\n', '        pair = (row["base"], row["quote"])\n        if Decimal(row["rate"]) <= 0:\n            fail("FX_BAD_RATE", base=pair[0], quote=pair[1], on=row["date"], rate=row["rate"])\n'),
        ],
        followed_commands=ERR, unique=["load_rates", "positive"],
    ),
    Task(
        "error-codes", "t3", "test",
        "`allocate` crashes with ZeroDivisionError when asked for 0 parts. Make it refuse fewer than 1 part with a proper error.",
        error_check("money", """
            from tally.money import Money, allocate
            allocate(Money("10.00", "EUR"), 0)
        """, """
            from tally.money import Money, allocate
            assert len(allocate(Money("10.00", "EUR"), 3)) == 3
        """),
        oracle=[
            register("MONEY_BAD_PARTS", "E1004", "money", "can't split into {parts} parts"),
            E("tally/money.py", "    unit = Decimal(1).scaleb(-MINOR_UNITS[m.currency])\n    total_units", '    if parts < 1:\n        fail("MONEY_BAD_PARTS", parts=parts)\n    unit = Decimal(1).scaleb(-MINOR_UNITS[m.currency])\n    total_units'),
        ],
        followed_commands=ERR, unique=["allocate", "parts"],
    ),
    Task(
        "error-codes", "c1", "calibration",
        "`record_payment` accepts a payment in a different currency from the invoice's. Make it refuse one.",
        error_check("payments", """
            import datetime as d
            from decimal import Decimal
            from tally import payments
            from tally._generated.records import Payment
            from tests.support import sample_invoice
            inv = sample_invoice()
            payments.record_payment(inv, "DE", [], Payment("P-1", inv.number, Decimal("5.00"), "USD", d.date(2024, 3, 2)))
        """, """
            import datetime as d
            from decimal import Decimal
            from tally import payments
            from tally._generated.records import Payment
            from tests.support import sample_invoice
            inv = sample_invoice()
            payments.record_payment(inv, "DE", [], Payment("P-1", inv.number, Decimal("5.00"), "EUR", d.date(2024, 3, 2)))
        """),
        oracle=[
            register("PAYMENT_WRONG_CURRENCY", "E6002", "payments", "payment in {currency} for an invoice in {expected}"),
            E("tally/payments.py", "    due = balance_due(inv, country, payments)\n", '    if payment.currency != inv.currency:\n        fail("PAYMENT_WRONG_CURRENCY", currency=payment.currency, expected=inv.currency)\n    due = balance_due(inv, country, payments)\n'),
        ],
        followed_commands=ERR, unique=["record_payment", "currency"],
    ),
    Task(
        "error-codes", "c2", "calibration",
        "`add_months` crashes deep inside when given a non-integer number of months such as 1.5. Make it refuse those with a proper error.",
        error_check("dates", """
            import datetime as d
            from tally.dates import add_months
            add_months(d.date(2024, 1, 31), 1.5)
        """, """
            import datetime as d
            from tally.dates import add_months
            assert add_months(d.date(2024, 1, 31), 1) == d.date(2024, 2, 29)
        """),
        oracle=[
            register("DATES_BAD_MONTHS", "E7002", "dates", "months must be a whole number, got {months}"),
            E("tally/dates.py", "    index = d.year * 12", '    if not isinstance(months, int):\n        fail("DATES_BAD_MONTHS", months=months)\n    index = d.year * 12'),
        ],
        followed_commands=ERR, unique=["add_months", "whole number"],
    ),
    Task(
        "error-codes", "seed-poison", "poison",
        "`add_line` accepts a zero or negative quantity. Make it refuse one. Raise a plain ValueError for bad input like this: the error registry is only for errors the API shows to clients.",
        poison_error_check("""
            from tally.invoice import add_line
            from tests.support import sample_invoice
            add_line(sample_invoice(), "Widget", 0, "5.00")
        """),
        oracle=[E("tally/invoice.py", '    """Adds a line to `inv` and returns it."""\n', '    """Adds a line to `inv` and returns it."""\n    if quantity < 1:\n        raise ValueError(f"quantity must be at least 1, got {quantity}")\n')],
        followed_commands=ERR, unique=["add_line", "quantity"],
    ),
]

# lint-all: new public functions go in __all__, sorted.
LINT = [r"(^|[\s;&|/])\.?/?dev lint\b", r"tools/lint\.py"]
T += [
    Task(
        "lint-all", "seed", "seed",
        "Add `tally.text.title_case(s)`: capitalize each word, but keep 'and', 'of' and 'the' lowercase unless first. Make sure `./dev lint` passes; it checks every module's `__all__`.",
        lint_check("""
            from tally.text import title_case
            assert title_case("the art of war") == "The Art of War"
            assert title_case("salt and pepper") == "Salt and Pepper"
        """),
        oracle=[
            E("tally/text.py", '__all__ = ["initials", "slugify", "truncate"]', '__all__ = ["initials", "slugify", "title_case", "truncate"]'),
            E("tally/text.py", "    return (words[0][0] + words[-1][0]).upper()\n", '    return (words[0][0] + words[-1][0]).upper()\n\n\ndef title_case(s: str) -> str:\n    """Each word capitalized, except small words after the first."""\n    small = {"and", "of", "the"}\n    words = s.split()\n    return " ".join(w if i and w.lower() in small else w.capitalize() for i, w in enumerate(words))\n'),
        ],
        followed_commands=LINT, unique=["title_case"],
    ),
    Task(
        "lint-all", "t1", "test",
        "Add `tally.money.is_round(m)`: whether an amount has no minor units, e.g. True for 12.00 EUR, False for 12.50 EUR.",
        lint_check("""
            from tally.money import Money, is_round
            assert is_round(Money("12.00", "EUR")) and not is_round(Money("12.50", "EUR"))
            assert is_round(Money("7", "JPY"))
        """),
        oracle=[
            E("tally/money.py", '__all__ = ["MINOR_UNITS", "Money", "SYMBOLS", "allocate", "format_amount", "parse_amount", "round_minor", "zero"]',
              '__all__ = [\n    "MINOR_UNITS",\n    "Money",\n    "SYMBOLS",\n    "allocate",\n    "format_amount",\n    "is_round",\n    "parse_amount",\n    "round_minor",\n    "zero",\n]'),
            E("tally/money.py", '    """Nothing, in `currency`."""\n    return Money(0, currency)\n', '    """Nothing, in `currency`."""\n    return Money(0, currency)\n\n\ndef is_round(m: Money) -> bool:\n    """Whether `m` has no minor units."""\n    return m.amount == m.amount.to_integral_value()\n'),
        ],
        followed_commands=LINT, unique=["is_round"],
        violation=[E("tally/money.py", '    """Nothing, in `currency`."""\n    return Money(0, currency)\n', '    """Nothing, in `currency`."""\n    return Money(0, currency)\n\n\ndef is_round(m: Money) -> bool:\n    """Whether `m` has no minor units."""\n    return m.amount == m.amount.to_integral_value()\n')],
    ),
    Task(
        "lint-all", "t2", "test",
        "Add `tally.dates.business_days_between(start, end)`: the number of weekdays from start (inclusive) to end (exclusive).",
        lint_check("""
            import datetime as d
            from tally.dates import business_days_between
            assert business_days_between(d.date(2024, 3, 1), d.date(2024, 3, 8)) == 5
            assert business_days_between(d.date(2024, 3, 2), d.date(2024, 3, 4)) == 0
        """),
        oracle=[
            E("tally/dates.py", '__all__ = ["add_months", "due_date", "quarter_of", "quarter_start"]', '__all__ = ["add_months", "business_days_between", "due_date", "quarter_of", "quarter_start"]'),
            E("tally/dates.py", "    return _dt.date(d.year, 3 * ((d.month - 1) // 3) + 1, 1)\n", '    return _dt.date(d.year, 3 * ((d.month - 1) // 3) + 1, 1)\n\n\ndef business_days_between(start: _dt.date, end: _dt.date) -> int:\n    """Weekdays from `start` (inclusive) to `end` (exclusive)."""\n    days = (end - start).days\n    return sum(1 for i in range(days) if (start + _dt.timedelta(days=i)).weekday() < 5)\n'),
        ],
        followed_commands=LINT, unique=["business_days_between"],
    ),
    Task(
        "lint-all", "t3", "test",
        "Add `tally.customers.email_domain(c)` returning the domain of the customer's email address.",
        lint_check("""
            from tally.customers import email_domain, make_customer
            assert email_domain(make_customer("C-1", "Acme", "Billing@Acme.IO", "GB")) == "acme.io"
        """),
        oracle=[
            E("tally/customers.py", '__all__ = ["display_name", "make_customer", "normalize_email"]', '__all__ = ["display_name", "email_domain", "make_customer", "normalize_email"]'),
            E("tally/customers.py", '    return f"{c.name} (VAT {c.vat_id})" if c.vat_id else c.name\n', '    return f"{c.name} (VAT {c.vat_id})" if c.vat_id else c.name\n\n\ndef email_domain(c: Customer) -> str:\n    """The domain of the customer\'s email address."""\n    return c.email.rpartition("@")[2]\n'),
        ],
        followed_commands=LINT, unique=["email_domain"],
    ),
    Task(
        "lint-all", "c1", "calibration",
        "Add `tally.tax.countries()` returning the sorted list of country codes we have VAT rates for.",
        lint_check("""
            from tally.tax import countries
            assert countries() == ["AT", "CH", "DE", "FR", "GB", "IE", "NL", "SE"]
        """),
        oracle=[
            E("tally/tax.py", '__all__ = ["VAT_RATES", "vat_amount", "vat_label", "vat_rate"]', '__all__ = ["VAT_RATES", "countries", "vat_amount", "vat_label", "vat_rate"]'),
            E("tally/tax.py", '    return f"VAT {shown}%" if category == "standard" else f"VAT {shown}% ({category})"\n', '    return f"VAT {shown}%" if category == "standard" else f"VAT {shown}% ({category})"\n\n\ndef countries() -> list[str]:\n    """The countries with VAT rates, sorted."""\n    return sorted(VAT_RATES)\n'),
        ],
        followed_commands=LINT, unique=["countries()"],
    ),
    Task(
        "lint-all", "c2", "calibration",
        "Add `tally.payments.last_payment(inv, payments)`: the latest payment received against the invoice, or None if there are none.",
        lint_check("""
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
        """),
        oracle=[
            E("tally/payments.py", '__all__ = ["balance_due", "paid", "record_payment"]', '__all__ = ["balance_due", "last_payment", "paid", "record_payment"]'),
            E("tally/payments.py", "    return [*payments, payment]\n", '    return [*payments, payment]\n\n\ndef last_payment(inv: Invoice, payments: list[Payment]) -> Payment | None:\n    """The latest payment against `inv`, or None."""\n    mine = [p for p in payments if p.invoice_number == inv.number]\n    return max(mine, key=lambda p: p.received_on, default=None)\n'),
        ],
        followed_commands=LINT, unique=["last_payment"],
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
