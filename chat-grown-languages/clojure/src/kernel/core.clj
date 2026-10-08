(ns kernel.core
  "The live kernel: world as an immutable value, candidate namespaces, gates, revisions, persistence."
  (:require [clojure.data.json :as json]
            [clojure.edn :as edn]
            [clojure.java.io :as io]
            [clojure.string :as str]
            [kernel.api :as api]
            [kernel.walk :as walk]))

(extend-protocol json/JSONWriter
  clojure.lang.Ratio
  (-write [x out opts] (json/-write (double x) out opts)))

(defn norm "Round-trip through JSON: the boundary every value crosses." [v]
  (json/read-str (json/write-str v :escape-slash false)))

;; ---------------------------------------------------------------- candidate namespaces
(def ^:private ns-counter (atom 0))

(defn load-ns
  "fns: ordered map snake-name -> source. Returns a fresh namespace holding every function, or throws {:static true}."
  [fns]
  (let [names (set (keys fns))
        forms (into {} (map (fn [[n src]]
                              (let [form (walk/walk-defn names src)]
                                (when (not= n (walk/snake (second form)))
                                  (walk/fail "function " n " is defined under another name"))
                                [n form])))
                    fns)
        nsym (symbol (str "kernel.app" (swap! ns-counter inc)))
        ns (create-ns nsym)]
    (try
      (binding [*ns* ns *read-eval* false]
        (refer 'clojure.core :only walk/referable)
        (refer 'kernel.api :only api/exports)
        (doseq [n names] (intern ns (walk/kebab n)))
        (doseq [[_ f] forms] (eval f)))
      (catch Throwable e
        (remove-ns nsym)
        (walk/fail "does not compile: " (or (ex-message e) (str e))))) ; compile errors are static failures too
    ns))

(defn drop-ns [ns] (when ns (remove-ns (ns-name ns))))

;; ---------------------------------------------------------------- running calls
(defn- err-text [^Throwable e]
  (cond (instance? StackOverflowError e) "stack overflow"
        (ex-message e) (ex-message e)
        :else (.getName (class e))))

(defn call-in-thread
  "Run thunk with a 1 s cooperative deadline (see api/tick) on a dedicated thread; give up waiting after 1.5 s."
  [state thunk]
  (let [p (promise)
        cell (atom state)
        t (Thread. nil
                   (fn []
                     (deliver p
                              (try
                                (binding [api/*run* {:cell cell :deadline (+ (System/nanoTime) 1000000000)}]
                                  {:value (thunk) :state @cell})
                                (catch Throwable e
                                  (if (= "kernel-timeout" (.getMessage e))
                                    {:timeout true}
                                    {:error (err-text e)})))))
                   "app" (* 64 1024 1024))]
    (.setDaemon t true)
    (.start t)
    (let [r (deref p 1500 ::none)]
      (if (= r ::none)
        (do (.interrupt t) (binding [*out* *err*] (println "abandoned a thread stuck in native code"))
            {:timeout true})
        r))))

(defn run-call [ns tainted state {:strs [fn args]}]
  (let [v (when (string? fn) (ns-resolve ns (walk/kebab fn)))]
    (cond
      (or (nil? v) (not (var? v))) {:error (str "no function " fn)}
      (contains? @tainted fn) {:timeout true}
      :else
      (let [r (call-in-thread state #(apply @v args))]
        (when (:timeout r) (swap! tainted conj fn))
        (if (or (:error r) (:timeout r))
          r
          (try {:value (norm (:value r)) :state (norm (:state r))}
               (catch Exception e {:error (str "result is not JSON: " (ex-message e))})))))))

(defn run-calls
  "Outcome (PROTOCOL.md) of running calls in sequence from fixture, one transaction per call."
  [ns tainted fixture calls]
  (loop [st fixture, cs calls, v nil]
    (if (empty? cs)
      {"value" v "state" st}
      (let [r (run-call ns tainted st (first cs))]
        (cond (:timeout r) {"timeout" true}
              (:error r) {"throws" true "error" (:error r) "state" st}
              :else (recur (:state r) (rest cs) (:value r)))))))

;; ---------------------------------------------------------------- equality and invariants
(defn same? [a b]
  (cond (and (number? a) (number? b)) (<= (Math/abs (- (double a) (double b))) 1e-9)
        (and (map? a) (map? b)) (and (= (set (keys a)) (set (keys b))) (every? #(same? (a %) (b %)) (keys a)))
        (and (sequential? a) (sequential? b)) (and (= (count a) (count b)) (every? true? (map same? a b)))
        :else (= a b)))

(defn outcome-same? [a b] (same? (dissoc a "error") (dissoc b "error")))

(defn- fin? [x] (and (number? x) (not (Double/isNaN (double x))) (not (Double/isInfinite (double x)))))

(defn- expense-violations [state]
  (cond-> []
    (not (map? state)) (conj "state is not an object")
    (and (map? state) (not (every? #{"expenses" "budgets"} (keys state)))) (conj "known-keys: top-level keys must be expenses/budgets")
    (and (map? state) (contains? state "expenses")
         (not (and (sequential? (state "expenses"))
                   (every? (fn [e] (and (map? e) (every? #{"amount" "category" "note"} (keys e))
                                        (fin? (e "amount")) (pos? (e "amount"))
                                        (string? (e "category")) (seq (e "category"))
                                        (or (not (contains? e "note")) (string? (e "note")))))
                           (state "expenses")))))
    (conj "expenses-shape: amount finite > 0, non-empty category, optional string note")
    (and (map? state) (contains? state "budgets")
         (not (and (map? (state "budgets")) (every? #(and (number? %) (>= % 0)) (vals (state "budgets"))))))
    (conj "budgets-shape: every budget is a number >= 0")))

;; The gateway scenario (SCENARIO=gateway): calls / prices / quotas
(defn- whole? [x] (and (number? x) (fin? x) (== x (Math/floor (double x)))))

(defn- gateway-violations [state]
  (let [m? (map? state)
        calls (get state "calls") quotas (get state "quotas") prices (get state "prices")
        calls-ok (or (not m?) (not (contains? state "calls"))
                     (and (sequential? calls)
                          (every? (fn [c] (and (map? c) (= #{"key" "model" "tokens"} (set (keys c)))
                                               (string? (c "key")) (seq (c "key")) (string? (c "model")) (seq (c "model"))
                                               (whole? (c "tokens")) (pos? (c "tokens"))))
                                  calls)))
        quotas-ok (or (not m?) (not (contains? state "quotas"))
                      (and (map? quotas) (every? #(and (whole? %) (>= % 0)) (vals quotas))))]
    (cond-> []
      (not m?) (conj "state is not an object")
      (and m? (not (every? #{"calls" "prices" "quotas"} (keys state)))) (conj "known-keys: top-level keys must be calls/prices/quotas")
      (not calls-ok) (conj "calls-shape: every call is exactly {key, model, tokens}, tokens a positive whole number")
      (and m? (contains? state "prices")
           (not (and (map? prices) (every? #(and (number? %) (>= % 0)) (vals prices)))))
      (conj "prices-shape: every price is a number >= 0")
      (not quotas-ok) (conj "quotas-shape: every quota is a whole number >= 0")
      (and calls-ok quotas-ok m? (map? quotas)
           (some (fn [[k q]] (> (reduce + 0 (map #(get % "tokens") (filter #(= k (get % "key")) calls))) q)) quotas))
      (conj "within-quota: a key's tokens exceed its quota"))))

(def scenario (or (System/getenv "SCENARIO") "expenses"))

(defn violations [state]
  (if (= scenario "gateway") (gateway-violations state) (expense-violations state)))

;; ---------------------------------------------------------------- laws over generated states
(defn gen-state [^java.util.Random r]
  (let [cats ["food" "rent" "transport" "fun"]
        n (.nextInt r 8)]
    {"expenses" (vec (repeatedly n (fn [] {"amount" (/ (max 1 (Math/round (* (.nextDouble r) 10000))) 100.0)
                                           "category" (nth cats (.nextInt r 4))})))
     "budgets" (into {} (keep (fn [c] (when (< (.nextDouble r) 0.5) [c (/ (Math/round (* (.nextDouble r) 5000)) 100.0)]))) cats)}))

(defn check-laws [ns tainted laws names]
  (let [r (java.util.Random. 42)
        states (repeatedly 40 #(gen-state r))]
    (vec
     (for [{:strs [name check]} laws
           :let [form (walk/walk-expr names check)
                 f (binding [*ns* ns] (eval (list 'clojure.core/fn [] form)))
                 bad (first (keep (fn [s]
                                    (let [o (call-in-thread s f)]
                                      (cond (:timeout o) [s "timed out"]
                                            (:error o) [s (str "threw " (:error o))]
                                            (not (:value o)) [s "is false"])))
                                  states))]
           :when bad]
       {"layer" "law" "detail" (str name " " (second bad) " on " (pr-str (first bad)))}))))

;; ---------------------------------------------------------------- the world
(defn empty-world []
  {:fns (array-map) :state {} :generation 0 :revisions [] :rev-idx nil
   :examples [] :laws [] :traces [] :requests {}})

(defn world-file [dir] (io/file dir "world.edn"))

(defn save! [dir w]
  (let [f (world-file dir) tmp (io/file dir "world.edn.tmp")]
    (.mkdirs (io/file dir))
    (spit tmp (binding [*print-length* nil *print-level* nil] (pr-str (dissoc w :ns))))
    (.renameTo tmp f)))

(defn load-world [dir]
  (let [f (world-file dir)]
    (if (.exists f)
      (let [w (edn/read-string {:readers {}} (slurp f))
            w (update w :fns #(into (array-map) %))]
        (assoc w :ns (load-ns (:fns w))))
      (assoc (empty-world) :ns (load-ns {})))))

(defn current-rev [w] (some->> (:rev-idx w) (get (:revisions w))))

(defn sha [x]
  (let [d (.digest (java.security.MessageDigest/getInstance "SHA-1") (.getBytes (pr-str x) "UTF-8"))]
    (subs (apply str (map #(format "%02x" %) d)) 0 10)))

(defn observe [w]
  {"generation" (:generation w) "revision" (:id (current-rev w))
   "functions" (into {} (:fns w)) "state" (:state w)})

(defn candidate-fns [w forms removes]
  (let [named (mapv (fn [src] (let [n (walk/form-name (walk/read-one src))] [n src])) forms)]
    (when-let [d (seq (filter #(> (val %) 1) (frequencies (map first named))))]
      (walk/fail "function defined twice in one change: " (key (first d))))
    (let [merged (reduce (fn [m [n src]] (assoc m n src)) (:fns w) named)]
      (apply dissoc merged (map str removes)))))

(defn op-try [w {:strs [forms removes questions]}]
  (try
    (let [fns (candidate-fns w (or forms []) (or removes []))
          ns (load-ns fns)
          tainted (atom #{})]
      (try {"ok" true
            "outcomes" (mapv (fn [q] (run-calls ns tainted (get q "fixture") (get q "calls"))) questions)}
           (finally (drop-ns ns))))
    (catch clojure.lang.ExceptionInfo e
      (if (:static (ex-data e)) {"ok" false "error" (ex-message e)} (throw e)))))

(defn fn-names-of [calls] (set (map #(get % "fn") calls)))

(defn superseded? [scope new-examples old]
  (and (every? (set scope) (fn-names-of (:calls old)))
       (some (fn [n] (and (= (:fixture n) (:fixture old)) (= (:calls n) (:calls old))
                          (not (outcome-same? (:expect n) (:expect old)))))
             new-examples)))

(defn replay-traces
  "Replay recorded executes on ns. Returns [failures states]."
  [ns tainted traces scope]
  (let [scope (set scope)
        rs (mapv (fn [t]
                   (let [o (run-calls ns tainted (:before t) [(:call t)])
                         f (get-in t [:call "fn"])]
                     [t o f]))
                 traces)
        fails (vec (keep (fn [[t o f]]
                           (cond (or (get o "throws") (get o "timeout"))
                                 {"layer" "traces" "detail" (str "trace " (pr-str (:call t)) " now " (if (get o "timeout") "times out" (str "throws: " (get o "error"))))}
                                 (and (not (scope f)) (not (same? (get o "value") (:value t))))
                                 {"layer" "traces" "detail" (str "trace " (pr-str (:call t)) " changed value " (pr-str (:value t)) " -> " (pr-str (get o "value")) " but " f " is not in scope")}))
                         rs))]
    [fails (keep (fn [[_ o _]] (get o "state")) rs)]))

(defn op-develop [w req dir]
  (let [{:strs [generation intent scope forms removes examples laws asked]} req
        scope (vec scope)]
    (if (not= generation (:generation w))
      [w {"status" "stale" "generation" (:generation w) "failed" []}]
      (let [reject (fn [fails] [w {"status" "rejected" "generation" (:generation w) "failed" (vec fails)}])]
        (try
          (let [fns (candidate-fns w (or forms []) (or removes []))
                ns (load-ns fns)                     ; layer static (+ language layer): form shape, allowlist, names, compile
                names (set (keys fns))
                tainted (atom #{})
                new-ex (mapv (fn [e] {:fixture (get e "fixture") :calls (get e "calls") :expect (get e "expect") :scope scope}) examples)
                old-ex (vec (remove #(superseded? scope new-ex %) (:examples w)))
                all-ex (into old-ex new-ex)
                outs (mapv (fn [e] (run-calls ns tainted (:fixture e) (:calls e))) all-ex)
                ratchet (vec (keep (fn [[e o]]
                                     (when-not (outcome-same? o (:expect e))
                                       {"layer" "ratchet" "detail" (str (pr-str (:calls e)) " on " (pr-str (:fixture e)) ": got " (pr-str o) ", expected " (pr-str (:expect e)))}))
                                   (map vector all-ex outs)))
                [tfails tstates] (replay-traces ns tainted (:traces w) scope)
                inv (vec (concat
                          (map (fn [v] {"layer" "invariants" "detail" (str "live state: " v)}) (violations (:state w)))
                          (mapcat (fn [[e o]] (map (fn [v] {"layer" "invariants" "detail" (str (pr-str (:calls e)) " leaves state violating " v)})
                                                   (when (contains? o "state") (violations (get o "state")))))
                                  (map vector all-ex outs))
                          (mapcat (fn [s] (map (fn [v] {"layer" "invariants" "detail" (str "replayed trace leaves state violating " v)}) (violations s))) tstates)))
                all-laws (vec (concat (remove (fn [l] (some #(= (get % "name") (:name l)) laws)) (map (fn [l] {"name" (:name l) "check" (:check l)}) (:laws w)))
                                      laws))
                fails (concat ratchet inv tfails)
                fails (if (seq fails) fails (check-laws ns tainted all-laws names))] ; laws only once the cheaper gates pass
            (if (seq fails)
              (do (drop-ns ns) (reject (take 12 fails)))
              (let [id (format "rev-%04d" (inc (count (:revisions w))))
                    changed (set (concat (filter #(not= (get (:fns w) %) (get fns %)) (keys fns))
                                         (remove #(contains? fns %) (keys (:fns w)))))
                    rev {:id id :code-id (sha fns) :data-id (sha (:state w)) :intent intent :scope scope
                         :asked asked :fns fns :changed changed}
                    revs (conj (vec (take (inc (or (:rev-idx w) -1)) (:revisions w))) rev)
                    w2 (-> w
                           (assoc :fns fns :ns ns :generation (inc (:generation w)) :revisions revs :rev-idx (dec (count revs))
                                  :examples all-ex
                                  :laws (mapv (fn [l] {:name (get l "name") :check (get l "check")}) all-laws))
                           (as-> x (do (drop-ns (:ns w)) x)))]
                (save! dir w2)
                [w2 {"status" "accepted" "revision" id "generation" (:generation w2) "failed" []}])))
          (catch clojure.lang.ExceptionInfo e
            (if (:static (ex-data e))
              (reject [{"layer" "static" "detail" (ex-message e)}])
              (throw e))))))))

(defn op-execute [w {:strs [call request_id]} dir]
  (if-let [r (and request_id (get (:requests w) request_id))]
    [w {"ok" true "value" (:value r) "replayed" true}]
    (let [r (run-call (:ns w) (atom #{}) (:state w) call)]
      (cond (:timeout r) [w {"ok" false "error" "timed out after 1 s"}]
            (:error r) [w {"ok" false "error" (:error r)}]
            :else
            (let [w2 (cond-> (-> w (assoc :state (:state r))
                                 (update :traces conj {:before (:state w) :call call :value (:value r)}))
                       request_id (assoc-in [:requests request_id] {:value (:value r)}))]
              (save! dir w2)
              [w2 {"ok" true "value" (:value r) "replayed" false}])))))

(defn op-rollback [w {:strs [revision]} dir]
  (let [revs (:revisions w)
        idx (if revision (first (keep-indexed (fn [i r] (when (= (:id r) revision) i)) revs)) (some-> (:rev-idx w) dec))]
    (cond
      (or (nil? idx) (neg? idx) (nil? (get revs idx))) [w {"ok" false "error" (str "no such revision: " (or revision "(none before current)"))}]
      :else
      (let [target (get revs idx)
            fns (:fns target)
            scope (set (concat (filter #(not= (get (:fns w) %) (get fns %)) (keys fns)) (remove #(contains? fns %) (keys (:fns w)))))]
        (try
          (let [ns (load-ns fns)
                tainted (atom #{})
                [tfails tstates] (replay-traces ns tainted (:traces w) scope)
                inv (concat (violations (:state w)) (mapcat violations tstates))]
            (if (or (seq tfails) (seq inv))
              (do (drop-ns ns)
                  [w {"ok" false "error" (str "old code is not safe on today's data: " (str/join "; " (concat inv (map #(get % "detail") tfails))))}])
              (let [w2 (-> w (assoc :fns fns :ns ns :rev-idx idx :generation (inc (:generation w))))]
                (drop-ns (:ns w))
                (save! dir w2)
                [w2 {"ok" true "revision" (:id target) "generation" (:generation w2)}])))
          (catch clojure.lang.ExceptionInfo e
            (if (:static (ex-data e)) [w {"ok" false "error" (ex-message e)}] (throw e))))))))

(defn op-why [w {:strs [fn]}]
  (when-let [idx (:rev-idx w)]
    (when-let [r (first (filter #(contains? (:changed %) fn) (reverse (subvec (:revisions w) 0 (inc idx)))))]
      {"revision" (:id r) "intent" (:intent r) "asked" (:asked r)})))

(defn history
  "Every state the app ever had: the before-state of each trace plus the live one. Structural sharing keeps this cheap."
  [w] (conj (mapv :before (:traces w)) (:state w)))

(defn handle
  "[world request] -> [world' response]"
  [w req dir]
  (case (get req "op")
    "observe" [w (observe w)]
    "try" [w (op-try w req)]
    "develop" (op-develop w req dir)
    "execute" (op-execute w req dir)
    "rollback" (op-rollback w req dir)
    "why" [w (op-why w req)]
    "history" [w {"states" (count (history w))}]
    "at" [w {"state" (nth (history w) (get req "index"))}]
    [w {"error" (str "unknown op " (pr-str (get req "op")))}]))
