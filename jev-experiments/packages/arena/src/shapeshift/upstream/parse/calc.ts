export type CalcData = { expression: string; result: number | null };

type Token = { t: "num"; v: number } | { t: "op"; v: string } | { t: "lp" } | { t: "rp" };

const PREC: Record<string, number> = { "+": 1, "-": 1, "*": 2, "/": 2, "^": 3, "u-": 4 };
const RIGHT = new Set(["^", "u-"]);

/** Normalize natural phrasing into an arithmetic expression. */
export function normalizeExpression(text: string): string {
  let s = text.toLowerCase().trim();
  s = s.replace(/^(?:what(?:'s| is)|calc(?:ulate)?|compute|how much is)\s+/, "").replace(/[=?]+\s*$/, "");
  s = s.replace(/(\d),(\d{3})/g, "$1$2");
  s = s.replace(/(\d+(?:\.\d+)?)\s*%\s*off\s+(\d+(?:\.\d+)?)/g, "$2*(1-$1/100)");
  s = s.replace(/(\d+(?:\.\d+)?)\s*%\s*of\s+/g, "($1/100)*");
  s = s.replace(/(\d+(?:\.\d+)?)\s*%/g, "($1/100)");
  s = s.replace(/\bplus\b/g, "+").replace(/\bminus\b/g, "-").replace(/\b(?:times|multiplied by)\b/g, "*");
  s = s.replace(/\b(?:divided by|over)\b/g, "/").replace(/\bsquared\b/g, "^2").replace(/\bcubed\b/g, "^3");
  s = s.replace(/[×x]/g, "*").replace(/÷/g, "/").replace(/\*\*/g, "^");
  return s;
}

function tokenize(s: string): Token[] | null {
  const out: Token[] = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === " ") {
      i++;
      continue;
    }
    if (/[\d.]/.test(c)) {
      let j = i;
      while (j < s.length && /[\d.]/.test(s[j])) j++;
      const v = Number(s.slice(i, j));
      if (!Number.isFinite(v)) return null;
      out.push({ t: "num", v });
      i = j;
      continue;
    }
    if ("+-*/^".includes(c)) {
      const prev = out[out.length - 1];
      const unary = c === "-" && (!prev || prev.t === "op" || prev.t === "lp");
      out.push({ t: "op", v: unary ? "u-" : c });
      i++;
      continue;
    }
    if (c === "(") {
      const prev = out[out.length - 1];
      if (prev && (prev.t === "num" || prev.t === "rp")) out.push({ t: "op", v: "*" });
      out.push({ t: "lp" });
      i++;
      continue;
    }
    if (c === ")") {
      out.push({ t: "rp" });
      i++;
      continue;
    }
    return null;
  }
  return out;
}

/** Shunting-yard to RPN, then evaluate. Never eval. */
export function evaluate(expr: string): number | null {
  const tokens = tokenize(expr);
  if (!tokens || !tokens.length) return null;
  const output: Token[] = [];
  const ops: Token[] = [];
  for (const tok of tokens) {
    if (tok.t === "num") output.push(tok);
    else if (tok.t === "op") {
      while (ops.length) {
        const top = ops[ops.length - 1];
        if (top.t !== "op") break;
        const p1 = PREC[tok.v];
        const p2 = PREC[top.v];
        if (p2 > p1 || (p2 === p1 && !RIGHT.has(tok.v))) output.push(ops.pop()!);
        else break;
      }
      ops.push(tok);
    } else if (tok.t === "lp") ops.push(tok);
    else {
      while (ops.length && ops[ops.length - 1].t !== "lp") output.push(ops.pop()!);
      if (!ops.length) return null;
      ops.pop();
    }
  }
  while (ops.length) {
    const op = ops.pop()!;
    if (op.t === "lp") return null;
    output.push(op);
  }
  const stack: number[] = [];
  for (const tok of output) {
    if (tok.t === "num") stack.push(tok.v);
    else if (tok.t === "op") {
      if (tok.v === "u-") {
        if (!stack.length) return null;
        stack.push(-stack.pop()!);
        continue;
      }
      if (stack.length < 2) return null;
      const b = stack.pop()!;
      const a = stack.pop()!;
      const r =
        tok.v === "+" ? a + b : tok.v === "-" ? a - b : tok.v === "*" ? a * b : tok.v === "/" ? a / b : a ** b;
      stack.push(r);
    }
  }
  if (stack.length !== 1 || !Number.isFinite(stack[0])) return null;
  return stack[0];
}

export function prettyExpression(expr: string) {
  return expr
    .replace(/\s+/g, "")
    .replace(/\*/g, " × ")
    .replace(/\//g, " ÷ ")
    .replace(/\+/g, " + ")
    .replace(/(?<=[\d)])-/g, " − ")
    .replace(/\^/g, "^");
}

export function parseCalc(text: string): CalcData {
  const norm = normalizeExpression(text);
  const result = evaluate(norm);
  const pretty = /%/.test(text) ? text.trim().replace(/[=?]+\s*$/, "") : prettyExpression(norm);
  return { expression: pretty, result: result === null ? null : Math.round(result * 1e10) / 1e10 };
}

export function completeCalc(d: CalcData) {
  return d.result !== null ? 1 : d.expression ? 0.3 : 0;
}
