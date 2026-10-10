# drive.py OUT COLS ROWS STEPS_JSON -- cmd...   steps: [["wait", secs] | ["type", text] | ["snap", name] | ["until", text, maxsecs]]
import codecs, json, os, pty, select, struct, sys, time, fcntl, termios
out, cols, rows, steps = sys.argv[1], int(sys.argv[2]), int(sys.argv[3]), json.loads(sys.argv[4])
cmd = sys.argv[sys.argv.index("--") + 1:]
pid, fd = pty.fork()
if pid == 0:
    os.environ["TERM"] = "xterm-256color"
    os.execvp(cmd[0], cmd)
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
buf = bytearray(); snaps = []; events = []; t0 = time.time(); dec = codecs.getincrementaldecoder('utf-8')('replace')
castf = open(out + ".cast", "w")
castf.write(json.dumps({"version": 2, "width": cols, "height": rows, "timestamp": int(t0), "env": {"TERM": "xterm-256color"}}) + "\n")
def pump(secs):
    end = time.time() + secs
    while time.time() < end:
        r, _, _ = select.select([fd], [], [], 0.05)
        if r:
            try: data = os.read(fd, 65536)
            except OSError: return False
            if not data: return False
            buf.extend(data); castf.write(json.dumps([round(time.time() - t0, 4), "o", dec.decode(data)]) + "\n"); castf.flush()
    return True
for step in steps:
    if step[0] == "wait": pump(step[1])
    elif step[0] == "type":
        for ch in step[1]:
            os.write(fd, ch.encode()); pump(0.02)
    elif step[0] == "snap": snaps.append([step[1], len(buf), round(time.time() - t0, 4)]); json.dump(snaps, open(out + ".snaps.json", "w"))
    elif step[0] == "until":
        end = time.time() + step[2]; mark = len(buf)
        while time.time() < end and step[1].encode() not in buf[mark:]:
            if not pump(0.5): break
pump(1.5)
snaps.append(["end", len(buf), round(time.time() - t0, 4)])
open(out, "wb").write(bytes(buf))
json.dump(snaps, open(out + ".snaps.json", "w"))
castf.close()
try: os.kill(pid, 0); print("child still running; killing", pid); os.kill(pid, 9)
except OSError: pass
os.waitpid(pid, 0)
