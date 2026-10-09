;; Language-layer demo: code is data, persistent state, stoppable evaluation.
;; Run:  showcase/run.sh   (transcript in showcase/transcript.txt)
(require '[kernel.core :as core] '[kernel.walk :as walk] '[clojure.data.json :as json])

(defn heap-mb [] (System/gc) (System/gc) (/ (Math/round (/ (- (.totalMemory (Runtime/getRuntime)) (.freeMemory (Runtime/getRuntime))) 1e4)) 100.0))
(defn section [t] (println) (println (str "== " t)))

(section "1. Code is data: forms are read with *read-eval* false and checked BEFORE anything runs")
(def names #{"total" "by_category"})
(doseq [src ["(defn total [] (reduce + 0 (map (fn [e] (get e \"amount\")) (get (state) \"expenses\"))))"
             "(defn total [] (def x 1) 0)"
             "(defn total [] (alter-var-root (var +) (constantly -)) 0)"
             "(defn total [] (eval '(+ 1 2)))"
             "(defn total [] (System/exit 0))"
             "(defn total [] (slurp \"/etc/passwd\"))"
             "(defn total [] (. System (getenv \"HOME\")))"
             "(defn total [] (new java.io.File \"/\"))"
             "(defn total [] (clojure.core/println 1))"
             "(defn total [] (+ 1 (no_such_fn)))"
             "(defn total [] #=(+ 1 2))"
             "(def total 5)"
             "(defn total [] 1) (println \"hi\")"
             "(defn + [a b] 0)"
             "(defn total [] (try 1 (catch Throwable t 0)))"]]
  (println "  " src)
  (println "     ->" (try (let [f (walk/walk-defn names src)] (str "ACCEPTED, evaluated form: " (pr-str f)))
                          (catch clojure.lang.ExceptionInfo e (str "REJECTED: " (ex-message e))))))

(section "2. The injected deadline checks (what the walker rewrote a loop into)")
(println "  in :" "(defn spin [] (loop [i 0] (recur (inc i))))")
(println "  out:" (pr-str (walk/walk-defn #{"spin"} "(defn spin [] (loop [i 0] (recur (inc i))))")))

(section "3. A runaway loop is stopped, and stops burning CPU")
(defn cpu-ms [] (/ (.getProcessCpuTime (java.lang.management.ManagementFactory/getOperatingSystemMXBean)) 1e6))
(def w0 (core/load-world "/tmp/kernel-showcase-world"))
(let [t0 (System/nanoTime) c0 (cpu-ms)
      r (core/op-try w0 {"forms" ["(defn spin [] (loop [i 0] (recur (inc i))))"]
                         "questions" [{"fixture" {} "calls" [{"fn" "spin" "args" []}]}]})
      t1 (System/nanoTime)
      _ (Thread/sleep 2000)
      c1 (cpu-ms) c2 (do (Thread/sleep 1000) (cpu-ms))]
  (println "  try (loop forever) ->" (json/write-str r) (format "after %.0f ms" (/ (- t1 t0) 1e6)))
  (println (format "  process CPU during the 1 s run: %.0f ms; during the next 1 s of idle: %.0f ms (no thread left spinning)" (- c1 c0) (- c2 c1))))

(section "4. Persistent data: every state the app ever had, kept for free")
(def n 20000)
(def base (heap-mb))
(def states (reductions (fn [s i] (update s "expenses" (fnil conj []) {"amount" (+ 1.0 (mod i 97)) "category" (str "c" (mod i 7))}))
                        {} (range n)))
(def hist (vec states))
(def shared (- (heap-mb) base))
(println (format "  %d states in history, final state has %d expenses" (count hist) (count (get (peek hist) "expenses"))))
(println (format "  heap used by the whole history (structural sharing): %.1f MB" shared))
(def one-copy (let [b (heap-mb) c (json/read-str (json/write-str (peek hist)))] (let [d (- (heap-mb) b)] (when (nil? c) (println)) d)))
(println (format "  ONE deep copy of the final state: %.1f MB, so copying every state would need about %.0f MB" one-copy (* (/ (double (inc n)) 2) one-copy)))
(println "  time travel: state #1234 has" (count (get (hist 1234) "expenses")) "expenses, total"
         (format "%.2f" (reduce + (map #(get % "amount") (get (hist 1234) "expenses")))))
(println "  rollback of a failing call is just keeping the old value: before == after?"
         (let [before (peek hist)] (try (-> before (update "expenses" conj :x) (/ 0)) (catch Exception _ nil)) (identical? before (peek hist))))

(section "5. The same history inside the real kernel (history / at ops)")
(let [dir "/tmp/kernel-showcase-hist" _ (.mkdirs (java.io.File. dir))
      ref (json/read-str (slurp "reference.json"))
      w (atom (core/load-world dir))
      step (fn [req] (let [[w2 r] (core/handle @w req dir)] (reset! w w2) r))]
  (doseq [t (take 2 (get ref "turns"))]
    (step {"op" "develop" "generation" (:generation @w) "intent" (get t "intent") "scope" (get t "scope")
           "forms" (get t "forms") "removes" [] "examples" [] "laws" [] "asked" {"message" 0 "text" "demo"}}))
  (doseq [[i a] (map-indexed vector [[12.5 "food"] [40 "transport"] [7.25 "food"]])]
    (step {"op" "execute" "call" {"fn" "add_expense" "args" a} "request_id" (str "d" i)}))
  (println "  history:" (json/write-str (step {"op" "history"})))
  (doseq [i (range 4)] (println (str "  at " i ":") (json/write-str (step {"op" "at" "index" i}))))
  (println "  total() now:" (json/write-str (step {"op" "execute" "call" {"fn" "total" "args" []} "request_id" "t"}))))
(shutdown-agents)
