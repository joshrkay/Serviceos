#!/usr/bin/env python3
"""Render a FAILED Railway CLI run's captured stderr as safe ::error:: lines.

Reads the raw stderr on stdin and prints, on stdout, at most MAX_LINES lines
(the tail, where the CLI's actual error is), each prefixed so it reads as
Railway CLI output in the GitHub Actions log and cut to MAX_LINE_CHARS, plus
a plain note when earlier lines were dropped. Before anything is bounded,
the text is
  * scrubbed of the literal values of RAILWAY_TOKEN / RAILWAY_API_TOKEN,
    read from the environment (never argv), wherever one appears whole,
    with whitespace (e.g. a line break) allowed between any two of its
    characters; whitespace inside the secret itself is ignored. This runs
    on the raw text and again after the clean-up below,
  * stripped of ANSI escapes and control characters (a CR becomes a line
    break, so CLI text can never start a line and issue a workflow command),
  * scrubbed of secret-shaped values: Authorization header values, bearer
    credentials, token/secret/password/api-key=value pairs, and any run of
    24+ [A-Za-z0-9_-] characters.
That scrubbing is best effort: an escape sequence inside a secret makes the
clean-up eat part of it, so neither literal pass sees it whole. The
guarantee is the check that follows, which fails closed: the CLI-derived
text of the output (every line's text after the fixed prefix, cut to the
printed width, with the [REDACTED] placeholders and the helper's own notes
left out, checked before '%' is escaped to '%25'), whitespace removed and
joined across lines, must not contain any WINDOW consecutive characters of
either secret (whitespace removed; all of a shorter secret), compared
case-sensitively. If it does, nothing goes to stdout and the exit status is
1, so railway-deploy.sh withholds the CLI text. So no WINDOW consecutive
characters the CLI printed that match a secret are shown, while ordinary
CLI output that shares no such run with a secret still is. The helper's own
text ([REDACTED], the notes, the %25 escape) can still sit next to at most
WINDOW - 1 matching CLI characters. Redaction runs before the
tail/truncation, the whole output is built and checked before any of it is
printed, and the [REDACTED] placeholder has a fixed length, so a redacted
secret's length is not shown (a truncation note counts only the characters
cut off past the printed width). railway-deploy.sh bounds this helper's
runtime and withholds the text if it fails or overruns.

Python rather than sed/awk: the token must be matched as a literal, which
sed can't do without regex-escaping an arbitrary secret (and awk -v would
interpret its backslashes), and python3 is already required by
railway-command.py, which this sits next to.

Usage: railway-stderr-diagnostics.py < captured-stderr
"""
import os
import re
import sys

MAX_LINES = 20
MAX_LINE_CHARS = 300
WINDOW = 4
PREFIX = '::error::Railway CLI: '
REDACTED = '[REDACTED]'
# Each placeholder is held as a run of MARKs, one per character of
# REDACTED, until the lines are built, so the check can tell it from CLI
# text (a '[REDACTED]' the CLI printed itself is checked like the rest).
# MARK is taken out of the input first.
MARK = '\ue000'
PLACEHOLDER = MARK * len(REDACTED)
PLACEHOLDER_RUN = re.compile(MARK + '{1,%d}' % len(REDACTED))
# railway-command.py's own last words on a timeout: not Railway CLI output.
TIMEOUT_NOTICE = 'Railway command timed out\n'

ANSI = re.compile(r'\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b\n]*(?:\x07|\x1b\\)?|[ -/]*[0-~])')
CONTROL = re.compile(r'[\x00-\x08\x0b-\x0c\x0e-\x1f\x7f-\x9f]')  # keeps \n and \r
SECRET_SHAPES = [
    (re.compile(r'(?i)(\b(?:proxy-)?authorization["\']?[ \t]*[:=][ \t]*)[^\r\n]+'), r'\1' + PLACEHOLDER),
    (re.compile(r'(?i)(\bbearer\s+)[^\s"\',;]+'), r'\1' + PLACEHOLDER),
    (re.compile(r'(?i)((?:token|secret|password|api[_-]?key)=)[^\s&"\',;]+'), r'\1' + PLACEHOLDER),
    (re.compile(r'[A-Za-z0-9_-]{24,}'), PLACEHOLDER),
]


def redact_literal(text, secret):
    # Whitespace (e.g. a wrapped line) may sit between any two characters.
    # The secret has none of its own (main drops it): a literal space
    # between two \s* runs would backtrack super-linearly on a long blank
    # run, and the dropped whitespace is tolerated by \s* anyway.
    return re.sub(r'\s*'.join(re.escape(c) for c in secret), PLACEHOLDER, text)


def render(raw, secrets):
    """Return the lines to print and the CLI-derived text in them."""
    text = raw.replace(MARK, '\ufffd').replace('\r\n', '\n')
    if text.endswith(TIMEOUT_NOTICE):
        text = text[:-len(TIMEOUT_NOTICE)]
    # Before the clean-up too: an escape sequence directly before a secret
    # would otherwise swallow its first characters and leave the rest.
    for secret in secrets:
        text = redact_literal(text, secret)
    text = CONTROL.sub('', ANSI.sub('', text.replace('\t', ' ')))
    for secret in secrets:
        text = redact_literal(text, secret)
    for shape, replacement in SECRET_SHAPES:
        text = shape.sub(replacement, text)

    lines = [line.strip() for line in re.split(r'[\r\n]', text)]
    lines = [line for line in lines if line]
    out = []
    cli_text = []
    if len(lines) > MAX_LINES:
        out.append(f'({len(lines) - MAX_LINES} earlier line(s) omitted; showing the last {MAX_LINES})')
    if not lines:
        out.append(PREFIX + '(no stderr output)')
    for line in lines[-MAX_LINES:]:
        note = ''
        if len(line) > MAX_LINE_CHARS:
            note = f'... [{len(line) - MAX_LINE_CHARS} chars truncated]'
            line = line[:MAX_LINE_CHARS]
        cli_text.extend(line.split(MARK))
        # A cut may leave the start of a placeholder: show that much of it.
        line = PLACEHOLDER_RUN.sub(lambda m: REDACTED[:len(m.group())], line)
        # Workflow-command data escaping: '%' would otherwise be decoded.
        out.append(PREFIX + (line + note).replace('%', '%25'))
    return ''.join(f'{line}\n' for line in out), ''.join(cli_text)


def exposes(cli_text, secret):
    """Whether cli_text (whitespace-free) holds WINDOW chars of secret in a row."""
    if len(secret) <= WINDOW:
        return secret in cli_text
    runs = {cli_text[i:i + WINDOW] for i in range(len(cli_text) - WINDOW + 1)}
    return any(secret[i:i + WINDOW] in runs for i in range(len(secret) - WINDOW + 1))


def main():
    secrets = [''.join(os.environ.get(name, '').split()) for name in ('RAILWAY_TOKEN', 'RAILWAY_API_TOKEN')]
    secrets = [s for s in secrets if s]
    raw = sys.stdin.buffer.read().decode('utf-8', 'replace')
    output, cli_text = render(raw, secrets)
    cli_text = ''.join(cli_text.split())
    if any(exposes(cli_text, secret) for secret in secrets):
        print('railway-stderr-diagnostics: part of a secret survived redaction; printing nothing', file=sys.stderr)
        return 1
    sys.stdout.buffer.write(output.encode('utf-8'))
    return 0


if __name__ == '__main__':
    sys.exit(main())
