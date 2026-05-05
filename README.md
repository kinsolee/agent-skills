# Agent Skills

A collection of automation skills for AI agents. Each skill is self-contained with its own code, dependencies, and documentation.

## Skills

| Skill | Description |
|-------|-------------|
| [sub2api-auth](skills/sub2api-auth/) | Automate OpenAI OAuth account authorization and revoked account re-authorization in sub2api |

## Usage

Each skill lives in `skills/<name>/` with its own `README.md` for usage instructions. Skills with `package.json` need `npm install` before running.

## Adding a New Skill

1. Create `skills/<skill-name>/` directory
2. Add `SKILL.md` with the skill definition (YAML frontmatter + documentation)
3. Add implementation code and `README.md`
4. Update the table above
