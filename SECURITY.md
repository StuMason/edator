# Security

## Reporting

Found something — a way to exfiltrate footage, a path traversal in source resolution,
an injection through the raw valve? Please **don't** open a public issue. Use GitHub's
private vulnerability reporting (Security → Report a vulnerability) or email the address
on the maintainer's GitHub profile. Expect a reply within a few days.

## What leaves your machine

By design, **only audio** is ever uploaded — `transcribe.js` extracts the audio and
sends it to AssemblyAI for the transcript. The **video never leaves your machine**;
the renderer is fully local. The raw filter valve runs arbitrary ffmpeg filters from
the pack — treat a pack from an untrusted source the way you'd treat any script.
