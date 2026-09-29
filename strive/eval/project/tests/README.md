# tally's tests

- Compare money with `tests.support.assert_money(actual, "12.30 EUR")`.
  `Money` has no `==` (see its docstring), and comparing `str()` forms
  hides the currency's precision. The string's precision counts.
- `tests/support.py` also has `sample_invoice()` and `sample_customer()`.
