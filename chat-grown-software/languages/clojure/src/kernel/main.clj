(ns kernel.main
  (:gen-class)
  (:require [clojure.data.json :as json]
            [kernel.core :as core]))

(defn -main [& [dir]]
  (let [dir (or dir "data")
        out (java.io.PrintWriter. (java.io.OutputStreamWriter. System/out "UTF-8"))
        in (java.io.BufferedReader. (java.io.InputStreamReader. System/in "UTF-8"))]
    (alter-var-root #'*out* (constantly *err*)) ; stdout belongs to the protocol
    (let [w (atom (core/load-world dir))
          reply (fn [m] (.println out (json/write-str m :escape-slash false)) (.flush out))]
      (loop []
        (when-let [line (.readLine in)]
          (when-not (= "" (.trim line))
            (try
              (let [req (json/read-str line)]
                (if (map? req)
                  (let [[w2 resp] (core/handle @w req dir)] (reset! w w2) (reply resp))
                  (reply {"error" "request must be a JSON object"})))
              (catch Throwable e
                (reply {"error" (str "bad request: " (or (ex-message e) (str e)))}))))
          (recur))))
    (shutdown-agents)
    (System/exit 0)))
