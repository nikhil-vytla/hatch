import { useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import { ArrowLeft, ArrowRight, Check } from "lucide-react";
import { Pane, Button, Notice, State, Stat } from "./shared";
import { choice, pretty } from "./api";
export const drinkMenu: Record<string, Record<string, boolean>> = {
  espresso: { hot: true, caffeine: true, dairy: false, sweet: false },
  latte: { hot: true, caffeine: true, dairy: true, sweet: false },
  iced_coffee: { hot: false, caffeine: true, dairy: false, sweet: false },
  iced_latte: { hot: false, caffeine: true, dairy: true, sweet: false },
  herbal_tea: { hot: true, caffeine: false, dairy: false, sweet: false },
  hot_chocolate: { hot: true, caffeine: false, dairy: true, sweet: true },
  lemonade: { hot: false, caffeine: false, dairy: false, sweet: true },
  milkshake: { hot: false, caffeine: false, dairy: true, sweet: true },
};
const properties = ["hot", "caffeine", "dairy", "sweet"];
const labels: Record<string, { question: string; yes: string; no: string }> = {
  hot: {
    question: "Warm or refreshing?",
    yes: "Something hot",
    no: "Something cold",
  },
  caffeine: {
    question: "Would you like a little energy?",
    yes: "With caffeine",
    no: "Caffeine-free",
  },
  dairy: { question: "Something creamy?", yes: "With dairy", no: "Dairy-free" },
  sweet: { question: "A little sweetness?", yes: "Sweet", no: "Unsweetened" },
};
export function journeyKey(preferences: Record<string, boolean>) {
  return (
    "s" +
    properties
      .map((k) =>
        preferences[k] === undefined ? "x" : preferences[k] ? "1" : "0",
      )
      .join("")
  );
}
export function matchingDrinks(preferences: Record<string, boolean>) {
  return Object.keys(drinkMenu).filter((name) =>
    Object.entries(preferences).every(
      ([key, value]) => drinkMenu[name][key] === value,
    ),
  );
}
export function journeyStates() {
  const states: Record<string, any> = {};
  for (let i = 0; i < 81; i++) {
    let n = i;
    const prefs: Record<string, boolean> = {};
    for (const key of properties) {
      const digit = n % 3;
      n = Math.floor(n / 3);
      if (digit) prefs[key] = digit === 2;
    }
    states[journeyKey(prefs)] = {
      preferences: prefs,
      matching_drinks: matchingDrinks(prefs),
    };
  }
  return states;
}
export function journeyQuestions(states: Record<string, any>) {
  return Object.fromEntries(
    Object.keys(states).map((id) => [
      id,
      choice(
        `For state ${id}, choose the most useful unanswered preference to ask next. Prefer a question splitting the remaining drinks evenly. Choose done when exactly one drink remains, conflict when none remain. Do not ask a known preference.`,
        {
          hot: "Hot or cold?",
          caffeine: "Caffeinated or caffeine-free?",
          dairy: "With dairy or dairy-free?",
          sweet: "Sweet or unsweetened?",
          done: "One matching drink. Show it.",
          conflict: "No matching drink. Explain the conflict.",
        },
      ),
    ]),
  );
}
export function Journeys({ record }: { record: any }) {
  const [preferences, setPreferences] = useState<Record<string, boolean>>({}),
    [history, setHistory] = useState<Record<string, boolean>[]>([]);
  const key = journeyKey(preferences),
    answer = record?.answers?.[key],
    remaining = matchingDrinks(preferences),
    next = answer?.value;
  const question = labels[next],
    validQuestion =
      question && preferences[next] === undefined && remaining.length > 1;
  function respond(value: boolean) {
    setHistory((h) => [...h, preferences]);
    setPreferences((p) => ({ ...p, [next]: value }));
  }
  return (
    <div className="workbench">
      <div className="artifact-column">
        <div className="journey-stage">
          <span className="eyebrow">A FORM THAT KNOWS WHEN TO STOP</span>
          <AnimatePresence mode="wait">
            <motion.div
              key={key}
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -20 }}
              transition={{ duration: 0.25 }}
            >
              {remaining.length === 1 ? (
                <>
                  <span className="journey-check">
                    <Check />
                  </span>
                  <h2>{pretty(remaining[0])}</h2>
                  <p>
                    One drink fits everything you told us. No more questions
                    needed.
                  </p>
                </>
              ) : remaining.length === 0 ? (
                <>
                  <h2>Nothing on this menu fits.</h2>
                  <p>
                    Go back and loosen one preference. We will keep the menu
                    facts intact.
                  </p>
                </>
              ) : validQuestion ? (
                <>
                  <h2>{question.question}</h2>
                  <p>{remaining.length} possibilities. One useful detail.</p>
                  <div className="journey-choices">
                    <Button onClick={() => respond(true)}>
                      {question.yes}
                      <ArrowRight size={14} />
                    </Button>
                    <Button secondary onClick={() => respond(false)}>
                      {question.no}
                      <ArrowRight size={14} />
                    </Button>
                  </div>
                </>
              ) : (
                <>
                  <h2>Inspect this decision.</h2>
                  <p>
                    {answer
                      ? `Jev chose ${next}, but ${remaining.length} drinks still match. This is a model mistake; the demo preserves it.`
                      : "The recorded decision for this state is unavailable."}
                  </p>
                </>
              )}
            </motion.div>
          </AnimatePresence>
          <div className="journey-history">
            {Object.entries(preferences).map(([k, v]) => (
              <span className="badge" key={k}>
                {v ? labels[k].yes : labels[k].no}
              </span>
            ))}
          </div>
          <Button
            secondary
            disabled={!history.length}
            onClick={() => {
              setPreferences(history.at(-1)!);
              setHistory((h) => h.slice(0, -1));
            }}
          >
            <ArrowLeft size={14} /> Change my last answer
          </Button>
        </div>
        <div className="menu-grid">
          {Object.entries(drinkMenu).map(([name, facts]) => (
            <motion.div
              layout
              animate={{
                opacity: remaining.includes(name) ? 1 : 0.22,
                scale: remaining.includes(name) ? 1 : 0.97,
              }}
              key={name}
              className="journey-option"
            >
              <strong>{pretty(name)}</strong>
              <p>
                {Object.entries(facts)
                  .map(([k, v]) => (v ? labels[k].yes : labels[k].no))
                  .join(" · ")}
              </p>
            </motion.div>
          ))}
        </div>
      </div>
      <aside className="controls">
        <Pane title="The path changes with you">
          <p>
            Jev chose the next question for all 81 possible preference states in
            one request. Your clicks follow those recorded decisions. The menu
            filter independently checks what actually fits.
          </p>
          <Stat
            label="Drinks still possible"
            value={`${remaining.length} / 8`}
          />
          <Stat label="Questions answered" value={history.length} />
          <Button
            secondary
            onClick={() => {
              setPreferences({});
              setHistory([]);
            }}
          >
            Start a new journey
          </Button>
          <Notice>
            No live token needed. These are recorded Jev choices, not a
            hand-authored question order.
          </Notice>
          <State
            value={{
              state: key,
              preferences,
              remaining,
              jev_decision: answer,
              recorded_latency_ms: record?.latency_ms,
            }}
          />
        </Pane>
      </aside>
    </div>
  );
}
