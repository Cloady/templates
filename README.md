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
