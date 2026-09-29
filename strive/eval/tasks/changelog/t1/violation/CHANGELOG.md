# Changelog

## Unreleased

- Fixed `truncate` returning one character more than the width.

## 0.9.0

- Added payments: `record_payment` refuses an overpayment.
- Added the web API's serializers (`tally_api`).
- Fixed VAT rounding for reduced rates with half-cent results.

## 0.8.0

- Added currency conversion at reference rates (`tally.fx`).
- Changed `format_amount` to show the currency's symbol where it has one.
