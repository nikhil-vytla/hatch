#lang racket/base
;; Racket live kernel: JSON-lines protocol (../PROTOCOL.md). App code runs in racket/sandbox evaluators whose
;; namespace holds only lang.rkt's allow-list; forms are read as data and expanded (never run) by the static gate.
(require racket/sandbox racket/list racket/string racket/math racket/runtime-path racket/file json file/sha1)

(define-runtime-path lang-file "lang.rkt")
(define lang-mod `(file ,(path->string lang-file)))
(define lang-dir (let-values ([(base n d) (split-path lang-file)]) base))
(define (log . a) (apply eprintf a) (flush-output (current-error-port)))

;; ---------------------------------------------------------------- JSON <-> native
(define (norm v)
  (cond [(hash? v) (for/hasheq ([(k x) (in-hash v)])
                     (values (cond [(symbol? k) k] [(string? k) (string->symbol k)]
                                   [else (error 'json "object key is not a symbol or string: ~e" k)])
                             (norm x)))]
        [(list? v) (map norm v)]
        [(string? v) (string->immutable-string v)]
        [(boolean? v) v]
        [(eq? v 'null) v]
        [(void? v) 'null]
        [(exact-integer? v) v]
        [(rational? v) (if (exact? v) (exact->inexact v) v)]
        [else (error 'json "value cannot be represented as JSON: ~e" v)]))

(define (jequal? a b)
  (cond [(and (real? a) (real? b)) (<= (abs (- a b)) 1e-9)]
        [(and (hash? a) (hash? b))
         (and (= (hash-count a) (hash-count b))
              (for/and ([(k v) (in-hash a)]) (and (hash-has-key? b k) (jequal? v (hash-ref b k)))))]
        [(and (list? a) (list? b)) (and (= (length a) (length b)) (andmap jequal? a b))]
        [else (equal? a b)]))

(define (short v [n 300])
  (let ([s (with-handlers ([void (λ (e) "?")]) (jsexpr->string v))])
    (if (> (string-length s) n) (string-append (substring s 0 n) "...") s)))

;; ---------------------------------------------------------------- invariants (native)
(define scenario (or (getenv "SCENARIO") "expenses"))
(define (invariant-violation st)
  (if (equal? scenario "gateway") (gateway-violation st) (expense-violation st)))

(define (gateway-violation st)
  (define (whole? x) (and (real? x) (rational? x) (= x (floor x))))
  (define (nonempty? x) (and (string? x) (> (string-length x) 0)))
  (cond
    [(not (hash? st)) "known-keys: state is not an object"]
    [(for/first ([k (in-hash-keys st)] #:unless (memq k '(calls prices quotas))) k)
     => (λ (k) (format "known-keys: unexpected top-level key ~a" k))]
    [else
     (define cs (hash-ref st 'calls '()))
     (define ps (hash-ref st 'prices (hasheq)))
     (define qs (hash-ref st 'quotas (hasheq)))
     (or (and (not (list? cs)) "calls-shape: calls is not a list")
         (and (not (hash? ps)) "prices-shape: prices is not an object")
         (and (not (hash? qs)) "quotas-shape: quotas is not an object")
         (for/first ([c (in-list cs)] [i (in-naturals)]
                     #:unless (and (hash? c) (= (hash-count c) 3)
                                   (nonempty? (hash-ref c 'key #f)) (nonempty? (hash-ref c 'model #f))
                                   (let ([t (hash-ref c 'tokens #f)]) (and (whole? t) (> t 0)))))
           (format "calls-shape: call #~a is ~a" i (short c)))
         (for/first ([(k p) (in-hash ps)] #:unless (and (real? p) (rational? p) (>= p 0)))
           (format "prices-shape: price ~a is ~a" k (short p)))
         (for/first ([(k q) (in-hash qs)] #:unless (and (whole? q) (>= q 0)))
           (format "quotas-shape: quota ~a is ~a" k (short q)))
         (for/first ([(k q) (in-hash qs)]
                     #:when (> (for/sum ([c (in-list cs)] #:when (equal? (string->symbol (hash-ref c 'key)) k)) (hash-ref c 'tokens)) q))
           (format "within-quota: ~a is over its quota ~a" k q)))]))

(define (expense-violation st)
  (define (finite? x) (and (real? x) (rational? x)))
  (cond
    [(not (hash? st)) "known-keys: state is not an object"]
    [(for/first ([k (in-hash-keys st)] #:unless (memq k '(expenses budgets))) k)
     => (λ (k) (format "known-keys: unexpected top-level key ~a" k))]
    [else
     (define es (hash-ref st 'expenses '()))
     (define bs (hash-ref st 'budgets (hasheq)))
     (or (and (not (list? es)) "expenses-shape: expenses is not a list")
         (for/first ([e (in-list es)] [i (in-naturals)]
                     #:unless (and (hash? e)
                                   (for/and ([k (in-hash-keys e)]) (memq k '(amount category note)))
                                   (let ([a (hash-ref e 'amount #f)]) (and (finite? a) (> a 0)))
                                   (let ([c (hash-ref e 'category #f)]) (and (string? c) (> (string-length c) 0)))
                                   (let ([n (hash-ref e 'note "")]) (string? n))))
           (format "expenses-shape: expense #~a is ~a" i (short e)))
         (and (not (hash? bs)) "budgets-shape: budgets is not an object")
         (and (hash? bs)
              (for/first ([(k b) (in-hash bs)] #:unless (and (finite? b) (>= b 0)))
                (format "budgets-shape: budget ~a is ~a" k (short b)))))]))

;; ---------------------------------------------------------------- static gate
(define lang-exports
  (let ()
    (dynamic-require lang-mod (void))
    (define-values (vars stxs) (module->exports lang-mod))
    (define names (make-hasheq))
    (for* ([grp (append vars stxs)] [entry (cdr grp)]) (hash-set! names (car entry) #t))
    names))

(define forbidden-reasons
  (let ([h (make-hasheq)])
    (for ([s '(eval eval-syntax namespace-require namespace-attach-module make-base-namespace make-base-empty-namespace
               current-namespace namespace-variable-value namespace-set-variable-value! dynamic-require require
               #%require #%variable-reference quote-syntax datum->syntax define-syntax define-syntaxes begin-for-syntax
               load load-extension module module* provide)])
      (hash-set! h s "metaprogramming / namespace / module access"))
    (for ([s '(open-input-file open-output-file call-with-input-file call-with-output-file with-input-from-file
               with-output-to-file delete-file rename-file-or-directory make-directory directory-list file->string
               current-directory)])
      (hash-set! h s "filesystem access"))
    (for ([s '(tcp-connect tcp-listen udp-open-socket)]) (hash-set! h s "network access"))
    (for ([s '(subprocess system system* process process* find-executable-path)]) (hash-set! h s "process creation"))
    (for ([s '(call/cc call-with-current-continuation call/ec call-with-escape-continuation let/cc let/ec
               call-with-composable-continuation make-continuation-prompt-tag)])
      (hash-set! h s "continuation capture"))
    (for ([s '(thread kill-thread custodian-shutdown-all make-custodian parameterize make-parameter sleep exit
               getenv putenv current-command-line-arguments unsafe-set-box! vector-set! unsafe-car)])
      (hash-set! h s "thread / custodian / environment / unsafe access"))
    h))

(define host-ns
  (let ([ns (make-base-empty-namespace)])
    (parameterize ([current-namespace ns]) (namespace-require lang-mod))
    ns))

(define (static-fail fmt . args) (raise (cons 'static (apply format fmt args))))

(define (read-one src what)
  (unless (string? src) (static-fail "~a must be a string" what))
  (parameterize ([read-accept-reader #f] [read-accept-lang #f] [read-accept-compiled #f] [read-accept-graph #f]
                 [read-accept-box #f] [read-accept-quasiquote #t] [current-readtable #f])
    (with-handlers ([exn:fail:read? (λ (e) (static-fail "~a does not read: ~a" what (exn-message e)))])
      (define in (open-input-string src))
      (define d (read in))
      (when (eof-object? d) (static-fail "~a is empty" what))
      (unless (eof-object? (read in)) (static-fail "~a holds more than one top-level form" what))
      d)))

;; Expand an expression (never evaluate); returns (values free-ids bad-sets).
(define (expand-analyse datum)
  (define stx (namespace-syntax-introduce (datum->syntax #f datum)))
  (define expanded
    (with-handlers ([exn:fail:resource? (λ (e) (static-fail "expansion took too long"))]
                    [exn:fail? (λ (e) (static-fail "does not expand: ~a" (car (string-split (exn-message e) "\n"))))])
      (parameterize ([current-namespace host-ns])
        (call-with-limits 3 #f (λ () (expand stx))))))
  (define free (make-hasheq))
  (define bad-sets '())
  (let walk ([s expanded])
    (define e (syntax-e s))
    (cond
      [(pair? e)
       (define h (car e))
       (define hs (and (syntax? h) (identifier? h) (syntax-e h)))
       (cond
         [(memq hs '(quote quote-syntax)) (void)]
         [(and (eq? hs '#%top) (syntax? (cdr e))) (hash-set! free (syntax-e (cdr e)) #t)]
         [else
          (when (and (eq? hs 'set!) (pair? (cdr e)) (syntax? (cadr e)) (identifier? (cadr e))
                     (not (eq? (identifier-binding (cadr e)) 'lexical)))
            (set! bad-sets (cons (syntax-e (cadr e)) bad-sets)))
          (let loop ([p e])
            (cond [(pair? p) (walk (car p)) (loop (cdr p))]
                  [(syntax? p) (walk p)]))])]
      [else (void)]))
  (values (hash-keys free) bad-sets))

;; src -> (list name free-ids) or raises (cons 'static msg). Cached by source text.
(define analysis-cache (make-hash))
(define (analyse-form src)
  (hash-ref! analysis-cache src
    (λ ()
      (define d (read-one src "form"))
      (unless (and (pair? d) (eq? (car d) 'define) (list? d) (>= (length d) 3) (pair? (cadr d)))
        (static-fail "form must be exactly (define (name param ...) body ...+); got ~a" (short-datum d)))
      (define head (cadr d))
      (define name (car head))
      (define params (cdr head))
      (unless (symbol? name) (static-fail "function name must be a symbol"))
      (when (hash-ref lang-exports name #f)
        (static-fail "~a redefines a builtin of the app language; choose another name" name))
      (when (hash-ref forbidden-reasons name #f)
        (static-fail "~a is a forbidden name (~a)" name (hash-ref forbidden-reasons name)))
      (unless (list? params) (static-fail "parameters must be a plain list (no rest argument)"))
      (for ([p params])
        (unless (or (symbol? p) (and (list? p) (= (length p) 2) (symbol? (car p))))
          (static-fail "parameter must be `x` or `[x default]`; got ~a" (short-datum p))))
      (define pnames (map (λ (p) (if (symbol? p) p (car p))) params))
      (unless (= (length pnames) (length (remove-duplicates pnames))) (static-fail "duplicate parameter names"))
      (define-values (free sets) (expand-analyse `(lambda ,params ,@(cddr d))))
      (unless (null? sets) (static-fail "~a: set! of non-local variable ~a is not allowed" name (car sets)))
      (list name free))))

(define (short-datum d) (let ([s (format "~s" d)]) (if (> (string-length s) 80) (string-append (substring s 0 80) "...") s)))

(define (free-id-error who free allowed)
  (for/or ([id (sort free symbol<?)])
    (cond [(hash-ref allowed id #f) #f]
          [(hash-ref forbidden-reasons id #f)
           => (λ (why) (format "~a uses forbidden ~a (~a)" who id why))]
          [else (format "~a calls or references unknown identifier ~a (not a builtin, not defined by this candidate)" who id)])))

;; fns: list of (name . src). Returns #f if the candidate is statically sound, else an error string.
(define (static-check fns)
  (with-handlers ([(λ (e) (and (pair? e) (eq? (car e) 'static))) cdr])
    (define allowed (make-hasheq))
    (for ([(k _) (in-hash lang-exports)]) (hash-set! allowed k #t))
    (for ([f fns]) (hash-set! allowed (car f) #t))
    (for ([f fns])
      (define info
        (with-handlers ([(λ (e) (and (pair? e) (eq? (car e) 'static)))
                         (λ (e) (static-fail "~a: ~a" (car f) (cdr e)))])
          (analyse-form (cdr f))))
      (unless (eq? (car info) (car f)) (static-fail "internal: name mismatch"))
      (define err (free-id-error (car f) (cadr info) allowed))
      (when err (static-fail "~a" err)))
    #f))

;; Expression (law check) analysis.
(define (check-expr-static src fns)
  (with-handlers ([(λ (e) (and (pair? e) (eq? (car e) 'static))) cdr])
    (define d (read-one src "law check"))
    (define-values (free sets) (expand-analyse d))
    (unless (null? sets) (static-fail "set! of non-local ~a" (car sets)))
    (define allowed (make-hasheq))
    (for ([(k _) (in-hash lang-exports)]) (hash-set! allowed k #t))
    (for ([f fns]) (hash-set! allowed (car f) #t))
    (define err (free-id-error "law" free allowed))
    (when err (static-fail "~a" err))
    #f))

;; ---------------------------------------------------------------- sandbox evaluators
(define (new-evaluator)
  (parameterize ([sandbox-memory-limit 128]
                 [sandbox-eval-limits '(1 #f)]
                 [sandbox-output #f] [sandbox-error-output #f] [sandbox-input #f]
                 [sandbox-path-permissions (cons (list 'read (path->string lang-dir)) (sandbox-path-permissions))])
    (make-evaluator lang-mod)))

;; A candidate world: fns (list of (name . src)) plus a lazily (re)built evaluator.
(struct cand (fns [ev #:mutable]))
(define (cand-evaluator c)
  (define ev (cand-ev c))
  (cond
    [(and ev (evaluator-alive? ev)) ev]
    [else
     (define fresh (new-evaluator))
     (for ([f (cand-fns c)])
       (fresh (read-one (cdr f) "form")))
     (set-cand-ev! c fresh)
     fresh]))
(define (cand-kill! c) (when (cand-ev c) (with-handlers ([void void]) (kill-evaluator (cand-ev c))) (set-cand-ev! c #f)))
(define (cand-names c) (map car (cand-fns c)))

;; Run one call in a candidate: -> (list 'ok value state) | (list 'throws msg) | (list 'timeout)
(define (run-call c state call)
  (define fn (and (hash? call) (hash-ref call 'fn #f)))
  (define args (and (hash? call) (hash-ref call 'args '())))
  (cond
    [(not (and (string? fn) (list? args))) (list 'throws "malformed call")]
    [(not (memq (string->symbol fn) (cand-names c))) (list 'throws (format "no function ~a" fn))]
    [else
     (with-handlers ([exn:fail:resource?
                      (λ (e) (if (eq? (exn:fail:resource-resource e) 'time)
                                 (list 'timeout)
                                 (begin (cand-kill! c) (list 'throws (format "resource limit exceeded: ~a" (exn-message e))))))]
                     [exn? (λ (e) (list 'throws (exn-message e)))]
                     [(λ (e) #t) (λ (e) (list 'throws (format "raised: ~s" e)))])
       (define ev (cand-evaluator c))
       (define r (ev `(kernel-run (quote ,state) (lambda () (,(string->symbol fn) ,@(map (λ (a) `(quote ,a)) args))))))
       (list 'ok (norm (car r)) (norm (cdr r))))]))

;; a question's calls as a transaction sequence -> outcome hash
(define (run-calls c fixture calls)
  (let loop ([calls calls] [st fixture] [val 'null])
    (cond
      [(null? calls) (hasheq 'value val 'state st)]
      [else
       (define r (run-call c st (car calls)))
       (case (car r)
         [(ok) (loop (cdr calls) (caddr r) (cadr r))]
         [(timeout) (hasheq 'timeout #t)]
         [else (hasheq 'throws #t 'error (cadr r) 'state st)])])))

(define (outcome-matches? got want)
  (cond [(hash-ref want 'timeout #f) (hash-ref got 'timeout #f)]
        [(hash-ref want 'throws #f)
         (and (hash-ref got 'throws #f) (or (not (hash-has-key? want 'state)) (jequal? (hash-ref got 'state) (hash-ref want 'state))))]
        [else (and (not (hash-ref got 'throws #f)) (not (hash-ref got 'timeout #f))
                   (jequal? (hash-ref got 'value 'null) (hash-ref want 'value 'null))
                   (or (not (hash-has-key? want 'state)) (jequal? (hash-ref got 'state) (hash-ref want 'state))))]))

(define (outcome-state o) (hash-ref o 'state #f))

;; ---------------------------------------------------------------- world
(define data-dir #f)
(define generation 0)
(define current-rev #f)            ; revision id or #f
(define revisions '())              ; list of hasheq, oldest first; each has 'functions : list of [name, src]
(define fns '())                    ; list of (name . src)
(define state (hasheq))
(define examples '())               ; list of hasheq: fixture calls expect fns
(define traces '())                 ; newest last: hasheq before call value
(define laws '())                   ; list of (name . check)
(define done (hasheq))              ; request_id -> value
(define live #f)                    ; cand or #f

(define (fns->json l) (map (λ (f) (list (symbol->string (car f)) (cdr f))) l))
(define (json->fns l) (map (λ (p) (cons (string->symbol (car p)) (cadr p))) l))

(define (persist!)
  (define path (build-path data-dir "world.json"))
  (define tmp (build-path data-dir "world.json.tmp"))
  (call-with-output-file tmp #:exists 'truncate
    (λ (o)
      (write-json
       (hasheq 'generation generation 'current (or current-rev 'null)
               'revisions (map (λ (r) (hash-remove (hash-set r 'functions (fns->json (hash-ref r 'fns-raw))) 'fns-raw)) revisions)
               'state state 'examples examples 'traces traces
               'laws (map (λ (l) (hasheq 'name (car l) 'check (cdr l))) laws)
               'done done)
       o)))
  (rename-file-or-directory tmp path #t))

(define (load-world!)
  (define path (build-path data-dir "world.json"))
  (when (file-exists? path)
    (define w (call-with-input-file path read-json))
    (set! generation (hash-ref w 'generation))
    (set! current-rev (let ([c (hash-ref w 'current)]) (and (string? c) c)))
    (set! revisions (map (λ (r) (hash-set (hash-remove r 'functions) 'fns-raw (json->fns (hash-ref r 'functions))))
                         (hash-ref w 'revisions)))
    (set! state (hash-ref w 'state))
    (set! examples (hash-ref w 'examples))
    (set! traces (hash-ref w 'traces))
    (set! laws (map (λ (l) (cons (hash-ref l 'name) (hash-ref l 'check))) (hash-ref w 'laws)))
    (set! done (hash-ref w 'done))
    (define cur (and current-rev (findf (λ (r) (equal? (hash-ref r 'id) current-rev)) revisions)))
    (set! fns (if cur (hash-ref cur 'fns-raw) '()))))

(define (live-cand!)
  (unless (and live (equal? (cand-fns live) fns)) (set! live (cand fns #f)))
  live)

;; ---------------------------------------------------------------- laws (language-specific property checks)
(define (make-gen seed)
  (define s seed)
  (λ () (set! s (modulo (+ (* s 1103515245) 12345) 2147483648)) (/ s 2147483648.0)))
(define (gen-states n)
  (define rand (make-gen 42))
  (define cats '("food" "rent" "transport" "fun"))
  (cons (hasheq)
        (for/list ([_ (in-range n)])
          (define k (inexact->exact (floor (* (rand) 8))))
          (define es (for/list ([_ (in-range k)])
                       (hasheq 'amount (/ (max 1 (round (* (rand) 10000))) 100.0)
                               'category (list-ref cats (inexact->exact (floor (* (rand) 4)))))))
          (define bs (for/hasheq ([c cats] #:when (< (rand) 0.5))
                       (values (string->symbol c) (/ (round (* (rand) 5000)) 100.0))))
          (hasheq 'expenses es 'budgets bs))))

(define (run-law c law-src st)
  (with-handlers ([exn:fail:resource? (λ (e) (list 'fail "timed out or out of memory"))]
                  [exn? (λ (e) (list 'fail (format "raised: ~a" (exn-message e))))])
    (define ev (cand-evaluator c))
    (define r (ev `(kernel-run (quote ,st) (lambda () ,(read-one law-src "law check")))))
    (if (car r) (list 'ok) (list 'fail "returned false"))))

;; ---------------------------------------------------------------- gates
(define (fail-layer layer detail) (hasheq 'layer layer 'detail detail))

(define (scope-names scope) (map (λ (s) (if (string? s) (string->symbol s) s)) scope))

(define (apply-change base forms removes)
  ;; -> (values new-fns err); forms are source strings
  (define rm (map string->symbol removes))
  (with-handlers ([(λ (e) (and (pair? e) (eq? (car e) 'static))) (λ (e) (values #f (cdr e)))])
    (define kept (filter (λ (f) (not (memq (car f) rm))) base))
    (define added
      (for/list ([src forms])
        (define info (analyse-form src))
        (cons (car info) src)))
    (let ([names (map car added)])
      (unless (= (length names) (length (remove-duplicates names)))
        (static-fail "two forms define the same name")))
    (define out
      (let loop ([kept kept] [added added])
        (cond [(null? added) kept]
              [else
               (define a (car added))
               (if (assq (car a) kept)
                   (loop (map (λ (f) (if (eq? (car f) (car a)) a f)) kept) (cdr added))
                   (loop (append kept (list a)) (cdr added)))])))
    (values out #f)))

;; candidate evaluator cache so try -> develop on the same forms builds the sandbox once
(define cache #f)
(define (candidate-for new-fns)
  (cond
    [(and live (equal? (cand-fns live) new-fns)) live]
    [(and cache (equal? (cand-fns cache) new-fns)) cache]
    [else
     (when (and cache (not (eq? cache live))) (cand-kill! cache))
     (set! cache (cand new-fns #f))
     cache]))

(define (calls-fns calls) (remove-duplicates (for/list ([c calls] #:when (hash? c)) (hash-ref c 'fn ""))))

(define (run-gates new-fns c req-examples scope new-laws)
  ;; returns list of failures (first failing layer only)
  (define scope-set (scope-names scope))
  ;; 1. static
  (define serr (static-check new-fns))
  (cond
    [serr (list (fail-layer "static" serr))]
    [else
     (define law-errs
       (for/or ([l (append (map (λ (l) (cons (hash-ref l 'name "law") (hash-ref l 'check ""))) new-laws) laws)])
         (let ([e (check-expr-static (cdr l) new-fns)]) (and e (format "law ~a: ~a" (car l) e)))))
     (cond
       [law-errs (list (fail-layer "static" law-errs))]
       [else
        ;; sandbox layer: the candidate must load in a fresh evaluator under the security guard
        (define load-err
          (with-handlers ([exn? (λ (e) (exn-message e))])
            (cand-evaluator c) #f))
        (cond
          [load-err (list (fail-layer "sandbox" (format "candidate failed to load in the sandbox: ~a" load-err)))]
          [else (gates-dynamic new-fns c req-examples scope-set new-laws)])])]))

(define (gates-dynamic new-fns c req-examples scope-set new-laws)
  (define fail #f)
  (define (bail! layer detail) (unless fail (set! fail (list (fail-layer layer detail)))))
  ;; superseded earlier examples: all functions in scope and contradicted by one of this request's examples
  (define kept-old
    (filter (λ (old)
              (not (and (andmap (λ (f) (memq (string->symbol f) scope-set)) (hash-ref old 'fns '()))
                        (for/or ([n req-examples])
                          (and (equal? (hash-ref n 'fixture) (hash-ref old 'fixture))
                               (equal? (hash-ref n 'calls) (hash-ref old 'calls))
                               (not (jequal? (hash-ref n 'expect) (hash-ref old 'expect))))))))
            examples))
  (define result-states '())
  ;; 2. ratchet
  (for ([ex (append kept-old req-examples)] #:unless fail)
    (define o (run-calls c (hash-ref ex 'fixture) (hash-ref ex 'calls)))
    (if (outcome-matches? o (hash-ref ex 'expect))
        (let ([s (outcome-state o)]) (when s (set! result-states (cons s result-states))))
        (bail! "ratchet" (format "~a on ~a: got ~a, expected ~a" (short (hash-ref ex 'calls) 120) (short (hash-ref ex 'fixture) 120)
                                 (short o 160) (short (hash-ref ex 'expect) 160)))))
  ;; 3. invariants: live state, every example's resulting state
  (unless fail
    (define v (invariant-violation state))
    (when v (bail! "invariants" (format "live state: ~a" v)))
    (for ([s result-states] #:unless fail)
      (define v (invariant-violation s))
      (when v (bail! "invariants" (format "example result: ~a" v)))))
  ;; 4. traces
  (for ([t traces] [i (in-naturals)] #:unless fail)
    (define call (hash-ref t 'call))
    (define r (run-call c (hash-ref t 'before) call))
    (case (car r)
      [(timeout) (bail! "traces" (format "trace ~a ~a now times out" i (short call 100)))]
      [(throws) (bail! "traces" (format "trace ~a ~a ran before, now throws: ~a" i (short call 100) (cadr r)))]
      [else
       (define v (invariant-violation (caddr r)))
       (cond
         [v (bail! "invariants" (format "after replaying trace ~a ~a: ~a" i (short call 100) v))]
         [(and (not (memq (string->symbol (hash-ref call 'fn)) scope-set))
               (not (jequal? (cadr r) (hash-ref t 'value))))
          (bail! "traces" (format "trace ~a ~a changed value ~a -> ~a but ~a is not in scope" i (short call 100)
                                  (short (hash-ref t 'value) 80) (short (cadr r) 80) (hash-ref call 'fn)))])]))
  ;; 5. language layer: the sandbox (limits above) plus property laws on generated states
  (unless fail
    (define states (gen-states 25))
    (for* ([l (append (map (λ (l) (cons (hash-ref l 'name "law") (hash-ref l 'check ""))) new-laws)
                      (filter (λ (l) (not (assoc (car l) (map (λ (n) (cons (hash-ref n 'name "law") 0)) new-laws)))) laws))]
           [st states] #:unless fail)
      (define r (run-law c (cdr l) st))
      (when (eq? (car r) 'fail)
        (bail! "laws" (format "law ~a ~a on state ~a" (car l) (cadr r) (short st 160))))))
  (or fail '()))

;; ---------------------------------------------------------------- ops
(define (hash-id s) (substring (sha1 (open-input-string s)) 0 10))
(define (rev-id n) (string-append "rev-" (~r4 n)))
(define (~r4 n) (let ([s (number->string n)]) (string-append (make-string (max 0 (- 4 (string-length s))) #\0) s)))

(define (bad msg) (raise (cons 'bad msg)))
(define (req-ref req k [default (void)])
  (define v (hash-ref req k default))
  (when (void? v) (bad (format "missing field ~a" k)))
  v)
(define (string-list who v)
  (unless (and (list? v) (andmap string? v)) (bad (format "~a must be a list of strings" who)))
  v)

(define (op-observe)
  (hasheq 'generation generation 'revision (or current-rev 'null)
          'functions (for/hasheq ([f fns]) (values (car f) (cdr f)))
          'state state))

(define (op-try req)
  (define forms (string-list "forms" (hash-ref req 'forms '())))
  (define removes (string-list "removes" (hash-ref req 'removes '())))
  (define questions (hash-ref req 'questions '()))
  (define-values (new-fns err) (apply-change fns forms removes))
  (define serr (or err (static-check new-fns)))
  (cond
    [serr (hasheq 'ok #f 'error serr)]
    [else
     (define c (candidate-for new-fns))
     (define lerr (with-handlers ([exn? exn-message]) (cand-evaluator c) #f))
     (if lerr
         (hasheq 'ok #f 'error (format "sandbox: ~a" lerr))
         (hasheq 'ok #t
                 'outcomes (for/list ([q questions])
                             (run-calls c (norm (hash-ref q 'fixture (hasheq))) (hash-ref q 'calls '())))))]))

(define (op-develop req)
  (define gen (req-ref req 'generation))
  (cond
    [(not (equal? gen generation)) (hasheq 'status "stale" 'generation generation)]
    [else
     (define forms (string-list "forms" (hash-ref req 'forms '())))
     (define removes (string-list "removes" (hash-ref req 'removes '())))
     (define scope (string-list "scope" (hash-ref req 'scope '())))
     (define req-examples
       (for/list ([e (hash-ref req 'examples '())])
         (hasheq 'fixture (norm (hash-ref e 'fixture (hasheq))) 'calls (hash-ref e 'calls '())
                 'expect (norm (hash-ref e 'expect (hasheq)))
                 'fns (calls-fns (hash-ref e 'calls '())))))
     (define new-laws (hash-ref req 'laws '()))
     (define-values (new-fns err) (apply-change fns forms removes))
     (define failures
       (if err
           (list (fail-layer "static" err))
           (run-gates new-fns (candidate-for new-fns) req-examples scope new-laws)))
     (cond
       [(pair? failures)
        (hasheq 'status "rejected" 'generation generation 'revision (or current-rev 'null) 'failed failures)]
       [else
        (define c (candidate-for new-fns))
        (define new-gen (add1 generation))
        (define id (rev-id (add1 (length revisions))))
        (define superseded?
          (λ (old) (and (andmap (λ (f) (memq (string->symbol f) (scope-names scope))) (hash-ref old 'fns '()))
                        (for/or ([n req-examples])
                          (and (equal? (hash-ref n 'fixture) (hash-ref old 'fixture))
                               (equal? (hash-ref n 'calls) (hash-ref old 'calls))
                               (not (jequal? (hash-ref n 'expect) (hash-ref old 'expect))))))))
        (set! examples (append (filter (λ (o) (not (superseded? o))) examples) req-examples))
        (for ([l new-laws])
          (set! laws (append (filter (λ (x) (not (equal? (car x) (hash-ref l 'name "law")))) laws)
                             (list (cons (hash-ref l 'name "law") (hash-ref l 'check ""))))))
        (set! revisions
              (append revisions
                      (list (hasheq 'id id 'code_id (hash-id (format "~s" new-fns)) 'data_id (hash-id (jsexpr->string state))
                                    'intent (hash-ref req 'intent "") 'scope scope
                                    'asked (hash-ref req 'asked 'null) 'fns-raw new-fns))))
        (set! fns new-fns)
        (set! live c)
        (set! generation new-gen)
        (set! current-rev id)
        (persist!)
        (hasheq 'status "accepted" 'revision id 'generation new-gen)])]))

(define (op-execute req)
  (define call (req-ref req 'call))
  (define rid (hash-ref req 'request_id #f))
  (define key (and (string? rid) (string->symbol rid)))
  (cond
    [(and key (hash-has-key? done key))
     (hasheq 'ok #t 'value (hash-ref done key) 'replayed #t)]
    [else
     (define r (run-call (live-cand!) state call))
     (case (car r)
       [(timeout) (hasheq 'ok #f 'error "timeout: call ran over 1 second and was killed")]
       [(throws) (hasheq 'ok #f 'error (cadr r))]
       [else
        (define v (invariant-violation (caddr r)))
        (cond
          [v (hasheq 'ok #f 'error (format "invariant violated, nothing committed: ~a" v))]
          [else
           (set! traces (append traces (list (hasheq 'before state 'call call 'value (cadr r)))))
           (set! state (caddr r))
           (when key (set! done (hash-set done key (cadr r))))
           (persist!)
           (hasheq 'ok #t 'value (cadr r) 'replayed #f)])])]))

(define (changed-names a b)
  (remove-duplicates
   (append (for/list ([f a] #:unless (equal? (assq (car f) b) f)) (car f))
           (for/list ([f b] #:unless (assq (car f) a)) (car f)))))

(define (op-rollback req)
  (define want (hash-ref req 'revision #f))
  (define idx (and current-rev (for/first ([r revisions] [i (in-naturals)] #:when (equal? (hash-ref r 'id) current-rev)) i)))
  (define target
    (cond [(string? want) (findf (λ (r) (equal? (hash-ref r 'id) want)) revisions)]
          [(and idx (> idx 0)) (list-ref revisions (sub1 idx))]
          [else #f]))
  (cond
    [(not target) (hasheq 'ok #f 'error (if (string? want) (format "unknown revision ~a" want) "no earlier revision to roll back to"))]
    [else
     (define old-fns (hash-ref target 'fns-raw))
     (define scope (changed-names fns old-fns))
     (define serr (static-check old-fns))
     (define c (cand old-fns #f))
     (define v (invariant-violation state))
     (cond
       [serr (hasheq 'ok #f 'error (format "old code no longer passes the static gate: ~a" serr))]
       [v (hasheq 'ok #f 'error (format "today's data breaks an invariant: ~a" v))]
       [else
        (define problem
          (for/or ([t traces] [i (in-naturals)])
            (define call (hash-ref t 'call))
            (define r (run-call c (hash-ref t 'before) call))
            (case (car r)
              [(timeout) (format "trace ~a ~a now times out" i (short call 80))]
              [(throws) (format "trace ~a ~a ran before, now throws: ~a" i (short call 80) (cadr r))]
              [else (or (let ([v (invariant-violation (caddr r))]) (and v (format "trace ~a breaks ~a" i v)))
                        (and (not (memq (string->symbol (hash-ref call 'fn)) scope))
                             (not (jequal? (cadr r) (hash-ref t 'value)))
                             (format "trace ~a ~a changed value" i (short call 80))))])))
        (cond
          [problem (cand-kill! c) (hasheq 'ok #f 'error (format "rollback refused: ~a" problem))]
          [else
           (set! fns old-fns)
           (set! live c)
           (set! generation (add1 generation))
           (set! current-rev (hash-ref target 'id))
           (persist!)
           (hasheq 'ok #t 'revision current-rev 'generation generation)])])]))

(define (op-why req)
  (define fn (string->symbol (req-ref req 'fn)))
  (define idx (and current-rev (for/first ([r revisions] [i (in-naturals)] #:when (equal? (hash-ref r 'id) current-rev)) i)))
  (cond
    [(or (not idx) (not (assq fn fns))) 'null]
    [else
     (define (src-at i) (let ([p (assq fn (hash-ref (list-ref revisions i) 'fns-raw))]) (and p (cdr p))))
     (define j
       (for/first ([i (in-range idx -1 -1)]
                   #:when (not (equal? (src-at i) (and (> i 0) (src-at (sub1 i))))))
         i))
     (define r (list-ref revisions (or j 0)))
     (hasheq 'revision (hash-ref r 'id) 'intent (hash-ref r 'intent) 'asked (hash-ref r 'asked))]))

(define (handle req)
  (unless (hash? req) (bad "request must be a JSON object"))
  (define op (hash-ref req 'op #f))
  (case op
    [("observe") (op-observe)]
    [("try") (op-try req)]
    [("develop") (op-develop req)]
    [("execute") (op-execute req)]
    [("rollback") (op-rollback req)]
    [("why") (op-why req)]
    [else (bad (format "unknown op ~s" op))]))

(define (main dir)
  (set! data-dir dir)
  (make-directory* dir)
  (load-world!)
  (define out (current-output-port))
  (current-output-port (current-error-port))
  (let loop ()
    (define line (read-line (current-input-port) 'any))
    (unless (eof-object? line)
      (unless (string=? (string-trim line) "")
        (define resp
          (with-handlers ([(λ (e) (and (pair? e) (eq? (car e) 'bad))) (λ (e) (hasheq 'error (cdr e)))]
                          [exn:break? raise]
                          [(λ (e) #t) (λ (e) (log "kernel error: ~a\n" (if (exn? e) (exn-message e) e))
                                        (hasheq 'error (format "internal error: ~a" (if (exn? e) (exn-message e) e))))])
            (define req (with-handlers ([exn:fail? (λ (e) (bad "malformed JSON"))]) (string->jsexpr line)))
            (handle req)))
        (write-json resp out)
        (newline out)
        (flush-output out))
      (loop))))

(module+ main
  (define args (current-command-line-arguments))
  (main (if (> (vector-length args) 0) (vector-ref args 0) "data")))
