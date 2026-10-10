"
The static gate. A form must be EXACTLY ONE instance-side method definition, whose AST is walked:
 - the selector's first keyword is the snake_case function name; it must not shadow anything Object or the kernel understands;
 - no pragmas (so no primitives), no class-side or Tonel-style class changes;
 - every variable is an argument, temporary, instance variable, self/super/true/false/nil, or a global from the allowlist;
 - no message from the forbidden list (reflection, compile, perform, become, processes...).
Sends to self whose selector the candidate class does not understand are 'missing functions' (checked once the candidate is compiled).
"
Class {
	#name : #CkGate,
	#superclass : #Object,
	#category : #ChatKernel
}

{ #category : #allowlist }
CkGate class >> allowedGlobals [

	^ #( OrderedCollection Dictionary OrderedDictionary Set Bag Array String Symbol Float Integer SmallInteger Number Fraction Character Association SortedCollection Interval Error ZeroDivide )
]

{ #category : #allowlist }
CkGate class >> forbiddenSelectors [

	^ #( instVarAt: instVarAt:put: instVarNamed: instVarNamed:put: become: becomeForward: becomeForward:copyHash: primitiveFailed halt inspect yourself:
	     class: superclass methodDict selectors changeClassTo: adoptInstance: asClass environment systemNavigation
	     terminate suspend resume newProcess yield value:value:value:value:value: )
]

{ #category : #allowlist }
CkGate class >> forbiddenPrefixes [

	^ #( compile evaluate perform become fork subclass basic primitive instVar addInstVar removeInstVar addSelector removeSelector removeFromSystem addClassVar removeClassVar instanceVariable classVariable rename install setSuperclass )
]

{ #category : #checking }
CkGate class >> stripHeader: src [
	"Tolerate 'ExpenseApp >> selector ...' headers; refuse class-side ones."

	| text i head |
	text := src trimBoth.
	i := text indexOfSubCollection: '>>'.
	i = 0 ifTrue: [ ^ text ].
	head := (text copyFrom: 1 to: i - 1) trimBoth.
	((head isEmpty not and: [ head first isUppercase ]) and: [ head allSatisfy: [ :c | c isAlphaNumeric or: [ c isSeparator ] ] ]) ifFalse: [ ^ text ].
	(head endsWith: ' class') ifTrue: [ CkError signal: 'class-side definitions are not allowed' ].
	^ (text copyFrom: i + 2 to: text size) trimBoth
]

{ #category : #checking }
CkGate class >> check: src in: aClass [
	"Answer an Array: selector, function name, arity, clean source. Signal CkError when refused."

	| text ast sel name |
	src isString ifFalse: [ CkError signal: 'a form must be a string of Smalltalk source' ].
	text := self stripHeader: src.
	ast := [ RBParser parseMethod: text ] on: Exception do: [ :e |
		       CkError signal: 'a form must be exactly one method definition (' , (e messageText ifNil: [ e class name ]) , ')' ].
	(ast isKindOf: RBMethodNode) ifFalse: [ CkError signal: 'a form must be exactly one method definition' ].
	ast pragmas isEmpty ifFalse: [ CkError signal: 'pragmas (including primitives) are not allowed' ].
	sel := ast selector.
	name := sel copyUpTo: $:.
	((name isEmpty not and: [ name first isLowercase ]) and: [ name allSatisfy: [ :c | c isAlphaNumeric or: [ c = $_ ] ] ]) ifFalse: [
		CkError signal: 'bad selector ' , sel printString , ': the first keyword must be the snake_case function name' ].
	(ExpenseBase canUnderstand: sel) ifTrue: [
		CkError signal: 'selector ' , sel printString , ' redefines a kernel / Object method' ].
	ast methodClass: aClass.
	ast doSemanticAnalysis.
	ast nodesDo: [ :n |
		n isVariable ifTrue: [ self checkVariable: n ].
		n isMessage ifTrue: [ self checkSend: n ] ].
	^ Array with: sel with: name with: sel numArgs with: text
]

{ #category : #checking }
CkGate class >> checkVariable: n [

	n isThisContextVariable ifTrue: [ CkError signal: 'thisContext is not allowed' ].
	(n isArgumentVariable or: [ n isTempVariable or: [ n isInstanceVariable or: [ n isSelfVariable or: [ n isSuperVariable or: [ n isPseudoVariable ] ] ] ] ]) ifTrue: [ ^ self ].
	n isGlobalVariable ifTrue: [
		(self allowedGlobals includes: n name asSymbol) ifTrue: [ ^ self ].
		CkError signal: 'global ' , n name , ' is not on the allowlist' ].
	n isUndeclaredVariable ifTrue: [ CkError signal: 'unknown variable ' , n name ].
	CkError signal: 'variable ' , n name , ' is not allowed'
]

{ #category : #checking }
CkGate class >> checkSend: n [
	| s |
	s := n selector.
	((self forbiddenSelectors includes: s) or: [ self forbiddenPrefixes anySatisfy: [ :p | s beginsWith: p ] ]) ifTrue: [
		CkError signal: 'message ' , s printString , ' is not allowed' ]
]

{ #category : #checking }
CkGate class >> missingSelfSends: source in: aClass [
	"Selectors sent to self/super in this source that aClass does not understand."

	| ast missing |
	ast := RBParser parseMethod: source.
	missing := OrderedCollection new.
	ast nodesDo: [ :n |
		(n isMessage and: [ n receiver isVariable and: [ n receiver name = 'self' or: [ n receiver name = 'super' ] ] ]) ifTrue: [
			(aClass canUnderstand: n selector) ifFalse: [ missing add: n selector ] ] ].
	^ missing
]
