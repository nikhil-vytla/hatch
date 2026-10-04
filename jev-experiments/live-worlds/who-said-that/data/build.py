"""
Builds the "Who said that?" scenarios from the AMI Meeting Corpus (CC BY 4.0, University of
Edinburgh and partners, https://groups.inf.ed.ac.uk/ami/corpus/). Each scenario is a 90 s window
of real meeting audio with the corpus's own word timings, speaker labels and topic segments.
"Two tables" puts two real meetings in one room with a phone on each table: a two-channel
recording where each channel is its own table at full level plus the other table 12 dB quieter
(the bleed a phone picks up from the next table). We cut, mix, normalise loudness and compress;
nothing else changes.

    AMI_DIR=<dir with manual/ and audio/> python3 build.py <out dir for public files> <scratch dir>

The AMI downloads are not committed: words and topics from ami_public_manual_1.6.2.zip,
<meeting>.Mix-Headset.wav from the AMI corpus mirror.
"""
import json
import os
import subprocess
import sys

sys.path.insert(0, os.path.dirname(__file__))
import ami  # noqa: E402

AMI_DIR = os.environ['AMI_DIR']
ami.M = os.path.join(AMI_DIR, 'manual')
AUDIO = os.path.join(AMI_DIR, 'audio')

TOPIC_NAMES = {
    'top.11': 'opening', 'top.12': 'closing', 'top.13': 'agenda and equipment', 'top.14': 'chitchat',
    'top.21': 'project specs and roles', 'top.211': 'costing', 'top.212': 'drawing exercise',
    'top.31': 'project budget', 'top.36': 'look and usability', 'top.37': 'finding it when misplaced', 'top.4': 'other',
}

# (meeting, start s, end s, stream, gain dB, conversation label). With stereo=True each part is
# one table's own channel, and every other part bleeds into it at BLEED_DB.
BLEED_DB = -12
SCENARIOS = {
    'design-meeting': dict(
        title='A design meeting',
        blurb='Four people in one meeting. The talk moves from the budget to ideas for the remote, then to its size.',
        parts=[('IS1009a', 380, 470, 'Mix-Headset', 0, 'The meeting')],
    ),
    'topic-change': dict(
        title='The topic changes',
        blurb='Three people discuss remote controls, then turn to what makes one good or bad.',
        parts=[('ES2008a', 480, 570, 'Mix-Headset', 0, 'The meeting')],
    ),
    'two-tables': dict(
        title='Two tables',
        blurb='Two real meetings in one room, a phone on each table. Each phone hears its own table, and the other one more quietly. Which words belong to which conversation?',
        stereo=True,
        parts=[('ES2002a', 480, 570, 'Mix-Headset', 0, 'Table 1'), ('IS1009a', 230, 320, 'Mix-Headset', 0, 'Table 2')],
    ),
}


# Development windows: other stretches of the same meetings, never shown or scored on the page.
# The decision weights were set by looking at these only.
DEV = {
    'dev-meeting-a': dict(title='dev', blurb='', parts=[('IS1009a', 560, 650, 'Mix-Headset', 0, 'The meeting')]),
    'dev-meeting-b': dict(title='dev', blurb='', parts=[('ES2002a', 300, 390, 'Mix-Headset', 0, 'The meeting')]),
    'dev-two-tables': dict(
        title='dev', blurb='', stereo=True,
        parts=[('IS1009a', 560, 650, 'Mix-Headset', 0, 'Table 1'), ('ES2008a', 600, 690, 'Mix-Headset', 0, 'Table 2')],
    ),
    # Windows with topic changes in them, and a second pair of tables (same meetings as the scored
    # one, other stretches), so changes are not tuned on one stereo window.
    'dev-topics-a': dict(title='dev', blurb='', parts=[('ES2008a', 640, 730, 'Mix-Headset', 0, 'The meeting')]),
    'dev-topics-b': dict(title='dev', blurb='', parts=[('ES2002a', 710, 800, 'Mix-Headset', 0, 'The meeting')]),
    'dev-topics-c': dict(title='dev', blurb='', parts=[('IS1009a', 490, 580, 'Mix-Headset', 0, 'The meeting')]),
    'dev-two-tables-b': dict(
        title='dev', blurb='', stereo=True,
        parts=[('ES2002a', 710, 800, 'Mix-Headset', 0, 'Table 1'), ('IS1009a', 100, 190, 'Mix-Headset', 0, 'Table 2')],
    ),
}


def topic_name(desc):
    return TOPIC_NAMES.get(desc, desc) or 'unlabelled'


def truth(meet, a, b, conv, channel=None):
    W = ami.words(meet)
    T = ami.topics(meet, W)
    out = []
    for w in sorted(W.values(), key=lambda w: w['s']):
        if w['punc'] or w['s'] < a or w['e'] > b:
            continue
        out.append(dict(
            text=w['t'], start=round(w['s'] - a, 2), end=round(w['e'] - a, 2),
            speaker=f"{meet}.{w['spk']}", conversation=conv, topic=topic_name(T.get(w['id'], ('', ''))[1]),
            # On one-microphone-per-table scenarios: the microphone at this speaker's table.
            **({} if channel is None else dict(channel=channel)),
        ))
    return out


def main(out_dir, scratch, which=SCENARIOS):
    os.makedirs(out_dir, exist_ok=True)
    os.makedirs(scratch, exist_ok=True)
    index = []
    for sid, sc in which.items():
        inputs, filters, words = [], [], []
        for i, (meet, a, b, stream, gain, conv) in enumerate(sc['parts']):
            inputs += ['-ss', str(a), '-t', str(b - a), '-i', os.path.join(AUDIO, f'{meet}.{stream}.wav')]
            filters.append(f'[{i}:a]loudnorm=I=-23:TP=-2,volume={gain}dB[a{i}]')
            words += truth(meet, a, b, conv, i if sc.get('stereo') else None)
        n = len(sc['parts'])
        if sc.get('stereo'):
            # Channel c: table c at full level, every other table at BLEED_DB.
            splits = ''.join(f'[a{i}]asplit={n}' + ''.join(f'[a{i}c{c}]' for c in range(n)) + ';' for i in range(n))
            chans = []
            for c in range(n):
                gains = ';'.join(f'[a{i}c{c}]volume={0 if i == c else BLEED_DB}dB[g{i}c{c}]' for i in range(n))
                chans.append(gains + ';' + ''.join(f'[g{i}c{c}]' for i in range(n)) + f'amix=inputs={n}:normalize=0[ch{c}]')
            mix = splits + ';'.join(chans) + ';' + ''.join(f'[ch{c}]' for c in range(n)) + f'amerge=inputs={n}[m]'
            channels = n
        else:
            mix = ''.join(f'[a{i}]' for i in range(n)) + (f'amix=inputs={n}:normalize=0[m]' if n > 1 else 'anull[m]')
            channels = 1
        graph = ';'.join(filters + [mix])
        wav = os.path.join(scratch, f'{sid}.wav')
        mp3 = os.path.join(out_dir, f'{sid}.mp3')
        subprocess.run(['ffmpeg', '-y', '-loglevel', 'error', *inputs, '-filter_complex', graph, '-map', '[m]', '-ar', '16000', '-ac', str(channels), wav], check=True)
        subprocess.run(['ffmpeg', '-y', '-loglevel', 'error', '-i', wav, '-ac', str(channels), '-ar', '22050', '-b:a', f'{48 * channels}k', mp3], check=True)
        words.sort(key=lambda w: w['start'])
        speakers = sorted({w['speaker'] for w in words})
        convs = sorted({w['conversation'] for w in words})
        topics = sorted({(w['conversation'], w['topic']) for w in words})
        doc = dict(
            id=sid, title=sc['title'], blurb=sc['blurb'], seconds=sc['parts'][0][2] - sc['parts'][0][1], channels=channels,
            source=[dict(meeting=m, start=a, end=b, stream=s, gainDb=g, conversation=c) for m, a, b, s, g, c in sc['parts']],
            licence='AMI Meeting Corpus, CC BY 4.0 (https://groups.inf.ed.ac.uk/ami/corpus/license.shtml). Excerpts cut, mixed and loudness-normalised for this scene' + (f'; each channel adds the other table at {BLEED_DB} dB.' if channels > 1 else '.'),
            counts=dict(speakers=len(speakers), conversations=len(convs), topics=len(topics)),
            words=words,
        )
        json.dump(doc, open(os.path.join(out_dir, f'{sid}.truth.json'), 'w'), separators=(',', ':'))
        index.append(dict(id=sid, title=sc['title'], blurb=sc['blurb'], counts=doc['counts']))
        print(sid, doc['counts'], len(words), 'words', os.path.getsize(mp3) // 1024, 'KB')
    if which is SCENARIOS:
        json.dump(index, open(os.path.join(out_dir, 'scenarios.json'), 'w'), indent=1)


if __name__ == '__main__':
    # --dev writes the development windows (WAV, MP3 and truth) to the scratch folder only.
    if '--dev' in sys.argv:
        main(sys.argv[2], sys.argv[2], DEV)
    else:
        main(sys.argv[1], sys.argv[2])
