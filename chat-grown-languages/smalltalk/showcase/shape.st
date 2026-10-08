"Showcase part 2: the same world, seen from inside the image. Run by showcase/demo.sh with CK_DATA set,
 on the world.image that the kernel saved at clean shutdown."
| say k app before dev req ex entries |
say := [ :s | Stdio stdout nextPutAll: s asString; nextPut: Character lf; flush ].
say value: '== Part 2: the image itself =='.
say value: '# 1. The saved image already contains the world''s code (nothing loaded from world.json yet):'.
say value: '   ExpenseApp selectors = ' , ExpenseApp selectors sorted printString.
say value: '   ExpenseApp >> #over_budget sourceCode ='.
say value: (ExpenseApp >> #over_budget) sourceCode.
k := CkKernel new.
k dataDir: (Smalltalk os environment at: 'CK_DATA').
k load.
app := k liveApp.
say value: '# 2. World state resumed from world.json into the live instance: ' , (STONJSON toString: (CkJson toJson: app state)).
say value: '# 3. Change the SHAPE of the state holder: add an instance variable to the live class.'.
say value: '   ExpenseBase instVarNames before = ' , ExpenseBase instVarNames printString.
req := Dictionary new at: 'op' put: 'develop'; at: 'generation' put: 5; at: 'intent' put: 'remember'; at: 'scope' put: #('count_categories');
  at: 'forms' put: #('count_categories
	lastCount := self by_category size.
	^ lastCount'); at: 'examples' put: #(); at: 'asked' put: (Dictionary new at: 'message' put: 99; at: 'text' put: 'remember how many categories'; yourself); yourself.
dev := k dispatch: req.
say value: '   a form that uses the not-yet-existing variable is refused: ' , (STONJSON toString: (CkJson toJson: dev)).
before := app state.
ExpenseBase addInstVarNamed: 'lastCount'.
say value: '   after addInstVarNamed: instVarNames = ' , ExpenseBase instVarNames printString.
say value: '   the LIVE instance was migrated by the image: same object? ' , (app == k liveApp) printString , ', state kept (identical)? ' , (app state == before) printString , ', new slot = ' , (app instVarNamed: 'lastCount') printString.
dev := k dispatch: (req at: 'generation' put: 5; yourself).
say value: '   the same form now passes the gates: ' , (STONJSON toString: (CkJson toJson: dev)).
ex := k dispatch: (Dictionary new at: 'op' put: 'execute'; at: 'call' put: (Dictionary new at: 'fn' put: 'count_categories'; at: 'args' put: #(); yourself); at: 'request_id' put: 'shape-1'; yourself).
say value: '   executing it on the existing instance: ' , (STONJSON toString: (CkJson toJson: ex)) , ' ; the slot now holds ' , (app instVarNamed: 'lastCount') printString.
say value: '# 4. Epicea, the image''s change log, ExpenseApp method changes of this session (newest first;
#    the ExpenseCandidate entries are the scratch class rebuilt by every try / develop and are not shown):'.
entries := OrderedCollection new.
EpMonitor current log priorEntriesFromHeadDo: [ :e | entries add: e content ].
(entries select: [ :c | c class name beginsWith: 'EpMethod' ]) do: [ :c | c behaviorAffectedName = 'ExpenseApp' ifTrue: [ say value: '   ' , c class name , ' ' , ((c respondsTo: #behaviorAffectedName) ifTrue: [ c behaviorAffectedName asString ] ifFalse: [ '' ]) , ' ' , ((c respondsTo: #methodAffected) ifTrue: [ c methodAffected selector asString ] ifFalse: [ '' ]) ] ].
say value: '# 5. Revert the newest method change through Epicea (owner level, outside the kernel, so the kernel''s own record is now one method ahead of the image):'.
(entries detect: [ :c | c class name = #EpMethodAddition and: [ c methodAffected selector = #count_categories ] ]) asRevertedCodeChange applyCodeChange.
say value: '   count_categories understood after revert? ' , (ExpenseApp canUnderstand: #count_categories) printString.
say value: '# 6. The .changes file holds the source of every method compiled in this world (tail):'.
say value: (((FileLocator workingDirectory / 'world.changes') binaryReadStream contents last: 700) asString).
