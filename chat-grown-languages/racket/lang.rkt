#lang racket/base
;; The language app code is written in: an explicit allow-list of racket/base (+list/string/math/format) and the
;; state operations. Anything not exported here (eval, namespaces, ports, files, tcp, subprocess, continuations,
;; threads, parameterize, require, syntax) is simply unbound in the sandbox namespace.
(require racket/list racket/string racket/math racket/format racket/function)
(provide
 ;; module / top-level plumbing for the evaluator
 #%module-begin #%top-interaction #%app #%datum #%top
 ;; syntax
 define lambda λ let let* letrec let-values let*-values if cond case else => when unless and or not begin begin0
 quote quasiquote unquote unquote-splicing set! do case-lambda with-handlers
 for for* for/list for*/list for/fold for/hash for/hasheq for/sum for/product for/and for/or for/first for/last
 in-list in-range in-naturals in-hash in-hash-keys in-hash-values in-hash-pairs in-string in-value
 ;; numbers
 + - * / = < > <= >= quotient remainder modulo abs min max floor ceiling round truncate sqrt expt exp log
 sin cos tan atan gcd lcm number? real? integer? rational? exact? inexact? exact-integer? exact-nonnegative-integer?
 zero? positive? negative? even? odd? add1 sub1 exact->inexact inexact->exact nan? infinite?
 exact-round exact-floor exact-ceiling exact-truncate sqr pi
 ;; booleans / equality / misc
 eq? eqv? equal? boolean? void void? values call-with-values apply identity
 ;; pairs and lists
 cons car cdr caar cadr cdar cddr caddr list list* pair? null? list? empty empty? first second third fourth fifth
 rest last length append append* reverse list-ref list-tail take drop take-right drop-right takef dropf
 map for-each andmap ormap filter filter-map append-map remove remq remove* foldl foldr sort assoc assq assv
 member memq memv findf memf build-list range count argmin argmax remove-duplicates flatten partition group-by
 index-of add-between list-set check-duplicates split-at
 ;; strings, symbols, characters
 string? symbol? char? string string-append substring string-length string-ref string=? string<? string>? string<=?
 string>=? string-ci=? string-upcase string-downcase string-titlecase string-join string-split string-trim
 string-contains? string-prefix? string-suffix? string-replace string->symbol symbol->string string->list
 list->string number->string string->number symbol<? char->integer integer->char format ~a ~r
 ;; hashes (immutable preferred; mutable allowed for scratch use)
 hash hasheq hash-ref hash-set hash-remove hash-has-key? hash-keys hash-values hash->list hash-update hash-count
 hash? hash-empty? hash-map make-hash make-hasheq hash-set! hash-ref! hash-update! hash-remove! hash-copy
 ;; errors
 error raise raise-user-error raise-argument-error exn? exn:fail? exn-message
 ;; state (the only door to the live world)
 get-state set-state! update-state! kernel-run)

(define current-state (hasheq))
(define (get-state) current-state)
(define (set-state! s) (set! current-state s) (void))
(define (update-state! f) (set! current-state (f current-state)) (void))
;; Host entry point: run a thunk with the given state, return (cons value final-state). Not for app code.
(define (kernel-run state thunk)
  (set! current-state state)
  (let ([v (thunk)]) (cons v current-state)))
