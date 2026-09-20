"""Synthetic speech, local Whisper inference. Weights stay in user cache."""
import json, time, hashlib
from pathlib import Path
import mlx_whisper
import soundfile as sf
root=Path(__file__).resolve().parent
model='mlx-community/whisper-base.en-mlx'
rows=[]
for path in sorted((root/'assets/speech').glob('*.wav')):
    audio,sr=sf.read(path,dtype='float32')
    assert sr==16000
    t=time.perf_counter()
    result=mlx_whisper.transcribe(audio,path_or_hf_repo=model,language='en',temperature=0,condition_on_previous_text=False)
    rows.append({'id':path.stem.split('-',1)[1],'audio':'speech/'+path.name,'audioSha256':hashlib.sha256(path.read_bytes()).hexdigest(),'text':result['text'].strip(),'seconds':len(audio)/sr,'transcriptionMs':round((time.perf_counter()-t)*1000),'segments':result['segments']})
    print(path.name,repr(result['text'].strip()))
(root/'speech-transcripts.json').write_text(json.dumps({'source':'macOS say synthetic speech; no user microphone','recognizer':'mlx-whisper','model':model,'inference':'local after downloading model weights','turns':rows},indent=2)+'\n')
