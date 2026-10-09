"
The kernel: a JSON-lines server around one live image. The world is
 - code: Dictionary selector -> source, compiled into the live class ExpenseApp (protocol 'app');
 - state: the instance variable of the one live ExpenseApp;
 - the change history (revisions, examples, traces, request results), persisted in <data-dir>/world.json after every change.
"
Class {
	#name : #CkKernel,
	#superclass : #Object,
	#instVars : [
		'dataDir',
		'generation',
		'revisions',
		'current',
		'functionRev',
		'examples',
		'traces',
		'requests',
		'code',
		'liveApp'
	],
	#category : #ChatKernel
}

{ #category : #running }
CkKernel class >> runFromEnvironment [

	| k |
	k := self new.
	CkJson scenario: (Smalltalk os environment at: 'SCENARIO' ifAbsent: [ 'expenses' ]).
	k dataDir: (Smalltalk os environment at: 'CK_DATA').
	k load.
	k serve.
	^ k
]

{ #category : #running }
CkKernel class >> shutdown [
	"Clean shutdown: snapshot the world image next to world.json, then quit."

	Smalltalk snapshot: true andQuit: true
]

{ #category : #accessing }
CkKernel >> dataDir: aString [

	dataDir := aString
]

{ #category : #accessing }
CkKernel >> liveApp [

	^ liveApp
]

{ #category : #accessing }
CkKernel >> code [

	^ code
]

{ #category : #initialization }
CkKernel >> initialize [

	super initialize.
	generation := 0.
	revisions := OrderedCollection new.
	current := nil.
	functionRev := Dictionary new.
	examples := OrderedCollection new.
	traces := OrderedCollection new.
	requests := Dictionary new.
	code := Dictionary new.
	liveApp := ExpenseApp new.
	liveApp state: Dictionary new
]

{ #category : #io }
CkKernel >> readLine [
	"One line of stdin as a String, or nil at end of input."

	| bytes |
	bytes := ByteArray streamContents: [ :s |
		         | b |
		         [ (b := Stdio stdin next) notNil and: [ b ~= 10 ] ] whileTrue: [ s nextPut: b asInteger ] ].
	(bytes isEmpty and: [ Stdio stdin atEnd ]) ifTrue: [ ^ nil ].
	^ bytes utf8Decoded
]

{ #category : #io }
CkKernel >> writeLine: aDictionary [

	Stdio stdout nextPutAll: (CkJson asciiJson: aDictionary); nextPut: Character lf; flush
]

{ #category : #io }
CkKernel >> serve [

	| line |
	[ (line := self readLine) notNil ] whileTrue: [ self writeLine: (self handle: line) ].
	self class shutdown
]

{ #category : #io }
CkKernel >> errorResponse: e [

	^ Dictionary new
		  at: 'error' put: ((e messageText ifNil: [ e description ]) ifEmpty: [ e class name ]);
		  yourself
]

{ #category : #io }
CkKernel >> handle: line [

	^ [
	  | req |
	  line trimBoth isEmpty ifTrue: [ CkError signal: 'empty request line' ].
	  req := STONJSON fromString: line.
	  req isDictionary ifFalse: [ CkError signal: 'a request must be a JSON object' ].
	  self dispatch: (CkJson fromJson: req) ]
		  on: Exception
		  do: [ :e | e return: (self errorResponse: e) ]
]

{ #category : #io }
CkKernel >> dispatch: req [

	| op |
	op := req at: 'op' ifAbsent: [ CkError signal: 'missing op' ].
	op = 'observe' ifTrue: [ ^ self opObserve ].
	op = 'try' ifTrue: [ ^ self opTry: req ].
	op = 'develop' ifTrue: [ ^ self opDevelop: req ].
	op = 'execute' ifTrue: [ ^ self opExecute: req ].
	op = 'rollback' ifTrue: [ ^ self opRollback: req ].
	op = 'why' ifTrue: [ ^ self opWhy: req ].
	op = 'changes' ifTrue: [ ^ self opChanges: req ].
	op = 'inspect' ifTrue: [ ^ self opInspect: req ].
	CkError signal: 'unknown op ' , op printString
]

{ #category : #sandbox }
CkKernel >> guard: aBlock [
	"Run aBlock in its own process with a 1 s limit. Answer {#ok. value} / {#error. text} / {#timeout}.
	 A runaway process is terminated, so a loop cannot hang the VM."

	| result sem proc |
	sem := Semaphore new.
	proc := [
	        result := [ { #ok. aBlock value } ]
		                  on: Exception
		                  do: [ :e |
			                  e return: { #error. ((e messageText ifNil: [ e description ]) ifEmpty: [ e class name ]) } ].
	        sem signal ] forkAt: Processor userBackgroundPriority.
	(sem waitTimeoutMilliseconds: 1000) ifTrue: [
		proc terminate.
		^ { #timeout } ].
	^ result
]

{ #category : #sandbox }
CkKernel >> selectorFor: name arity: n in: aClass [

	^ aClass selectors
		  detect: [ :s | s numArgs = n and: [ (s copyUpTo: $:) = name ] ]
		  ifNone: [ nil ]
]

{ #category : #sandbox }
CkKernel >> invoke: call on: app [
	"Dispatch a call {fn, args} onto the method named fn with that many arguments. Answer {value. stateJson}."

	| fn args sel v st |
	fn := call at: 'fn' ifAbsent: [ CkError signal: 'call without fn' ].
	args := (call at: 'args' ifAbsent: [ #(  ) ]) collect: [ :a | CkJson fromJson: a ].
	sel := self selectorFor: fn arity: args size in: app class.
	sel ifNil: [ CkError signal: 'no function ' , fn , ' with ' , args size printString , ' argument(s)' ].
	v := app perform: sel withArguments: args asArray.
	v == app ifTrue: [ v := nil ].
	v := CkJson toJson: v.
	st := CkJson toJson: app state.
	^ { v. st }
]

{ #category : #sandbox }
CkKernel >> runCalls: calls on: app [
	"One outcome (PROTOCOL.md): each call is a transaction on app's state."

	| value |
	value := nil.
	calls do: [ :c |
		| before r |
		before := CkJson toJson: app state.
		r := self guard: [ self invoke: c on: app ].
		r first == #ok ifFalse: [
			app state: (CkJson fromJson: before).
			^ r first == #timeout
				  ifTrue: [ Dictionary new at: 'timeout' put: true; yourself ]
				  ifFalse: [
					  Dictionary new
						  at: 'throws' put: true;
						  at: 'error' put: r second;
						  at: 'state' put: before;
						  yourself ] ].
		value := r second first.
		app state: (CkJson fromJson: r second second) ].
	^ Dictionary new
		  at: 'value' put: value;
		  at: 'state' put: (CkJson toJson: app state);
		  yourself
]

{ #category : #sandbox }
CkKernel >> runQuestion: q on: aClass [

	| app fx |
	app := aClass new.
	fx := q at: 'fixture' ifAbsent: [ nil ].
	app state: (CkJson fromJson: (fx ifNil: [ Dictionary new ])).
	^ self runCalls: (q at: 'calls' ifAbsent: [ #(  ) ]) on: app
]

{ #category : #candidate }
CkKernel >> nameOf: selector [

	^ (selector copyUpTo: $:) asString
]

{ #category : #candidate }
CkKernel >> codeFrom: base forms: forms removes: removes [
	"The proposed code map (selector -> source) and the infos of the new forms. Static gate on every form."

	| new infos seen |
	new := base copy.
	removes do: [ :n | (new keys select: [ :s | (self nameOf: s) = n ]) do: [ :s | new removeKey: s ] ].
	infos := forms collect: [ :f | CkGate check: f in: ExpenseCandidate ].
	seen := Set new.
	infos do: [ :i |
		(seen includes: (i at: 2) -> (i at: 3)) ifTrue: [ CkError signal: 'two forms define ' , (i at: 2) , ' with ' , (i at: 3) printString , ' argument(s)' ].
		seen add: (i at: 2) -> (i at: 3).
		(new keys select: [ :s | (self nameOf: s) = (i at: 2) and: [ s numArgs = (i at: 3) ] ]) do: [ :s | new removeKey: s ].
		new at: (i at: 1) put: (i at: 4) ].
	^ new
]

{ #category : #candidate }
CkKernel >> buildCandidate: codeMap [
	"Rebuild the scratch class from a code map; refuse code that does not compile or sends to unknown functions."

	| missing |
	ExpenseCandidate selectors do: [ :s | ExpenseCandidate removeSelector: s ].
	codeMap keysAndValuesDo: [ :sel :src |
		[ ExpenseCandidate compile: src classified: 'app' ]
			on: Exception
			do: [ :e | CkError signal: 'compile error in ' , sel printString , ': ' , (e messageText ifNil: [ e class name ]) ].
		(ExpenseCandidate includesSelector: sel) ifFalse: [ CkError signal: 'compile error in ' , sel printString ] ].
	codeMap keysAndValuesDo: [ :sel :src |
		missing := CkGate missingSelfSends: src in: ExpenseCandidate.
		missing isEmpty ifFalse: [
			CkError signal: sel printString , ' calls missing function(s): ' , (', ' join: (missing collect: #printString)) ] ].
	^ ExpenseCandidate
]

{ #category : #live }
CkKernel >> installCode: newCode [
	"Compile the difference into the live class. Callers already running see the new methods at once."

	| changed |
	changed := Set new.
	ExpenseApp selectors do: [ :s |
		(newCode includesKey: s) ifFalse: [
			ExpenseApp removeSelector: s.
			changed add: (self nameOf: s) ] ].
	newCode keysAndValuesDo: [ :s :src |
		((ExpenseApp includesSelector: s) and: [ (ExpenseApp >> s) sourceCode = src ]) ifFalse: [
			ExpenseApp compile: src classified: 'app'.
			changed add: (self nameOf: s) ] ].
	code := newCode copy.
	^ changed
]

{ #category : #live }
CkKernel >> functionsMap [
	"snake_case name -> source (several arities: joined, fewest arguments first)."

	| out |
	out := Dictionary new.
	(code keys sorted: [ :a :b | (self nameOf: a) < (self nameOf: b) or: [ (self nameOf: a) = (self nameOf: b) and: [ a numArgs <= b numArgs ] ] ]) do: [ :s |
		| n |
		n := self nameOf: s.
		out at: n put: ((out at: n ifAbsent: [ nil ]) ifNil: [ code at: s ] ifNotNil: [ :old | old , String lf , String lf , (code at: s) ]) ].
	^ out
]

{ #category : #ops }
CkKernel >> opObserve [

	^ Dictionary new
		  at: 'generation' put: generation;
		  at: 'revision' put: current;
		  at: 'functions' put: self functionsMap;
		  at: 'state' put: (CkJson toJson: liveApp state);
		  yourself
]

{ #category : #ops }
CkKernel >> opTry: req [

	| cand outcomes |
	cand := [ self buildCandidate: (self codeFrom: code forms: (req at: 'forms' ifAbsent: [ #(  ) ]) removes: (req at: 'removes' ifAbsent: [ #(  ) ])) ]
		        on: CkError
		        do: [ :e | ^ Dictionary new at: 'ok' put: false; at: 'error' put: e messageText; yourself ].
	outcomes := (req at: 'questions' ifAbsent: [ #(  ) ]) collect: [ :q | self runQuestion: q on: cand ].
	^ Dictionary new
		  at: 'ok' put: true;
		  at: 'outcomes' put: outcomes asArray;
		  yourself
]

{ #category : #ops }
CkKernel >> opWhy: req [

	| rid rev |
	rid := functionRev at: (req at: 'fn' ifAbsent: [ CkError signal: 'why needs fn' ]) ifAbsent: [ ^ nil ].
	rev := revisions detect: [ :r | (r at: 'id') = rid ].
	^ Dictionary new
		  at: 'revision' put: rid;
		  at: 'intent' put: (rev at: 'intent');
		  at: 'asked' put: (rev at: 'asked');
		  yourself
]

{ #category : #gates }
CkKernel >> show: x [
	"Compact JSON text for messages."

	^ [ STONJSON toString: (CkJson toJson: x) ] on: Error do: [ :e | x printString ]
]

{ #category : #gates }
CkKernel >> rejected: layer detail: detail [

	^ Dictionary new at: 'layer' put: layer; at: 'detail' put: detail; yourself
]

{ #category : #gates }
CkKernel >> sameCall: a and: b [

	^ (CkJson same: (a at: 'fixture' ifAbsent: [ nil ]) to: (b at: 'fixture' ifAbsent: [ nil ])) and: [ CkJson same: (a at: 'calls') to: (b at: 'calls') ]
]

{ #category : #gates }
CkKernel >> activeExamples: new scope: scope [
	"Earlier examples stay in the ratchet unless every function they call is in this scope and this request restates the same question."

	^ examples reject: [ :old |
		  ((old at: 'calls') allSatisfy: [ :c | scope includes: (c at: 'fn') ]) and: [ new anySatisfy: [ :n | self sameCall: n and: old ] ] ]
]

{ #category : #gates }
CkKernel >> gate: cand scope: scope newExamples: new [
	"Run ratchet (unless 'new' is nil), invariants and trace replay on the candidate. Answer the list of failures (empty = pass)."

	| failed all outcomes live |
	failed := OrderedCollection new.
	live := CkJson violation: (CkJson toJson: liveApp state).
	live ifNotNil: [ failed add: (self rejected: 'invariants' detail: 'live state: ' , live) ].
	all := new ifNil: [ #(  ) ] ifNotNil: [ (self activeExamples: new scope: scope) , new ].
	outcomes := OrderedCollection new.
	all do: [ :ex |
		| out |
		out := self runQuestion: ex on: cand.
		(out includesKey: 'timeout') ifTrue: [
			failed add: (self rejected: 'sandbox' detail: 'timed out (1 s): ' , (self show: (ex at: 'calls'))).
			^ failed ].
		(CkJson sameOutcome: out to: (ex at: 'expect'))
			ifFalse: [ failed add: (self rejected: 'ratchet' detail: (self show: (ex at: 'calls')) , ' gave ' , (self show: out) , ', expected ' , (self show: (ex at: 'expect'))) ].
		outcomes add: out ].
	outcomes do: [ :out |
		(CkJson violation: (out at: 'state' ifAbsent: [ nil ])) ifNotNil: [ :v |
			failed add: (self rejected: 'invariants' detail: 'after an example: ' , v) ] ].
	traces do: [ :t |
		| app r c out |
		app := cand new.
		app state: (CkJson fromJson: (t at: 'before')).
		c := t at: 'call'.
		out := self runCalls: { c } on: app.
		(out includesKey: 'timeout') ifTrue: [
			failed add: (self rejected: 'sandbox' detail: 'trace timed out: ' , (self show: c)).
			^ failed ].
		(out includesKey: 'throws') ifTrue: [
			failed add: (self rejected: 'traces' detail: 'recorded call ' , (self show: c) , ' now throws: ' , (out at: 'error')) ] ifFalse: [
			((scope includes: (c at: 'fn')) or: [ CkJson same: (out at: 'value') to: (t at: 'value') ]) ifFalse: [
				failed add: (self rejected: 'traces' detail: 'recorded call ' , (self show: c) , ' changed value from ' , (self show: (t at: 'value')) , ' to ' , (self show: (out at: 'value')) , ' outside the declared scope') ].
			(CkJson violation: (out at: 'state')) ifNotNil: [ :v | failed add: (self rejected: 'invariants' detail: 'replaying a trace: ' , v) ] ] ].
	^ failed
]

{ #category : #gates }
CkKernel >> codeId: map [

	| keys |
	keys := map keys sorted.
	^ (MD5 hashMessage: (String streamContents: [ :s | keys do: [ :k | s nextPutAll: k; nextPut: Character lf; nextPutAll: (map at: k); nextPut: Character lf ] ]) utf8Encoded) hex first: 12
]

{ #category : #gates }
CkKernel >> dataId [

	^ (MD5 hashMessage: (STONJSON toString: (CkJson toJson: liveApp state)) utf8Encoded) hex first: 12
]

{ #category : #gates }
CkKernel >> record: intent scope: scope asked: asked parent: parent code: newCode changed: changed [
	"Install, bump the generation, write the revision, persist."

	| id rev |
	id := 'rev-' , ((revisions size + 1) printPaddedWith: $0 to: 4).
	rev := Dictionary new
		       at: 'id' put: id;
		       at: 'parent' put: parent;
		       at: 'code_id' put: (self codeId: newCode);
		       at: 'data_id' put: self dataId;
		       at: 'at' put: DateAndTime now asString;
		       at: 'intent' put: intent;
		       at: 'scope' put: scope;
		       at: 'asked' put: asked;
		       at: 'code' put: (CkJson toJson: newCode);
		       at: 'changed' put: (changed collect: #asString) asSortedCollection asArray;
		       yourself.
	revisions add: rev.
	current := id.
	generation := generation + 1.
	changed do: [ :n | functionRev at: n put: id ].
	^ id
]

{ #category : #ops }
CkKernel >> opDevelop: req [

	| gen cand scope new failed newCode changed parent id asked |
	gen := req at: 'generation' ifAbsent: [ nil ].
	gen = generation ifFalse: [
		^ Dictionary new at: 'status' put: 'stale'; at: 'generation' put: generation; yourself ].
	scope := req at: 'scope' ifAbsent: [ #(  ) ].
	new := req at: 'examples' ifAbsent: [ #(  ) ].
	newCode := [ self codeFrom: code forms: (req at: 'forms' ifAbsent: [ #(  ) ]) removes: (req at: 'removes' ifAbsent: [ #(  ) ]) ]
		           on: CkError
		           do: [ :e | ^ self rejection: { self rejected: 'static' detail: e messageText } ].
	cand := [ self buildCandidate: newCode ]
		        on: CkError
		        do: [ :e | ^ self rejection: { self rejected: 'static' detail: e messageText } ].
	failed := self gate: cand scope: scope newExamples: new.
	failed isEmpty ifFalse: [ ^ self rejection: failed ].
	parent := current.
	changed := self installCode: newCode.
	asked := req at: 'asked' ifAbsent: [ nil ].
	id := self record: (req at: 'intent' ifAbsent: [ '' ]) scope: scope asked: asked parent: parent code: newCode changed: changed.
	new do: [ :ex | (examples reject: [ :o | self sameCall: o and: ex ]) in: [ :keep | examples := keep asOrderedCollection ]. examples add: ex ].
	self persist.
	^ Dictionary new
		  at: 'status' put: 'accepted';
		  at: 'revision' put: id;
		  at: 'generation' put: generation;
		  at: 'failed' put: #(  );
		  yourself
]

{ #category : #ops }
CkKernel >> rejection: failed [

	^ Dictionary new
		  at: 'status' put: 'rejected';
		  at: 'generation' put: generation;
		  at: 'failed' put: failed asArray;
		  yourself
]

{ #category : #ops }
CkKernel >> opExecute: req [

	| rid call out resp before viol |
	rid := req at: 'request_id' ifAbsent: [ nil ].
	rid ifNotNil: [
		requests at: rid ifPresent: [ :r |
			^ r copy at: 'replayed' put: true; yourself ] ].
	call := req at: 'call' ifAbsent: [ CkError signal: 'execute needs a call' ].
	before := CkJson toJson: liveApp state.
	out := self runCalls: { call } on: liveApp.
	resp := Dictionary new.
	(out includesKey: 'timeout') ifTrue: [ resp at: 'ok' put: false; at: 'error' put: 'timed out (1 s)' ] ifFalse: [
		(out includesKey: 'throws') ifTrue: [ resp at: 'ok' put: false; at: 'error' put: (out at: 'error') ] ifFalse: [
			viol := CkJson violation: (out at: 'state').
			viol
				ifNotNil: [
					liveApp state: (CkJson fromJson: before).
					resp at: 'ok' put: false; at: 'error' put: 'refused, it would break an invariant: ' , viol ]
				ifNil: [
					traces add: (Dictionary new at: 'before' put: before; at: 'call' put: call; at: 'value' put: (out at: 'value'); yourself).
					resp at: 'ok' put: true; at: 'value' put: (out at: 'value') ] ] ].
	resp at: 'replayed' put: false.
	rid ifNotNil: [ requests at: rid put: resp ].
	self persist.
	^ resp
]

{ #category : #ops }
CkKernel >> opRollback: req [
	"Code only: restore an earlier revision's code, keep today's data. Refused when it breaks an invariant or a trace."

	| target tid base newCode cand changedNames failed parent id |
	current ifNil: [ ^ self refuse: 'nothing to roll back to' ].
	tid := req at: 'revision' ifAbsent: [ nil ].
	tid ifNil: [ tid := (revisions detect: [ :r | (r at: 'id') = current ]) at: 'parent' ].
	tid ifNil: [ ^ self refuse: 'no earlier revision' ].
	target := revisions detect: [ :r | (r at: 'id') = tid ] ifNone: [ ^ self refuse: 'unknown revision ' , tid printString ].
	base := (target at: 'code') asDictionary.
	newCode := Dictionary new.
	(req at: 'fn' ifAbsent: [ nil ])
		ifNil: [ base keysAndValuesDo: [ :k :v | newCode at: k asSymbol put: v ] ]
		ifNotNil: [ :fn |
			"one function only: keep the current code, swap in that function's methods from the target revision"
			code keysAndValuesDo: [ :k :v | (self nameOf: k) = fn ifFalse: [ newCode at: k put: v ] ].
			base keysAndValuesDo: [ :k :v | (self nameOf: k) = fn ifTrue: [ newCode at: k asSymbol put: v ] ] ].
	cand := [ self buildCandidate: newCode ] on: CkError do: [ :e | ^ self refuse: 'old code does not load: ' , e messageText ].
	changedNames := Set new.
	(code keys , newCode keys) do: [ :s | (code at: s ifAbsent: [ nil ]) = (newCode at: s ifAbsent: [ nil ]) ifFalse: [ changedNames add: (self nameOf: s) ] ].
	failed := self gate: cand scope: changedNames asArray newExamples: nil.
	failed isEmpty ifFalse: [ ^ self refuse: 'refused by ' , (failed first at: 'layer') , ': ' , (failed first at: 'detail') ].
	parent := target at: 'parent'.
	self installCode: newCode.
	id := self record: 'rollback' , ((req at: 'fn' ifAbsent: [ nil ]) ifNil: [ '' ] ifNotNil: [ :f | ' of ' , f ]) , ' to ' , tid scope: changedNames asArray asSortedCollection asArray asked: (target at: 'asked') parent: parent code: newCode changed: changedNames.
	self persist.
	^ Dictionary new
		  at: 'ok' put: true;
		  at: 'revision' put: tid;
		  at: 'generation' put: generation;
		  at: 'new_revision' put: id;
		  yourself
]

{ #category : #ops }
CkKernel >> opInspect: req [
	"Read-only operator views of the live image (fixed queries, no code evaluation):
	 object, senders, who, history, method."

	| what arg |
	what := req at: 'what' ifAbsent: [ CkError signal: 'inspect needs what' ].
	arg := req at: 'arg' ifAbsent: [ nil ].
	what = 'object' ifTrue: [
		| calls |
		calls := liveApp state at: 'calls' ifAbsent: [ #(  ) ].
		^ Dictionary new
			  at: 'ok' put: true;
			  at: 'object' put: liveApp printString;
			  at: 'class' put: liveApp class name asString;
			  at: 'superclass' put: liveApp class superclass name asString;
			  at: 'instVars' put: liveApp class allInstVarNames asArray;
			  at: 'state keys' put: liveApp state keys sorted;
			  at: 'calls recorded' put: calls size;
			  at: 'methods' put: (ExpenseApp selectors sorted collect: #asString) asArray;
			  yourself ].
	what = 'senders' ifTrue: [
		^ Dictionary new
			  at: 'ok' put: true;
			  at: 'selector' put: arg;
			  at: 'senders' put: ((ExpenseApp selectors select: [ :sel | (ExpenseApp >> sel) sendsSelector: arg asSymbol ]) sorted collect: #asString) asArray;
			  yourself ].
	what = 'who' ifTrue: [
		| by |
		by := Dictionary new.
		(liveApp state at: 'calls' ifAbsent: [ #(  ) ]) do: [ :c |
			| row |
			row := by at: (c at: 'key') ifAbsentPut: [ Dictionary new at: 'calls' put: 0; at: 'tokens' put: 0; at: 'models' put: Set new; yourself ].
			row at: 'calls' put: (row at: 'calls') + 1.
			row at: 'tokens' put: (row at: 'tokens') + (c at: 'tokens').
			(row at: 'models') add: (c at: 'model') ].
		by valuesDo: [ :row | row at: 'models' put: (row at: 'models') asArray sorted ].
		^ Dictionary new at: 'ok' put: true; at: 'keys' put: by; yourself ].
	what = 'history' ifTrue: [ ^ Dictionary new at: 'ok' put: true; at: 'history' put: self history lines asArray; yourself ].
	what = 'method' ifTrue: [
		| sel |
		sel := ExpenseApp selectors detect: [ :x | (self nameOf: x) = arg ] ifNone: [ ^ self refuse: 'no method ' , arg printString ].
		^ Dictionary new
			  at: 'ok' put: true;
			  at: 'selector' put: sel asString;
			  at: 'source' put: (ExpenseApp >> sel) sourceCode;
			  at: 'protocol' put: (ExpenseApp >> sel) protocol asString;
			  at: 'stamp' put: (ExpenseApp >> sel) timeStamp asString;
			  yourself ].
	CkError signal: 'inspect: unknown view ' , what printString
]

{ #category : #accessing }
CkKernel >> history [
	"One line per revision: id, time, intent, the functions it changed, and the chat message that asked."

	^ String streamContents: [ :out |
		  revisions do: [ :r |
			  out
				  nextPutAll: (r at: 'id');
				  nextPutAll: '  ';
				  nextPutAll: ((r at: 'at' ifAbsent: [ '' ]) copyFrom: 12 to: 19);
				  nextPutAll: '  ';
				  nextPutAll: (r at: 'intent');
				  nextPutAll: '  changed ';
				  nextPutAll: (r at: 'changed') asArray printString;
				  nextPutAll: '  asked #';
				  nextPutAll: ((r at: 'asked') ifNil: [ '-' ] ifNotNil: [ :a | (a at: 'message') printString ]);
				  nextPutAll: ' ';
				  nextPutAll: ((r at: 'asked') ifNil: [ '' ] ifNotNil: [ :a | (a at: 'text') printString ]);
				  nextPut: Character lf ] ]
]

{ #category : #ops }
CkKernel >> refuse: msg [

	^ Dictionary new at: 'ok' put: false; at: 'error' put: msg; yourself
]

{ #category : #ops }
CkKernel >> opChanges: req [
	"The image's own record of compiled methods (Epicea), oldest first, for the live class only."

	| n entries |
	n := req at: 'limit' ifAbsent: [ 20 ].
	entries := OrderedCollection new.
	EpMonitor current log priorEntriesFromHeadDo: [ :entry |
		| c |
		c := entry content.
		((#( EpMethodAddition EpMethodModification EpMethodRemoval ) includes: c class name) and: [ c behaviorAffectedName = 'ExpenseApp' ]) ifTrue: [
			entries addFirst: (Dictionary new
					 at: 'kind' put: (c class name allButFirst: 2) asString;
					 at: 'class' put: c behaviorAffectedName asString;
					 at: 'selector' put: c methodAffected selector asString;
					 yourself) ] ].
	^ Dictionary new
		  at: 'ok' put: true;
		  at: 'total' put: entries size;
		  at: 'entries' put: (entries last: (n min: entries size)) asArray;
		  yourself
]

{ #category : #persistence }
CkKernel >> worldFile [

	^ (dataDir , '/world.json') asFileReference
]

{ #category : #persistence }
CkKernel >> persist [
	"Write-ahead world record, atomically (temp file + rename)."

	| world tmp |
	world := Dictionary new
		         at: 'generation' put: generation;
		         at: 'current' put: current;
		         at: 'revisions' put: revisions;
		         at: 'functionRev' put: functionRev;
		         at: 'examples' put: examples;
		         at: 'traces' put: traces;
		         at: 'requests' put: requests;
		         at: 'state' put: liveApp state;
		         yourself.
	tmp := (dataDir , '/world.json.tmp') asFileReference.
	tmp ensureDelete.
	tmp binaryWriteStreamDo: [ :s | s nextPutAll: (CkJson asciiJson: world) asByteArray ].
	self worldFile ensureDelete.
	tmp renameTo: 'world.json'
]

{ #category : #persistence }
CkKernel >> load [
	"Resume the world from world.json (if any): reconcile the image's methods with the recorded code."

	| w f |
	f := self worldFile.
	f exists ifFalse: [ ^ self ].
	w := STONJSON fromString: f binaryReadStream contents utf8Decoded.
	generation := w at: 'generation'.
	current := w at: 'current'.
	revisions := (w at: 'revisions') asOrderedCollection.
	functionRev := (CkJson fromJson: (w at: 'functionRev')).
	examples := (w at: 'examples') asOrderedCollection.
	traces := (w at: 'traces') asOrderedCollection.
	requests := CkJson fromJson: (w at: 'requests').
	liveApp state: (CkJson fromJson: (w at: 'state')).
	current ifNotNil: [
		| map |
		map := Dictionary new.
		((revisions detect: [ :r | (r at: 'id') = current ]) at: 'code') keysAndValuesDo: [ :k :v | map at: k asSymbol put: v ].
		self installCode: map ]
]
