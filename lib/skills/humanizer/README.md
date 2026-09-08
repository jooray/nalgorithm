# Vendored humanizer skill

`SKILL.md` here is a **copy**, not a source file. Do not edit it in place — edit
it upstream and re-vendor, or the next sync silently reverts your change.

- **Upstream:** [`github.com/jooray/humanizer`](https://github.com/jooray/humanizer)
  (a fork of [`blader/humanizer`](https://github.com/blader/humanizer)), MIT.
- **What it is:** an editor prompt that strips the tells of AI writing —
  inflated significance, promotional adjectives, rule-of-three, em-dash overuse,
  negative parallelism, performed rigor — with a dedicated Slovak/Czech section.
- **Who reads it:** `lib/src/humanizer.ts`, via the generated module
  `lib/src/humanizer-skill.generated.ts`. The digest CLI runs it as a second
  pass over the finished digest when `humanizerApi` is configured.

## Which copy this is

Upstream's `SKILL.md` is written for an interactive agent: it can ask the user
for a writing sample, and it has invocation modes that return an audit
alongside the rewrite. This copy is the **embedded** variant — the same body
with Voice Calibration, Invocation Modes and Detect Mode removed, an explicit
"Keep the language" rule added, and an `## Output` section that says to return
the rewritten text and nothing else. That is what an unattended pipeline needs.

The same embedded variant is used by two Rails apps (Lievik and Nostr
Emanator), and all three copies are kept byte-identical, so one `md5sum` checks
them all:

```sh
md5sum lib/skills/humanizer/SKILL.md \
       ~/projects/lievik/app/skills/humanizer/SKILL.md \
       ~/projects/nostr-emanator/app/skills/humanizer/SKILL.md
```

## Updating

Producing the embedded variant from a new upstream release is a hand merge, not
a copy — do it once, in the humanizer repo, then propagate the result here:

```sh
cp ~/projects/lievik/app/skills/humanizer/SKILL.md lib/skills/humanizer/SKILL.md
npm run build:lib     # regenerates lib/src/humanizer-skill.generated.ts
```

The frontmatter is load-bearing: `version` shows up in the digest log line, and
`temperature` is the sampling temperature for the pass. Keep the flat format
(`name`, `version`, `description`, `temperature`, `max_tokens`) — the generator
parses those five keys and nothing else.

## Cost

The prompt is ~63 KB, roughly 16k input tokens on every humanize call. That is
the dominant cost of the pass; the digest it rewrites is ~2k tokens. Weigh that
before growing the file.
