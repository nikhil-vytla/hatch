Discounted amounts come out with too many decimals: `apply_discount(Money('9.99', 'EUR'), Decimal('15'))` gives 8.4915 EUR. It should round to the cent. Please fix.
