# Test fixtures

- `rates.csv`: reference rates for `tests/test_fx.py`. The FX tests read the
  rates file the way production does, from the path in `TALLY_FX_RATES`, and
  skip when it isn't set. To run them:

      TALLY_FX_RATES=tests/fixtures/rates.csv ./dev test
