---
type: note
provenanceFiles: [CHANGELOG.md, README.md]
provenanceCommits: [4d1de8a, e9ad31c]
created: 2026-10-12
scopePhase: 25.7
confidence: medium
---
Phase 25.7 (the hardening) economics: 48 issues in 13 waves over ~4 days (first wave merge 2026-10-08, release 2026-10-11), 107 commits v2.8.1..v2.8.2, suite 1735 → 2120 (+385), tool count flat at 87. Planned 20 issues grew 2.4× under the no-stop loop. Waves 1–3 reported 113m / 80m / 55m observed_claim; waves 7–13 ran ~60–75m each by the verifier's account (git_span unreliable, see the constraint card). Three self-inflicted regressions among 48 closes (6%). First phase whose release failed CI after a locally green suite.
