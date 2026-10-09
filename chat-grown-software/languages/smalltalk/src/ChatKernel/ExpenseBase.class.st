"
Kernel part of the app: holds the state (a Dictionary with String keys). Everything a chat turn adds
lives in the subclasses ExpenseApp (live) and ExpenseCandidate (scratch for try / gates).
These methods are in the 'kernel' protocol and cannot be redefined by a form.
"
Class {
	#name : #ExpenseBase,
	#superclass : #Object,
	#instVars : [
		'state'
	],
	#category : #ChatKernel
}

{ #category : #kernel }
ExpenseBase >> state [

	^ state
]

{ #category : #kernel }
ExpenseBase >> state: aDictionary [

	state := aDictionary
]
