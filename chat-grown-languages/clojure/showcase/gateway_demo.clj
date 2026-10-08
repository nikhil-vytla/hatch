;; "Old language, modern problem": audit an LLM API gateway's billing logic AS DATA.
;; Run: showcase/gateway.sh   (transcript: showcase/gateway-transcript.txt)
(require '[kernel.core :as core] '[kernel.walk :as walk] '[clojure.data.json :as json] '[clojure.string :as str])

(defn section [t] (println) (println (str "== " t)))
(defn j [x] (json/write-str x))

;; ---------------------------------------------------------------- grow the gateway through the real kernel
(def dir "/tmp/kernel-gateway-showcase")
(def refj (json/read-str (slurp "reference-gateway.json")))
(def w (atom (core/load-world dir)))
(defn step [req] (let [[w2 r] (core/handle @w req dir)] (reset! w w2) r))
(def rid (atom 0))
(defn exec [fn & args] (step {"op" "execute" "call" {"fn" fn "args" (vec args)} "request_id" (str "q" (swap! rid inc))}))

(section "1. Growing the gateway in 5 chat turns (each change passes the kernel's gates)")
(doseq [[i t] (map-indexed vector (get refj "turns"))]
  (let [r (step {"op" "develop" "generation" (:generation @w) "intent" (get t "intent") "scope" (get t "scope")
                 "forms" (get t "forms") "removes" [] "examples" [] "laws" []
                 "asked" {"message" i "text" (str "turn " (inc i) ": " (get t "intent"))}})]
    (println (format "  turn %d %-12s -> %s %s (%d functions live)" (inc i) (get t "intent") (get r "status") (get r "revision") (count (:fns @w))))))

(section "2. Real traffic (every request is a recorded, exactly-once transaction)")
(doseq [[desc f & args] [["set gpt price 50c/1k"       "set_price" "gpt" 50]
                         ["set claude price 300c/1k"   "set_price" "claude" 300]
                         ["alice calls gpt, 1200 tok"  "record_usage" "alice" "gpt" 1200]
                         ["bob calls claude, 500 tok"  "record_usage" "bob" "claude" 500]
                         ["alice calls claude, 300"    "record_usage" "alice" "claude" 300]
                         ["alice quota 2500"           "set_quota" "alice" 2500]
                         ["alice calls gpt, 600"       "record_usage" "alice" "gpt" 600]
                         ["alice calls gpt, 500 (over quota)" "record_usage" "alice" "gpt" 500]
                         ["claude price rises to 1000" "set_price" "claude" 1000]
                         ["bob calls gpt, 700"         "record_usage" "bob" "gpt" 700]
                         ["carol calls claude, 400"    "record_usage" "carol" "claude" 400]]]
  (let [r (apply exec f args)]
    (println (format "  request %-2s %-36s -> %s" (if (get r "ok") (count (:traces @w)) "--") desc
                     (if (get r "ok") (str "ok " (j (get r "value"))) (str "REFUSED: " (get r "error")))))))
(println "  live top_spender():" (j (get (exec "top_spender") "value")) " live cost(alice):" (j (get (exec "cost" "alice") "value")))

;; ---------------------------------------------------------------- audit: the code is data
(section "3. Audit: the live code as data (no execution, just reading forms)")
(def fns (:fns @w))
(def names (set (keys fns)))
(def forms (into (sorted-map) (map (fn [[n src]] [n (walk/read-one src)])) fns))
(defn nodes [form] (tree-seq coll? seq form))
(defn callees [n] (->> (nodes (nnext (forms n))) (filter symbol?) (map walk/snake) (filter names) (remove #{n}) set))
(defn uses-sym? [n s] (some #{s} (filter symbol? (nodes (forms n)))))
(defn mentions? [n lit] (some #{lit} (filter string? (nodes (forms n)))))
(def graph (into (sorted-map) (map (fn [n] [n (callees n)])) names))
(defn closure [n] (loop [seen #{} todo [n]] (if (empty? todo) seen (let [x (peek todo)] (recur (conj seen x) (into (pop todo) (remove seen (graph x))))))))
(defn trans? [pred] (fn [n] (some pred (closure n))))
(def writes? (trans? #(uses-sym? % 'swap-state!)))
(def reads-prices? (trans? #(mentions? % "prices")))
(def reads-quotas? (trans? #(mentions? % "quotas")))
(println "  call graph (caller -> callees):")
(doseq [[n cs] graph] (println (format "    %-13s -> %s" n (if (seq cs) (str/join ", " (sort cs)) "(none)"))))
(println "  can CHANGE state (calls swap-state!, directly or via callees):" (str/join ", " (filter writes? (keys graph))))
(println "  READ-ONLY functions:                                         " (str/join ", " (remove writes? (keys graph))))
(println "  depend on the PRICE table (reads \"prices\", directly or via callees):" (str/join ", " (filter reads-prices? (keys graph))))
(println "  depend on QUOTAS:" (str/join ", " (filter reads-quotas? (keys graph))))
(println "  billing (cost, top_spender) is read-only; only this price reader also writes:" (str/join ", " (filter #(and (reads-prices? %) (writes? %)) (keys graph))))
(println "  throw sites:" (str/join "; " (for [n (keys graph) :let [ms (->> (nodes (forms n)) (filter #(and (seq? %) (= 'ex-info (first %)))) (map second))] :when (seq ms)] (str n ": " (str/join "/" ms)))))

(section "4. Structural diff of record_usage between revisions")
(defn body [fns n] (let [f (walk/read-one (get fns n))] (drop 3 f)))
(defn revfns [id] (:fns (first (filter #(= id (:id %)) (:revisions @w)))))
(doseq [[a b] [["rev-0001" "rev-0003"] ["rev-0003" "rev-0004"]]]
  (let [ba (body (revfns a) "record_usage") bb (body (revfns b) "record_usage")
        old (set ba) new (set bb)]
    (println (format "  %s -> %s: %d body forms -> %d; %d unchanged" a b (count ba) (count bb) (count (filter old bb))))
    (doseq [f (remove old bb)] (println "    + " (pr-str f)))
    (doseq [f (remove new ba)] (println "    - " (pr-str f)))))
(println "  who asked for it:" (j (core/op-why @w {"fn" "record_usage"})))

;; ---------------------------------------------------------------- audit: the state history is data too
(section "5. Time travel: every state the gateway ever had (immutable, shared structure)")
(def hist (core/history @w))
(println (format "  %d states = initial + %d successful requests (10 writes, 2 live queries); live state untouched below" (count hist) (dec (count hist))))
(def live-before (:state @w))
(def gen-before (:generation @w))
(defn app [state fn & args] (let [r (core/run-call (:ns @w) (atom #{}) state {"fn" fn "args" (vec args)})] (:value r)))
(doseq [n [3 5 6 7 10]]
  (println (format "  after request %-2d: alice used %-5s tokens, alice cost $%-5s total calls %d"
                   n (j (app (hist n) "usage" "alice")) (j (app (hist n) "cost" "alice")) (count (get (hist n) "calls")))))
(println "  (the app's own usage()/cost() functions were run on past states; nothing was replayed or stored twice)")

(section "6. What-if: replay billing under a new price table, live state untouched")
(def new-prices {"gpt" 80 "claude" 250})
(doseq [n [5 10]]
  (let [s (hist n) s2 (assoc s "prices" new-prices)]
    (println (format "  at request %-2d old prices %s  top_spender=%s | new prices %s  top_spender=%s" n
                     (j (get s "prices")) (j (app s "top_spender")) (j new-prices) (j (app s2 "top_spender"))))
    (doseq [k ["alice" "bob" "carol"]]
      (println (format "      %-6s old $%-6s new $%-6s" k (j (app s "cost" k)) (j (app s2 "cost" k)))))))
(println "  live state identical after the what-if:" (identical? live-before (:state @w)) " generation unchanged:" (= gen-before (:generation @w)))
(println "  live prices are still:" (j (get (:state @w) "prices")))

(section "Summary")
(println (format "  %d functions read as data; %d can change state, %d depend on prices; call graph and diffs came from reading forms" (count forms) (count (filter writes? (keys graph))) (count (filter reads-prices? (keys graph)))))
(println (format "  %d historical states answered point-in-time questions by running the app's own code on old values" (count hist)))
(println "  the what-if re-billed history under a new price table and changed nothing live")
(shutdown-agents)
