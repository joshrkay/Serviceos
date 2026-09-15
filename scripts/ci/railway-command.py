#!/usr/bin/env python3
"""Bound one Railway CLI invocation, including its child processes."""
import os
import signal
import subprocess
import sys

limit = float(sys.argv[1])
if limit <= 0:
    sys.exit('Command timeout must be positive')
process = subprocess.Popen(['railway', *sys.argv[2:]], start_new_session=True)
try:
    sys.exit(process.wait(timeout=limit))
except subprocess.TimeoutExpired:
    os.killpg(process.pid, signal.SIGKILL)
    process.wait()
    print('Railway command timed out', file=sys.stderr)
    sys.exit(124)
