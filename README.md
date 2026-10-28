# Cloady Templates

The application catalog for [Cloady](https://cloady.com), as plain compose projects.

Every top-level folder is a standard, locally runnable Docker Compose project named
after its catalog slug:

```
supabase/
  docker-compose.yml   the template - vanilla compose, no custom extensions
  configs/             files referenced by the compose configs section
  cloady.json          Cloady manifest: optional catalog name, hint and
                       category, envSchema (titles, secrets, generate directives),
                       profileSchema (how compose profiles are picked) and
                       an icon reference - any deployed repo may carry one too
  icon.png             catalog tile icon
```

The compose file is the contract: `cd supabase && docker compose up` works with no
Cloady knowledge. The sidecars are additive - deleting them leaves a working compose
project. Cloady-specific behaviour derives from native compose semantics only:
`ports:` are public, `expose:` is private, volume sizes come from
`volumes.<name>.driver_opts.size`, and a service declaring `env_file: [".env"]`
receives the app's environment variables at deploy time.

## Publishing

CI validates every changed project and publishes it as an OCI artifact to
`ghcr.io/neptolab/cloady-templates/<slug>:<version>`.

## Updates

Renovate keeps the images current. `.github/workflows/renovate.yml` runs it every two
hours with the repository secret `RENOVATE_TOKEN`, and `renovate.json` holds the rules:

- One pull request per template. A minor or patch update merges by itself once the
  template's smoke test passes. A major update waits until someone ticks it on the
  Dependency Dashboard issue.
- Databases, caches, search engines and message brokers never change major. n8n and
  Zipline stay on the major their catalog names state, and Supabase keeps the set of
  images its upstream compose pins.
- A release is proposed once it is three days old.
- When an update moves the image that `cloady.json`'s `version` follows,
  `.github/scripts/bump-template-version.mjs` moves `version` with it in the same form
  (`v1.2.3` → `1.2.3`, `1.2.3-alpine` → `1.2.3`).

The control plane's catalog shows the new version after the next `npm run catalog`.

## Tests

`.github/workflows/test-templates.yml` smoke-tests every template a pull request
changes, and runs from the Actions tab for a list of templates or `all`.
`.github/scripts/smoke-test.mjs` starts a template the way Cloady deploys it: the
variables `cloady.json` generates and defaults, the `CLOADY_*` system variables with
`localhost` as the address, the default profiles, each container limited to the CPU
and memory Cloady gives it at the default scale, every service started at once and
restarted when it exits (Cloady ignores `depends_on`), published ports on random host
ports, and volumes without `driver_opts`, which Docker's local driver can't size.

A template passes once every container has run for 30 seconds without restarting or
failing its healthcheck, and every published TCP port answers with an HTTP status
below 500 or accepts a connection. It fails after five restarts of any container, or
after 10 minutes (`SMOKE_WAIT_SECONDS`).

## Syncing into a Cloady control plane

From a Cloady checkout with its `.env`:

```
npm run catalog -- --dry-run   # show what would change
npm run catalog                # apply it
```

The control plane keeps its `applications` table as a cache of this repo. The sync
adds a row for every folder whose template loads, takes `name`, `hint` and `category`
from `cloady.json` when they are set (a new folder without them is named after its
slug), records each template's services and default footprint, removes rows whose
folder is gone, and never touches install counts. `category` is one of the sixteen
the catalog lists: Databases, Backends, CMS & Websites, Game Servers, AI & LLM,
Developer Tools, Analytics, Monitoring, Storage, Communication, Security, Automation,
Media, Networking, Productivity or Desktops. A folder whose
template fails to load is reported and left alone. Deployed instances snapshot their
template at install time and are never affected by catalog updates.

## Provenance

Most templates originate from upstream compose collections; provenance and
install counts live in the Cloady control plane.
Config files vendored from upstream projects (for example Supabase's kong.yml
and SQL bootstrap, Apache-2.0) retain their original licenses. See LICENSES.md.
