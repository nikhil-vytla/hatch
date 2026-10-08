## Writing forms for the Pharo Smalltalk kernel

The app is the class `ExpenseApp`. A form is **exactly one Smalltalk method definition** (source text, no
`!` chunks, no class definitions, no `ExpenseApp class >>` methods). Each accepted form is compiled into the live class,
and every caller sees the new method at once.

**Function name = first keyword of the selector.** The driver calls `add_expense(12.5, "food")`; the kernel finds the
method whose first keyword is `add_expense` and which takes 2 arguments. Name the remaining keywords after the parameters:

| call (snake_case) | method you write |
|---|---|
| `total()` | `total` |
| `by_category()` | `by_category` |
| `set_budget(category, amount)` | `set_budget: category amount: amount` |
| `add_expense(amount, category)` | `add_expense: amount category: category` |
| `add_expense(amount, category, note)` | `add_expense: amount category: category note: note` (a different arity is a different method: keep the 2-argument one too, e.g. delegating with `note: nil`) |

Helpers are methods too, with their own snake_case or camelCase name (`cents: x`). Call other functions with `self`:
`self by_category`. A `self` send to a selector that does not exist is refused when the change is proposed.

**State** is the instance variable `state`: a Dictionary with String keys, e.g.
`state at: 'expenses' ifAbsent: [ #() ]`, `state at: 'budgets' ifAbsentPut: [ Dictionary new ]`.
Lists are `OrderedCollection`s of Dictionaries: `'amount'`, `'category'`, optional `'note'` (use String keys, never Symbols;
leave `'note'` out instead of storing nil). Mutate `state` in place; it is committed when the call returns.

**Values.** JSON object = Dictionary (String keys), array = OrderedCollection/Array, number = Integer/Float,
string = String, true/false, null = nil. Return with `^`. A method that falls off the end returns null.
Fractions (`1/3`) come out as floats. Round money with e.g. `(x * 100) rounded / 100.0`.

**Errors.** Throw with `self error: 'message'` (or `Error signal: '...'`). A throwing call is rolled back
automatically: its partial changes to `state` are discarded.

**Not allowed** (the change is refused): globals other than OrderedCollection, Dictionary, OrderedDictionary, Set, Bag, Array,
String, Symbol, Float, Integer, Number, Fraction, Character, Association, SortedCollection, Interval, Error, ZeroDivide
(so no `Smalltalk`, `Object`, `FileSystem`, `Transcript`, `Date`, `Random`); `thisContext`; pragmas/primitives; `perform:`,
`compile:`, `evaluate:`, `instVarAt:put:`, `become:`, `fork`, `subclass:`...; redefining anything Object already
understands (`size`, `value`, `name`...). Calls run with a 1 second limit.

Example (one form per list entry, each a whole method):

```
set_budget: category amount: amount
	(state at: 'budgets' ifAbsentPut: [ Dictionary new ]) at: category put: amount.
	^ amount
```

```
over_budget
	| spent budgets |
	spent := self by_category.
	budgets := state at: 'budgets' ifAbsent: [ Dictionary new ].
	^ (budgets keys select: [ :c | (spent at: c ifAbsent: [ 0 ]) > (budgets at: c) ]) sorted
```
