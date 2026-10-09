(ns kernel.api
  "The only kernel functions app code can see, besides a vetted slice of clojure.core."
  (:refer-clojure :exclude [range repeat])
  (:require [clojure.string :as s]))

;; Bound per call: {:cell (atom state), :deadline nanoTime}. A fresh cell per call = the transaction.
(def ^:dynamic *run* nil)

(defn state "The current state map (string keys, JSON-shaped)." [] @(:cell *run*))

(defn swap-state!
  "Replace the state with (apply f state args); returns the new state."
  [f & args]
  (let [new (apply f @(:cell *run*) args)]
    (when-not (map? new) (throw (ex-info "state must stay a map" {})))
    (reset! (:cell *run*) new)
    new))

(defn tick
  "Injected by the form walker into every loop, fn body and doseq/dotimes: cooperative 1 s deadline."
  []
  (when (> (System/nanoTime) (long (:deadline *run*)))
    (throw (Error. "kernel-timeout"))))

(defn round "Math.round semantics (half up), returns a double." [x] (double (Math/round (double x))))
(defn floor [x] (double (Math/floor (double x))))
(defn ceil [x] (double (Math/ceil (double x))))

(def ^:private cap 10000000)
(defn range
  "Bounded range: no infinite or absurdly large sequences."
  ([end] (range 0 end 1))
  ([start end] (range start end 1))
  ([start end step]
   (when (or (zero? step) (> (/ (Math/abs (double (- end start))) (Math/abs (double step))) cap))
     (throw (ex-info "range too large or zero step" {})))
   (clojure.core/range start end step)))
(defn repeat "Bounded (repeat n x)." [n x]
  (when (> n cap) (throw (ex-info "repeat too large" {})))
  (clojure.core/repeat n x))

(defn join ([coll] (s/join coll)) ([sep coll] (s/join sep coll)))
(defn lower-case [x] (s/lower-case x))
(defn upper-case [x] (s/upper-case x))
(defn trim [x] (s/trim x))
(defn blank? [x] (s/blank? x))

(def exports '[state swap-state! round floor ceil range repeat join lower-case upper-case trim blank?])
