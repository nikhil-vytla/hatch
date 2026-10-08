"
The JSON boundary and the three scenario invariants. JSON objects become Dictionaries with String keys,
arrays become OrderedCollections (mutable), numbers stay Integer/Float.
"
Class {
	#name : #CkJson,
	#superclass : #Object,
	#category : #ChatKernel
}

{ #category : #conversion }
CkJson class >> fromJson: x [
	"Parsed JSON (STON) -> mutable native values."

	| d |
	x isDictionary ifTrue: [
		d := Dictionary new.
		x keysAndValuesDo: [ :k :v | d at: k asString put: (self fromJson: v) ].
		^ d ].
	x isString ifTrue: [ ^ x asString ].
	x isCollection ifTrue: [ ^ (x collect: [ :e | self fromJson: e ]) asOrderedCollection ].
	^ x
]

{ #category : #conversion }
CkJson class >> toJson: x [
	"Native values -> plain JSON values (Dictionary / Array / String / number / Boolean / nil). Refuses the rest."

	| d |
	x isNil ifTrue: [ ^ nil ].
	x == true ifTrue: [ ^ true ].
	x == false ifTrue: [ ^ false ].
	x isString ifTrue: [ ^ x asString ].
	x isInteger ifTrue: [ ^ x ].
	x isNumber ifTrue: [
		| f |
		f := x asFloat.
		(f isNaN or: [ f isInfinite ]) ifTrue: [ CkError signal: 'not a JSON value: non-finite number' ].
		^ f ].
	x isDictionary ifTrue: [
		d := Dictionary new.
		x keysAndValuesDo: [ :k :v |
			k isString ifFalse: [ CkError signal: 'not a JSON value: dictionary key ' , k printString ].
			d at: k asString put: (self toJson: v) ].
		^ d ].
	(x isCollection and: [ x isString not ]) ifTrue: [ ^ (x asArray collect: [ :e | self toJson: e ]) ].
	CkError signal: 'not a JSON value: ' , x class name
]

{ #category : #conversion }
CkJson class >> asciiJson: x [
	"Serialise to a pure-ASCII JSON line (non-ASCII as \uXXXX), so stdout never needs an encoding."

	| s |
	s := STONJSON toString: (self toJson: x).
	^ String streamContents: [ :out |
		  s do: [ :c |
			  | v |
			  v := c asInteger.
			  v < 128
				  ifTrue: [ out nextPut: c ]
				  ifFalse: [
					  v > 16rFFFF
						  ifTrue: [
							  | w |
							  w := v - 16r10000.
							  self putEscape: 16rD800 + (w >> 10) on: out.
							  self putEscape: 16rDC00 + (w bitAnd: 16r3FF) on: out ]
						  ifFalse: [ self putEscape: v on: out ] ] ] ]
]

{ #category : #conversion }
CkJson class >> putEscape: v on: out [

	out nextPutAll: '\u'.
	out nextPutAll: ((v printStringBase: 16) asLowercase padLeftTo: 4 with: $0)
]

{ #category : #comparison }
CkJson class >> same: a to: b [
	"Deep equality: key order ignored, numbers within 1e-9."

	(a isNumber and: [ b isNumber ]) ifTrue: [ ^ (a - b) abs <= 1.0e-9 ].
	(a isDictionary and: [ b isDictionary ]) ifTrue: [
		^ a size = b size and: [
			  a keys allSatisfy: [ :k |
				  (b includesKey: k) and: [ self same: (a at: k) to: (b at: k) ] ] ] ].
	(a isString or: [ b isString ]) ifTrue: [ ^ a isString and: [ b isString and: [ a asString = b asString ] ] ].
	(a isCollection and: [ b isCollection ]) ifTrue: [
		| x y |
		x := a asArray.
		y := b asArray.
		^ x size = y size and: [ (1 to: x size) allSatisfy: [ :i | self same: (x at: i) to: (y at: i) ] ] ].
	^ a = b
]

{ #category : #comparison }
CkJson class >> sameOutcome: a to: b [
	"Outcomes are equal when deep-equal JSON; the 'error' message is not compared."

	| x y |
	x := a copy.
	y := b copy.
	x removeKey: 'error' ifAbsent: [ nil ].
	y removeKey: 'error' ifAbsent: [ nil ].
	^ self same: x to: y
]

{ #category : #invariants }
CkJson class >> violation: s [
	"nil when the state (plain JSON) satisfies the three scenario invariants, else a description."

	| exp bud |
	s isDictionary ifFalse: [ ^ 'known-keys: state is not an object' ].
	s keysDo: [ :k | (k = 'expenses' or: [ k = 'budgets' ]) ifFalse: [ ^ 'known-keys: unexpected top-level key ' , k printString ] ].
	exp := s at: 'expenses' ifAbsent: [ nil ].
	exp ifNil: [ exp := #(  ) ].
	(exp isCollection and: [ exp isString not and: [ exp isDictionary not ] ]) ifFalse: [ ^ 'expenses-shape: expenses is not a list' ].
	exp do: [ :e |
		| amount category |
		e isDictionary ifFalse: [ ^ 'expenses-shape: an expense is not an object' ].
		e keysDo: [ :k | (#( 'amount' 'category' 'note' ) includes: k) ifFalse: [ ^ 'expenses-shape: unexpected key ' , k printString ] ].
		amount := e at: 'amount' ifAbsent: [ nil ].
		(amount isNumber and: [ amount > 0 ]) ifFalse: [ ^ 'expenses-shape: amount must be a number > 0, got ' , amount printString ].
		category := e at: 'category' ifAbsent: [ nil ].
		(category isString and: [ category isEmpty not ]) ifFalse: [ ^ 'expenses-shape: category must be a non-empty string, got ' , category printString ].
		e at: 'note' ifPresent: [ :n | n isString ifFalse: [ ^ 'expenses-shape: note must be a string' ] ] ].
	bud := s at: 'budgets' ifAbsent: [ nil ].
	bud ifNil: [ ^ nil ].
	bud isDictionary ifFalse: [ ^ 'budgets-shape: budgets is not an object' ].
	bud keysAndValuesDo: [ :k :v | (v isNumber and: [ v >= 0 ]) ifFalse: [ ^ 'budgets-shape: budget for ' , k printString , ' must be a number >= 0, got ' , v printString ] ].
	^ nil
]
