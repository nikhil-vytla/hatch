"""Reads AMI Meeting Corpus word timings and topic segments (NXT XML). Set AMI_DIR to a folder with manual/."""
import re, os, sys, glob, html
M = os.path.join(os.environ.get('AMI_DIR', '.'), 'manual')


def words(meeting):
    out = {}
    for f in glob.glob(f'{M}/words/{meeting}.*.words.xml'):
        spk = f.split('.')[-3]
        for m in re.finditer(r'<w nite:id="([^"]+)" starttime="([\d.]+)" endtime="([\d.]+)"( punc="true")?[^>]*>([^<]*)</w>', open(f, encoding='latin-1').read()):
            out[m.group(1)] = dict(id=m.group(1), spk=spk, s=float(m.group(2)), e=float(m.group(3)), punc=bool(m.group(4)), t=html.unescape(m.group(5)))
    return out


def topics(meeting, W):
    f = f'{M}/topics/{meeting}.topic.xml'
    if not os.path.exists(f):
        return {}
    txt = open(f, encoding='latin-1').read()
    lab = {}
    # Innermost topic wins: nested topics appear inside their parents, so walk all and keep the
    # deepest by processing children before parents (sort by span length ascending).
    spans = []
    for tm in re.finditer(r'<topic nite:id="([^"]+)"(?: other_description="([^"]*)")?[^>]*>', txt):
        tid, desc = tm.group(1), tm.group(2) or ''
        # body up to matching close: approximate by next '<topic' or '</topic>'
        start = tm.end()
        nxt = re.search(r'<topic |</topic>', txt[start:])
        body = txt[start:start + (nxt.start() if nxt else len(txt))]
        ptr = re.search(r'href="default-topics.xml#id\(([^)]+)\)"', body)
        for c in re.finditer(r'href="([^"#]+words\.xml)#id\(([^)]+)\)(?:\.\.id\(([^)]+)\))?"', body):
            a, b = c.group(2), c.group(3) or c.group(2)
            ia, ib = int(a.rsplit('words', 1)[1]), int(b.rsplit('words', 1)[1])
            prefix = a.rsplit('words', 1)[0] + 'words'
            spans.append((ib - ia, tid, desc or (ptr.group(1) if ptr else ''), prefix, ia, ib))
    for _, tid, desc, prefix, ia, ib in sorted(spans):
        for i in range(ia, ib + 1):
            k = f'{prefix}{i}'
            if k in W and k not in lab:
                lab[k] = (tid, desc)
    return lab


def window(meet, a, b):
    from collections import Counter
    W = words(meet)
    T = topics(meet, W)
    ws = sorted([w for w in W.values() if not w['punc'] and w['s'] >= a and w['e'] <= b], key=lambda w: w['s'])
    c = Counter(w['spk'] for w in ws)
    tc = Counter(T.get(w['id'], ('?', '?'))[1] for w in ws)
    sp = sum(w['e'] - w['s'] for w in ws)
    print(f'{meet} {a}-{b}: {len(ws)} words, speakers {dict(c)}, topics {dict(tc)}, speech {sp:.0f}s')


if __name__ == '__main__':
    for meet in sys.argv[1:]:
        W = words(meet)
        T = topics(meet, W)
        ws = sorted([w for w in W.values() if not w['punc']], key=lambda w: w['s'])
        seq = []
        for w in ws:
            d = T.get(w['id'], ('?', '?'))[1]
            if not seq or seq[-1][1] != d:
                seq.append((w['s'], d))
        print(meet, len(ws), 'words, speakers', sorted({w['spk'] for w in ws}), 'dur', round(ws[-1]['e']))
        for s, d in seq[:30]:
            print(f'   {s:7.1f}  {d[:70]}')
