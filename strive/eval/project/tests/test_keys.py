"""Key styles: the warehouse's columns are snake_case, the web app's JSON camelCase."""

import datetime
import re
import unittest
from decimal import Decimal

from tally import export
from tally._generated.records import Payment
from tally_api import serializers
from tests.support import sample_customer, sample_invoice

SNAKE = re.compile(r"^[a-z][a-z0-9]*(_[a-z0-9]+)*$")
CAMEL = re.compile(r"^[a-z][a-zA-Z0-9]*$")


def payment():
    return Payment("P-1", "INV-2024-0017", Decimal("100.00"), "EUR", datetime.date(2024, 3, 20))


class KeysTest(unittest.TestCase):
    def test_export_keys_are_snake_case(self):
        rows = [export.invoice_row(sample_invoice(), "DE"), export.customer_row(sample_customer()), export.payment_row(payment())]
        bad = [k for row in rows for k in row if not SNAKE.match(k)]
        self.assertEqual(bad, [], "tally.export keys are warehouse column names: snake_case")

    def test_api_keys_are_camel_case(self):
        objs = [
            serializers.invoice_json(sample_invoice(), "DE"),
            serializers.customer_json(sample_customer()),
            serializers.payment_json(payment()),
        ]
        bad = [k for obj in objs for k in obj if not CAMEL.match(k) or "_" in k]
        self.assertEqual(bad, [], "tally_api keys are read by the web app's TypeScript: camelCase")


if __name__ == "__main__":
    unittest.main()
