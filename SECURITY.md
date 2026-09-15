# Security

## Reporting a vulnerability

Please report suspected vulnerabilities privately through the GitHub Security
Advisory "Report a vulnerability" flow:

https://github.com/EkagraAgarwal/BanyanCode/security/advisories/new

Do not include sensitive details in a public issue. Reports should include the
affected version or commit, reproduction steps, impact, and any suggested
mitigation. We will acknowledge valid reports and coordinate disclosure with
the reporter.

Security reports generated solely by automated or generative tools without a
reproducible finding are not actionable.

## Automated plugin scans

The trusted source-policy scan uses `.plugin-scanner.toml` and the repository's
trusted policy. The independent catalog-compatibility scan runs without that
configuration or a baseline and intentionally ignores repository suppressions.
It checks the plugin as an external catalog consumer would see it.

Any credential fixture used by the catalog scan is synthetic, non-functional,
and safe to represent in test data; it is never a real secret. The scan accepts
only results scoring at least 80, with zero high or critical findings.
