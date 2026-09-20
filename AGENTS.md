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

# Readability and organization

- Add a short doc comment to exported functions and callable contracts. Explain behavior and any input requirements, side effects, or failure modes callers need to know. Do not repeat TypeScript types or add empty documentation tags.
- Keep imports together at the top. Separate declarations and logical steps with blank lines. Run `pnpm lint:fix` and `pnpm format` to apply automated style fixes.
- Keep business rules in domain files, use cases and ports in application files, and database or provider access in infrastructure files. Name files for their responsibility and colocate focused unit tests.
