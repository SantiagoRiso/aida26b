# Docker Setup Guide

## Quick Start

To build and run all services:

```bash
docker-compose up --build
```

**Access the application:**
- Frontend: http://localhost:8080
- Backend API: http://localhost:3000
- Database: localhost:5432

## Common Commands

Start services in the background:
```bash
docker-compose up -d --build
```

Stop all services:
```bash
docker-compose down
```

Stop services and remove volumes (clean database):
```bash
docker-compose down -v
```

View logs:
```bash
docker-compose logs -f                          # All services
docker-compose logs -f backend                  # Backend only
```

Restart a specific service:
```bash
docker-compose restart backend
```

Rebuild a specific service:
```bash
docker-compose up -d --build backend
```

Access the database directly:
```bash
docker-compose exec database psql -U postgres -d professional_agenda
```

## Services Architecture

- **database**: PostgreSQL 18 Alpine
  - Container: aida26_database
  - Port: 5432
  - Persistent data in `postgres_data` volume
  - The app database and its two roles are created by `database/bootstrap.sh` on first init, from the `DB_*` env vars (not `POSTGRES_*`, which only set the cluster superuser); schema is applied via backend migrations at app startup

- **backend**: Node.js/Express
  - Container: aida26_backend
  - Port: 3000
  - Language: TypeScript (with tsx)
  - Runs in development mode with hot-reload
  - Depends on database service

- **frontend**: Webpack development server
  - Container: aida26_frontend
  - Port: 8080
  - Language: TypeScript
  - Serves frontend assets and proxies API requests to the backend
  - Depends on backend service

## Environment Variables

Environment variables are configured in `docker-compose.yml`:

```
NODE_ENV: development
PORT: 3000
DB_HOST: database (Docker service name)
DB_PORT: 5432
DB_NAME: professional_agenda
DB_USER: aida26_user
DB_PASSWORD: CambiaEsta!
API_PROXY_TARGET: http://backend:3000  # Target the frontend dev-server proxies /api to
```

To use different values, create a `.env` file in the project root. An example is provided in `.env.example`:

```bash
cp .env.example .env
# Edit .env and set secure values, especially DB_PASSWORD
```

## Troubleshooting

### Database connection refused
- Ensure database service is healthy: `docker-compose ps`
- Check database logs: `docker-compose logs database`
- Wait for health check to pass (usually 30-60 seconds)

### Backend cannot connect to database
- Verify services are on the same network: `docker network ls`
- Check backend logs: `docker-compose logs backend`
- Ensure DB_HOST is set to `database` (the service name)

### Frontend cannot reach backend
- Check if both services are running: `docker-compose ps`
- Verify API_PROXY_TARGET is correct in frontend (should be http://backend:3000)
- Check frontend logs: `docker-compose logs frontend`

### Port already in use
- Stop existing containers: `docker-compose down`
- Or change ports in `docker-compose.yml`

## Development

For active development, volumes enable hot-reload:

- **Backend**: `/backend/src` is mounted, changes trigger tsx watch reload
- **Frontend**: Source is copied during build; rebuild required for changes

To rebuild after code changes:
```bash
docker-compose up -d --build backend  # Rebuild backend
docker-compose up -d --build frontend # Rebuild frontend
```

## Production Deployment

### General Production Recommendations

You would typically:

1. Build images once and push to registry
2. Use environment-specific compose files (e.g., docker-compose.prod.yml)
3. Set `NODE_ENV=production`
4. Use Alpine images for smaller size (already configured)
5. Add reverse proxy (nginx) for SSL/TLS
6. Use secrets management for sensitive data (database passwords)
7. Remove volume mounts and use only the built artifacts
8. Set resource limits and memory constraints
9. Use health checks and restart policies
10. Implement logging aggregation

Example production docker-compose can be created upon request.
