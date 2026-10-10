(ns kernel.walk
  "Code is data: read a form with *read-eval* false, check its structure, and walk its body against an
  allowlist before anything is evaluated. Returns the rewritten form (app names canonicalised, ticks injected)."
  (:require [clojure.string :as str] [kernel.api :as api]))

(def core-fns
  '[+ - * / quot rem mod inc dec max min abs = == not= < > <= >= compare not true? false? nil? some? zero? pos? neg?
    even? odd? number? integer? float? double? string? keyword? symbol? map? vector? list? seq? set? coll? char?
    sequential? associative? fn? ifn? contains? empty? every? some not-any? not-every? int long double boolean num
    str subs name keyword symbol count first second last rest next butlast nth nnext fnext ffirst peek pop get get-in
    assoc assoc-in dissoc update update-in update-vals update-keys select-keys merge merge-with into conj cons concat
    seq vec vector list hash-map hash-set set sorted-map sorted-set zipmap keys vals map mapv mapcat filter filterv
    remove reduce reduce-kv reductions take drop take-while drop-while take-last drop-last take-nth split-at
    split-with partition partition-all partition-by group-by frequencies distinct dedupe sort sort-by reverse
    interleave interpose flatten apply partial comp juxt complement constantly identity fnil every-pred some-fn
    max-key min-key empty not-empty subvec rseq find disj replace re-find re-matches re-seq re-pattern format
    ex-info ex-message ex-data doall dorun run! inc' dec' +' *' vary-meta
    ;; macros
    when when-not if-not cond condp and or -> ->> as-> some-> some->> cond-> cond->> if-let when-let if-some when-some
    for doseq dotimes loop let fn case assert])
(def specials '#{if do recur throw quote fn* try catch finally})
(def kernel-names (set (concat api/exports core-fns)))
(def allowed (into specials kernel-names))
(def referable (remove (set api/exports) core-fns)) ; names to refer from clojure.core into app namespaces

(def name-re #"^[a-z][a-z0-9]*([_-][a-z0-9]+)*$")
(defn snake [s] (str/replace (name s) "-" "_"))
(defn kebab [s] (symbol (str/replace s "_" "-")))
(defn fail [& xs] (throw (ex-info (apply str xs) {:static true})))

(defn read-forms [src]
  (binding [*read-eval* false]
    (let [r (java.io.PushbackReader. (java.io.StringReader. src))]
      (loop [acc []]
        (let [f (read {:eof ::eof} r)] (if (= f ::eof) acc (recur (conj acc f))))))))

(defn read-one [src]
  (let [fs (try (read-forms src) (catch Exception e (fail "unreadable form: " (ex-message e))))]
    (when-not (= 1 (count fs)) (fail "each form must be exactly one (defn ...), got " (count fs) " top-level forms"))
    (first fs)))

(defn form-name [form]
  (when-not (and (seq? form) (= 'defn (first form)) (symbol? (second form)))
    (fail "each form must be exactly (defn name [params] body...), got " (pr-str (if (seq? form) (first form) form))))
  (let [n (second form)]
    (when (or (namespace n) (not (re-matches name-re (name n)))) (fail "bad function name " n ": use snake_case or kebab-case"))
    (when (allowed (symbol (name n))) (fail "cannot redefine builtin " n))
    (snake n)))

(defn pattern-syms [p]
  (cond (symbol? p) (cond (= p '&) [] (namespace p) (fail "qualified binding " p) :else [p])
        (vector? p) (mapcat pattern-syms p)
        (map? p) (mapcat (fn [[k v]]
                           (cond (= k :or) []
                                 (#{:keys :strs :syms} k) (map (comp symbol name) v)
                                 (= k :as) (pattern-syms v)
                                 :else (pattern-syms k))) p)
        :else []))

(def tick-form '(kernel.api/tick))
(declare walk)

(defn walk-body [ctx sc forms] (doall (map #(walk ctx sc %) forms)))

(defn walk-bindings [ctx scope bv mods?]
  (when-not (vector? bv) (fail "binding form must be a vector"))
  (when (odd? (count bv)) (fail "binding vector needs pairs"))
  (loop [i 0 out [] sc scope]
    (if (>= i (count bv))
      [out sc]
      (let [p (nth bv i) e (nth bv (inc i))]
        (cond
          (and mods? (keyword? p))
          (if (= p :let)
            (let [[nb sc2] (walk-bindings ctx sc e false)] (recur (+ i 2) (conj out p nb) sc2))
            (recur (+ i 2) (conj out p (walk ctx sc e)) sc))
          :else (let [e2 (walk ctx sc e)] (recur (+ i 2) (conj out p e2) (into sc (pattern-syms p)))))))))

(defn walk-arity [ctx scope [params & body]]
  (when-not (vector? params) (fail "parameter list must be a vector"))
  (when (empty? body) (fail "function body is empty"))
  (let [sc (into scope (pattern-syms params))]
    (list* params tick-form (walk-body ctx sc body))))

(defn walk-fn-tail [ctx scope tail]
  (if (vector? (first tail))
    (walk-arity ctx scope tail)
    (do (when-not (and (seq tail) (every? seq? tail)) (fail "bad fn/defn arities"))
        (mapv #(walk-arity ctx scope %) tail))))

(defn walk-list [ctx scope form]
  (let [[h & args] form]
    (if (and (symbol? h) (not (contains? scope h)))
      (case h
        quote form
        defn (fail "defn is only allowed as the whole top-level form")
        let (let [[bv sc] (walk-bindings ctx scope (first args) false)] (list* h bv (walk-body ctx sc (rest args))))
        loop (let [[bv sc] (walk-bindings ctx scope (first args) false)] (list* h bv tick-form (walk-body ctx sc (rest args))))
        (doseq) (let [[bv sc] (walk-bindings ctx scope (first args) true)] (list* h bv tick-form (walk-body ctx sc (rest args))))
        dotimes (let [[bv sc] (walk-bindings ctx scope (first args) false)] (list* h bv tick-form (walk-body ctx sc (rest args))))
        for (let [[bv sc] (walk-bindings ctx scope (first args) true)] (list* h bv (walk-body ctx sc (rest args))))
        (when-let when-some) (let [[bv sc] (walk-bindings ctx scope (first args) false)] (list* h bv (walk-body ctx sc (rest args))))
        (if-let if-some) (let [[bv sc] (walk-bindings ctx scope (first args) false)]
                           (list* h bv (walk ctx sc (second args)) (walk-body ctx scope (nnext args))))
        as-> (let [[e n & more] args
                   e2 (walk ctx scope e)]
               (when-not (symbol? n) (fail "as-> needs a symbol"))
               (list* h e2 n (walk-body ctx (conj scope n) more)))
        (fn fn*) (let [[nm tail] (if (symbol? (first args)) [(first args) (rest args)] [nil args])
                       sc (if nm (conj scope nm) scope)]
                   (if nm
                     (list* h nm (walk-fn-tail ctx sc tail))
                     (list* h (walk-fn-tail ctx sc tail))))
        case (let [[e & clauses] args]
               (list* h (walk ctx scope e)
                      (loop [cs clauses out []]
                        (cond (empty? cs) out
                              (empty? (rest cs)) (conj out (walk ctx scope (first cs)))
                              :else (recur (nnext cs) (conj out (first cs) (walk ctx scope (second cs))))))))
        try (list* h (map (fn [a]
                            (if (and (seq? a) (contains? #{'catch 'finally} (first a)))
                              (if (= 'catch (first a))
                                (let [[_ cls e & body] a]
                                  (when-not (= cls 'Exception) (fail "catch only supports Exception, got " cls))
                                  (list* 'catch cls e (walk-body ctx (conj scope e) body)))
                                (list* 'finally (walk-body ctx scope (rest a))))
                              (walk ctx scope a))) args))
        (list* (walk ctx scope h) (walk-body ctx scope args)))
      (apply list (walk-body ctx scope form)))))

(defn walk-sym [ctx scope s]
  (cond (contains? scope s) s
        (namespace s) (fail "qualified symbol " s " is not allowed")
        (contains? (:names ctx) (snake s)) (kebab (snake s))
        (contains? allowed s) s
        :else (fail "unresolved symbol " s " (not a core function, a state function, or an app function)")))

(defn walk [ctx scope x]
  (cond
    (symbol? x) (walk-sym ctx scope x)
    (seq? x) (if (empty? x) x (walk-list ctx scope x))
    (vector? x) (mapv #(walk ctx scope %) x)
    (map? x) (into {} (map (fn [[k v]] [(walk ctx scope k) (walk ctx scope v)])) x)
    (set? x) (into #{} (map #(walk ctx scope %)) x)
    (or (number? x) (string? x) (keyword? x) (nil? x) (boolean? x) (char? x) (instance? java.util.regex.Pattern x)) x
    :else (fail "unsupported literal " (pr-str x))))

(defn walk-defn
  "Check a whole top-level (defn ...) source against the app's function names; returns the evaluable form."
  [names src]
  (let [form (read-one src)
        nm (form-name form)
        [_ sym & tail] form
        tail (if (string? (first tail)) (rest tail) tail)
        ctx {:names names}]
    (when (empty? tail) (fail "defn " sym " has no parameter list"))
    (list* 'clojure.core/defn (kebab nm) (walk-fn-tail ctx #{} tail))))

(defn walk-expr "Check a bare expression (law checks)." [names src]
  (walk {:names names} #{} (read-one src)))
