# Security policy

## Reporting a vulnerability

Report security issues privately through GitHub private vulnerability reporting on this repository (Security tab, "Report a vulnerability") or by email to **hello@denodes.io**. Do not open a public issue, pull request or discussion for a security problem.

A useful report includes:

- what is affected (file, workflow or script)
- steps to reproduce, or a proof of concept
- the impact as understood by the reporter
- a name or handle for credit, if credit is wanted

## Scope

In scope:

- the validator (`scripts/validate.mjs`) and its tests
- the workflows in `.github/workflows`

Out of scope:

- problems with a contributor's listing, feed or snapshot files. Report them through the Listing problem issue template; the contributor is responsible for its own servers and data
- snapshot files and servers run by contributors
- denial of service, volumetric attacks and automated scanner output without a demonstrated impact
- social engineering and physical attacks
- vulnerabilities in third-party dependencies that are already public, unless this repository is affected in a way the upstream advisory does not cover

Testing must not access or change other people's data and must not degrade the service for other users. Stop testing and report as soon as a vulnerability is confirmed.

## What happens after a report

The deNodes team confirms receipt, reproduces the issue and keeps the reporter informed of the assessment and the fix. Response time depends on severity and team availability; critical issues are handled first. Once a fix is released, the issue may be disclosed publicly, with credit to the reporter unless they prefer otherwise. Please give the team a reasonable time to ship a fix before any public disclosure.

## Supported versions

Only the latest commit on `main` receives security fixes.
