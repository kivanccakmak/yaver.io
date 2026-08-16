# Cloud Studio on tvOS

The Apple TV app is a remote Cloud Studio client. It does not host a local
repository, Git credential, model credential, shell, build toolchain, or AI
runner.

## Required chain

1. The authenticated account has active Cloud Studio access.
2. At least one Git Connection is ready.
3. A Cloud Workspace and its managed Cloud Runner are ready.
4. The user selects a path-free repository descriptor.
5. The runner creates an isolated Project Session checkout and a
   `yaver/cloud-*` review branch.
6. Tasks, validation, tests, builds, and Vibing previews execute only inside
   that Project Session.

The tvOS client receives repository and session IDs, capability metadata,
task output, test results, and preview frames. Runner filesystem paths and Git
credentials never cross into the TV app.

## Publishing boundary

Cloud Studio can prepare and validate source changes. Signing identities,
store records, release declarations, submission, and publication remain under
the developer's control.

Apple-facing screens expose operational states such as unavailable, pending,
ready, suspended, and expired. They do not include commerce copy, commerce
links, or entitlement mutation controls.
