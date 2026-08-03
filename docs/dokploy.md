# Dokploy installation

Create a Compose application from this repository and persist `.env` outside regenerated source. Set at minimum `HERMES_DATA_VOLUME` to the existing named Hermes `/opt/data` volume and `OLYMPUS_MAINTENANCE_TOKEN` to a strong random value. Keep the default loopback bind unless Dokploy's private proxy network needs a controlled listener.

Validate before starting:

```bash
HERMES_DATA_VOLUME=your-volume docker compose config --quiet
HERMES_DATA_VOLUME=your-volume docker compose -f docker-compose.ha.yml config --quiet
```

Do not let Dokploy scale either slot above one or start both slots against live volumes. Use the repository updater for promotion because generic rolling updates violate the SQLite single-writer boundary. Configure a health check against `/api/ready`, a stop grace period greater than the drain timeout, and persistent mounts for both Olympus state and Hermes `/opt/data`.

Create the external Olympus state volume before first deployment (the installer does this), retain `.env`, `.olympus-active-slot`, and `.olympus-slots.env` beside the project, and bind-mount the whole `deploy/nginx/conf.d` directory so atomic upstream replacement is visible inside Nginx. The updater mirrors immutable per-slot pins into `.env`; Dokploy must not regenerate these operator-owned files during promotion.

Before any production cutover, build and run a shadow project with cloned/disposable volumes, test a task and SSE stream, force candidate readiness failure, and verify the live project was not changed.
