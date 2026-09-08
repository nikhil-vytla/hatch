"""Trusted exec launcher; no candidate Python runs in this interpreter."""

import os
import resource
import sys


def main() -> None:
    cpu, output = int(sys.argv[1]), int(sys.argv[2])
    # Fail closed if the host cannot apply an advertised hard limit.
    for name, value in ((resource.RLIMIT_CPU, cpu), (resource.RLIMIT_FSIZE, output),
                        (resource.RLIMIT_NOFILE, 64), (resource.RLIMIT_CORE, 0)):
        resource.setrlimit(name, (value, value))
    os.execv(sys.argv[3], sys.argv[3:])


if __name__ == "__main__":
    main()
