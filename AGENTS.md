# Repository privacy

- Never commit real personal names, account names, machine names, usernames, email addresses, IP addresses, credentials, or local absolute paths. This includes commit messages and author/committer metadata.
- Use synthetic fixtures, reserved example addresses, and generic placeholder paths in tests and documentation. Public provider/package names and source file paths are appropriate.
- Keep actual account configuration, environment files, logs, and local output out of version control. Never copy live provider responses into fixtures.
- Use a repository-local anonymous Git identity: `Anonymous <anonymous@example.invalid>`. Do not change the user's global Git identity.
- Inspect the staged diff and commit metadata for identifying details before committing. When removing an accidental disclosure, check earlier commits and all local refs as well.
