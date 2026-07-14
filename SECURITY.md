# Security policy

## Supported versions

Security fixes are handled on `main` until signalkrebs starts publishing
versioned maintenance branches.

## Reporting a vulnerability

Do not open a public issue for vulnerabilities involving credentials, staged
source leakage, command injection, unsafe temporary directories, or unintended
network access.

Report security issues privately through GitHub Security Advisories for the
repository, or contact the maintainers through the private channel listed on the
project profile.

Include:

- affected version or commit;
- detector lane and toolchain version, if relevant;
- operating system and Node.js version;
- exact signalkrebs command or config involved;
- whether source files, staged diffs, or credentials were exposed;
- a minimal reproducer when safe to share.

## Scope

Security-sensitive areas include:

- detector command construction and shell escaping (the `go`/`swift` invocations);
- explicit environment variables forwarded to the detector (e.g. `GOMAXPROCS`);
- the target checkout and any temporary/scratch directories touched during a run;
- detector output normalization and the JSON result artifact;
- the per-repo lock file and retained debug artifacts.

Detector-engine bugs (a ThreadSanitizer or `go test -race` defect) should also be
reported to that toolchain's project when the vulnerable behavior is outside
signalkrebs itself.
