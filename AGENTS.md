# Writing conventions

- Write API descriptions and user-facing strings for the people using them: explain capabilities, expected behavior, and necessary usage details.
- Keep implementation choices, project history, and scope disclaimers in engineering documentation.
- Write code comments for maintainers: explain purpose, behavior, or a non-obvious constraint. Avoid narrating the code or describing hypothetical future work.
- Use short, direct sentences and concrete terms. Describe what something does; mention limitations only when they affect correct use. Keep claims accurate.

# Branch naming

- Use `feat/<LINEAR-TICKET-ID>-<short-description>` (e.g. `feat/LUMA-123-add-project-search`).
- Keep the Linear ticket ID uppercase and the description concise, lowercase, and hyphen-separated.

# Code quality

- Prefer simple, explicit, readable code over clever abstractions.
- Keep functions, modules, and components focused and easy to change.
- Use clear names and predictable interfaces.
- Avoid premature abstractions, unnecessary dependencies, and hidden side effects.
- Follow existing project patterns unless there is a strong reason not to.
- Test important behavior and edge cases.
- Keep changes scoped and leave the codebase cleaner than before.
