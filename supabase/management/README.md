# Supabase CLI access

The `management` service answers the Supabase Management API for this stack, so the
stock Supabase CLI can manage it: `db query`, TypeScript types, advisors, Postgres
settings, edge functions, secrets, `config pull`/`diff`/`push`, SSO and snippets. The
gateway routes `/v1/`, `/v2/` and `/platform/` to it, so the API lives at the app's own
https address. It targets Supabase CLI v2.122.0.

## Token and project ref

- The access token is the `MANAGEMENT_TOKEN` app variable (on Cloady, the app's
  Settings → Environment): 40 lowercase hex characters, generated at install. Without
  Cloady, set it in `.env` to the output of `openssl rand -hex 20`. The CLI takes it as
  `sbp_<MANAGEMENT_TOKEN>`. When the variable is missing or malformed, the service logs
  `management: MANAGEMENT_TOKEN is missing or malformed; the API is disabled` and
  answers every API request with 401. It is read at start, so restart `management` after
  changing it.
- The project ref is `PROJECT_REF` when set (20 lowercase letters). Left empty, it is
  derived from `JWT_SECRET` and stays the same until `JWT_SECRET` changes.
  `supabase projects list` shows it, and the service logs it at start
  (`management: ref=<ref>`). To compute it yourself:

  ```sh
  printf supabase-project-ref | openssl dgst -sha256 -hmac "$JWT_SECRET" -binary | head -c 20 | od -An -tu1 | tr -s ' ' '\n' | awk 'NF{printf "%c", 97 + $1 % 26} END{print ""}'
  ```

## Profile

Save a profile file under an absolute path, for example `$HOME/supabase-myapp.yaml`:

```yaml
name: cloady-myapp
api_url: https://supa-k3ulpfz4-acme.cloady.io
dashboard_url: https://supa-k3ulpfz4-acme.cloady.io
project_host: <host>
```

- `name` must be unique and must not be `supabase`: the CLI keeps each profile's token
  in the OS keyring under its name.
- `api_url` and `dashboard_url` are the app's address, with no path and no trailing
  slash.
- `project_host`: the CLI reaches `https://<ref>.<project_host>` for storage commands,
  `seed buckets`, `services` and `link`'s version checks, so that host must reach this
  app's gateway with a trusted certificate. For example, set `project_host` to the app's
  address and add `<ref>.<app address>` to the app as a custom domain. If the host does
  not serve the gateway, those commands fail and `link` skips its version checks without
  saying so.
- Leave out `pooler_host`.

## Log in

```sh
supabase --profile "$HOME/supabase-myapp.yaml" login --token sbp_<MANAGEMENT_TOKEN>
supabase projects list
supabase link --project-ref <ref>
```

Instead of `--profile` you can set `SUPABASE_PROFILE="$HOME/supabase-myapp.yaml"`, and
instead of `login`, export `SUPABASE_ACCESS_TOKEN=sbp_<MANAGEMENT_TOKEN>`. `login` saves
the profile path in `~/.supabase/profile`, which is why the path must be absolute: later
commands keep going to this app until you pass another profile (`--profile supabase` for
supabase.com) or delete that file.

Browser login (`supabase login` without `--token`) does not work: the CLI opens
supabase.com for any custom profile.

## Database

The stack publishes no Postgres. `gen types --lang typescript --linked` and
`postgres-config` work through the API alone. `db query --linked` and
`db advisors --linked` run through the API too, but the CLI first checks that it can
reach `db.<ref>.<project_host>:5432` and stops with `IPv6 is not supported on your
current network` when it cannot, so they work only if you serve Postgres there yourself.
Commands that open a Postgres connection themselves (`db push`, `db pull`, `db diff`,
`db dump`, `db lint`, `migration list`, `inspect db` and others) dial the same address
with `--linked` and fail the same way. Pass
`--db-url postgresql://postgres:<POSTGRES_PASSWORD>@<host>:<port>/postgres` instead.

- `db diff` and `db pull` default to migra, which checks the server's certificate
  against Supabase's own CA when the server speaks TLS. Turn on pg-delta
  (`[experimental.pgdelta] enabled = true` in `config.toml`, or
  `SUPABASE_EXPERIMENTAL_PG_DELTA=true`), or use a plaintext `--db-url` with
  `sslmode=disable`.
- `gen types --lang go|swift|python --linked` pins Supabase's private CA; use
  `--db-url`.

## Limits

- Auth settings that `config push` writes take precedence over the app variables from
  then on. Auth applies them within seconds without a restart, but only if its whole
  configuration is valid; otherwise it keeps the previous one and logs `config reloader`
  errors. Hook URIs and secrets are checked against auth's own rules before anything is
  written, so a hook auth would refuse, one enabled without a URI, or a URI not written
  in its canonical form (the error shows it) answers 400.
  Settings auth reads only at start (database pool size, API host and port,
  maximum request duration) need an auth restart.
- Run `supabase config pull` before your first `config push`, or the defaults
  `supabase init` wrote (such as `site_url = "http://127.0.0.1:3000"`) are pushed.
- Postgres settings that need a server restart (`max_connections`, `shared_buffers`,
  `max_worker_processes` and the like) are saved but apply only after the db service
  restarts. `restart_database` is ignored.
- Storage settings are app variables. `config push` refuses a different
  `file_size_limit`, image transformation or S3 protocol setting and names the variable
  to change (`UPLOAD_FILE_SIZE_LIMIT`, `IMAGE_TRANSFORMATION_ENABLED`,
  `S3_PROTOCOL_ENABLED`); restart storage after changing it. Hosted-only storage
  features (vector buckets, Iceberg catalog, cache purge) are ignored.
- `[api]` `db_pool` and `db_pool_acquisition_timeout` are fixed, and the Data API cannot
  be turned off.
- Functions deployed with the CLI check JWTs unless deployed with `--no-verify-jwt` (or
  `verify_jwt = false` in `config.toml`), as on supabase.com. Functions placed in the
  functions volume by hand keep following `FUNCTIONS_VERIFY_JWT`.
- A source deploy takes up to 20 MiB and 1000 files; a bundle up to 20 MiB compressed
  and 48 MiB unpacked.
- Download a function the way it was deployed: a bundle (the default when Docker runs)
  with Docker running and without `--use-api`, a source deploy (`--use-api`, or when
  Docker is not running) with `--use-api`. `--legacy-bundle` is not supported.
- Studio does not list functions deployed with the CLI, only those placed in the
  functions volume by hand.
- `secrets list` shows SHA-256 digests, as on supabase.com. New secrets reach functions
  on their next request. Names starting with `SUPABASE_` are reserved.
- `sso info` prints `https://<ref>.supabase.co/…` addresses, which the CLI builds
  itself.
- Hosted-only features (creating, deleting, pausing or restoring projects, branches,
  backups and point-in-time restore, custom domains, vanity subdomains, network
  restrictions, SSL enforcement, compute, notebooks) answer with an empty result or an
  error saying they are not available on self-hosted Supabase. Endpoints the CLI
  v2.122.0 does not call (migration history, read replicas, JIT access, auth signing
  keys, third-party auth, webhooks, log drains, transfers, private link, realtime and
  pgbouncer settings, reading the auth config) answer 404.
