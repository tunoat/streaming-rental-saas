# Local database operations

Use a separate PostgreSQL database for validation. Apply migrations with the migration role and use the restricted runtime URL for API requests. Applied migrations are checksum-verified. Ship corrective forward migrations for changes to existing deployments.

The Compose volume persists local fixtures across service restarts. Dump and restore into a separate database to validate backup recovery. PITR, RPO and RTO are unvalidated.

Run `npm run backup:drill -- <disposable-postgres-container>` with Docker access. It creates and removes only a randomly named restore database and its temporary dump. Stop fixture writes before drilling so the source snapshot and the control-total query describe the same state.

