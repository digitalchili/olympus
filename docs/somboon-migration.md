# One-time existing-host migration

This is an operator-supplied override procedure; portable defaults intentionally contain no host, project, network, IP, or volume names.

1. Inventory the existing container, image digest, bind address, networks, Olympus state volume, Hermes `/opt/data` volume, UID/GID, and rollback command. Store identifiers in a private deployment override, not this repository.
2. Run the consistent Olympus backup and verify SQLite integrity, metadata, and archive listing. Do not copy the large Hermes volume as part of the Olympus release procedure; retain the existing independent Hermes backup policy.
3. Create a separate shadow Compose project with disposable Olympus state and read-only Hermes preflight access. Run source tests, image build, readiness, task/session persistence, scheduled-task operations, SSE, successful promotion, forced candidate failure, and rollback.
4. Schedule a bounded promotion window. Start stable Nginx pointing at the existing active slot.
5. Begin authenticated drain, confirm new writes receive the maintenance response, and wait for active runs to finish. Do not stop active tasks or their SSE streams.
6. Only after active count is zero, start the candidate against live volumes. Switch Nginx after readiness. Retain the old image and slot for rollback.
7. If any step fails, stop the candidate, cancel drain, and keep the old slot serving. Do not improvise concurrent access to the SQLite volume.

This is not a zero-downtime claim. Existing active runs and HTTP/SSE connections are preserved; new writes receive retryable 503 only during the bounded promotion window.

No live cutover is authorized by this document. Deployment requires explicit approval after shadow evidence is reviewed.
