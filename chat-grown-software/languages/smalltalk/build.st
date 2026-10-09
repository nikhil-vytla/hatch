| ref |
ref := TonelReader on: (FileLocator workingDirectory / 'src') asFileReference fileName: 'ChatKernel'.
ref loadDefinitions.
(MCSnapshot fromDefinitions: ref definitions) install.
Stdio stdout nextPutAll: 'loaded ', ref definitions size printString; nextPut: Character lf; flush.
Smalltalk snapshot: true andQuit: true.
