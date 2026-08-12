# Agent Skills

A collection of automation skills for AI agents. Each skill is self-contained with its own code, dependencies, and documentation.

## Compatibility

The account-management workflow currently supports only:

- Sub2API
- OpenCodex

Deployment hostnames, LAN addresses, and credentials belong in gitignored local configuration and must not appear in committed documentation.

## Skills

| Skill | Description |
|-------|-------------|
| [sub2api-auth](skills/sub2api-auth/) | Automate OpenAI OAuth account authorization and re-authorization for Sub2API and OpenCodex |

## Usage

Each skill lives in `skills/<name>/`. Read its `SKILL.md` before execution and reuse the bundled scripts instead of creating one-off drivers.

The current Sub2API scheduler is the Codex hourly heartbeat described in the skill's `Scheduled Reauth Automation` section. The legacy launchd job remains disabled and must not run at the same time.

## Adding a New Skill

1. Create `skills/<skill-name>/` directory
2. Add `SKILL.md` with the skill definition (YAML frontmatter + documentation)
3. Add only the scripts and references the workflow needs
4. Update the table above
