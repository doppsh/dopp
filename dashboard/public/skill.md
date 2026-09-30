---
name: dopp
description: Route a codebase's Jev-compatible decision API calls (POST /v1/systemone) through a self-hosted Dopp server.
---

# Dopp (self-hosted)

Dopp is a drop-in proxy for Jev-compatible decision APIs. Same request, same reply; every request is kept as a training
example on the Dopp server, and the server's owner can train small models on them.

## What it receives

Only the `POST /v1/systemone` requests the app already sends: the `state` and the `questions`. Nothing else from the codebase.

## Set it up

1. Change the decision API's base URL (for TypeSafe's SDK, `https://api.typesafe.ai`) to this Dopp server's address, the
   origin this file was served from. The request body and the reply stay the same.
2. Bearer token: the route key (`us_…`) the person gives you, in place of the TypeSafe key. Dopp accepts nothing else.
   Keep it in an environment variable (for example `DOPP_KEY` in `.env`, with `.env` in `.gitignore`); never print it,
   log it or commit it. If the person gives you a one-time link instead, `curl -sf <link> >> .env` adds the key.
3. Check it works: send one request with the header `x-dopp-test: 1`. It is answered but not stored.

The request and response format, with examples: `/docs.md` on the same server. OpenAPI: `/openapi.json`.
