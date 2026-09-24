# RoundWatch security audit artifact manifest — 2026-09-24

This manifest records the exact source artifacts retained for the security
remediation cycle that culminated in the targeted blocker verification of
2026-09-24.

The files are preserved verbatim in the operator's persistent external archive.
The ZIP evidence bundles are intentionally not reconstructed or repacked by the
repository. Use the hashes below to verify any retrieved copy before relying on
it as audit evidence.

| Artifact | SHA-256 |
| --- | --- |
| `SECURITY_AUDIT_V1.md` | `77c8438fa63ff75e2391b4e2dbdd04bc2113bd8937f460082e5d2fef5576dc44` |
| `SECURITY_REMEDIATION_REVIEW_V1.md` | `af44d6738392b3e38134cd5f2d657c353dcebbcf603b040abbfae014c79e75ae` |
| `SECURITY_REMEDIATION_FINAL_VERIFICATION.md` | `fb1383dc3a5617e78a4c7097ff098d1398d1fc15273b717b6b724ea3703c69e0` |
| `SECURITY_REMEDIATION_FINAL_EVIDENCE.zip` | `90f9bda1fb3548a9327ae9a938f2f3a46b59be9712ae0c2cac93fdcac2e2c5b5` |
| `SECURITY_BLOCKER_TARGETED_VERIFICATION.md` | `26d990aeb9f4cf67442d119f2cb9a355b669f1a2d3475774b9de3e17728983d7` |
| `SECURITY_BLOCKER_TARGETED_EVIDENCE.zip` | `b758a0f4024fc09c1e675856d63bd7c594df7cc7966764c617512e919b2870b5` |

## Final verified target

The targeted blocker verification was run against:

`4e291168ffee803ce663833608caa4fd1ea771f7`

Its final conclusion was:

**ALL PREVIOUS RELEASE BLOCKERS VERIFIED CLOSED**

The targeted report records 89/89 server tests, 7/7 client tests, both
typechecks passing, and closure of the four previously demonstrated blocker
areas.

## Post-verification documentation commits

Later commits may update documentation while leaving the verified runtime
surface unchanged. Such descendants do not change the exact target of the
security verification above. If a future commit changes payment, evidence,
settlement, recovery, expiry, durable storage, worker readiness, or production
readiness behavior, perform focused regression verification and do not treat
this manifest as automatically extending the prior result.
