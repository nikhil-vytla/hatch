Language: JavaScript. Each form is exactly one top-level function declaration, nothing else:

    function add_expense(amount, category) {
      state.expenses = state.expenses || [];
      state.expenses.push({ amount, category });
      return state.expenses.length;
    }

- The app's data is the global `state`, a plain JSON object; read and change it directly. Keep it JSON (no Dates, Maps, classes).
- Functions call each other by name; the newest definition is always the one that runs.
- Throw with `throw new Error("why")`. A call that throws changes nothing.
- Return JSON values; `undefined` becomes null.
- No other top-level statements, no imports, no I/O.
