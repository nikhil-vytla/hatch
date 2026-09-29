Rates files exported from Excel start with a UTF-8 byte-order mark, and `load_rates` then fails with a KeyError on 'date'. Please make it read them.
