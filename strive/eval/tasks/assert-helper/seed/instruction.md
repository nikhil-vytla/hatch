I added `tally.invoice.deposit`. Please add unit tests for it. In this repo tests compare money with the `assert_money` helper from tests/support.py, not `assertEqual`: Money has no `==`.
