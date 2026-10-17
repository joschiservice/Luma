# Engineering documentation

These guides explain what the code alone does not: the rules a feature must keep, why it
is built the way it is, its limits and failure behavior, and procedures people run. Code,
tests and search show everything else, and they stay current without anyone maintaining
them.

Start with the [codebase map](codebase-map.md) to find the owning package. Product guides
for Luma's users live in `apps/web/content/docs`. Step-by-step procedures for extending a
recurring pattern, such as adding a migration, a workspace app or an operational scenario,
are [agent skills](../.agents/skills) that people can read as well.

## Guides

**Working in the repository**

- [Codebase map](codebase-map.md): owners, conventions and the operational issue flow.
- [Local development](development.md): commands, worktrees, roles, tests and troubleshooting.
- [Performance measurement](benchmarking.md): budgets, benchmarks and fair comparisons.
- [Observability](observability.md): hosted telemetry, data policy and local Grafana.
- [Synthetic pilot](pilot-environment.md) and [commerce simulator](simulator.md).

**Platform**

- [HTTP API](api.md): contract rules, errors, probes and correlation.
- [Authentication and organization access](identity.md), with the generated
  [permission reference](permissions.md).
- [Staff access](staff.md): isolated sign-in, support grants, audit and deployment boundaries.
- [Workspace settings](workspace-settings.md): invitations, email delivery, approvals and
  personal layouts.
- [Workspace apps](apps.md): app ownership, installation, permissions and removal.
- [Model gateway](model-gateway.md): routes, profiles and model data policy.
- [Shared frontend components](frontend-ui.md) and the [design workflow](design-workflow.md).
- [Documentation and contextual help](contextual-help.md).
- [Localization](localization.md): interface languages, message rules and formatting.

**Providers and commerce data**

- [Connector capabilities](connectors.md) and
  [installed connections](installed-connections.md).
- [Shopify connector](shopify.md), [Shopify actions](shopify-actions.md) and
  [Shopify partner readiness](shopify-production.md).
- [JTL-Wawi connector](jtl.md) and [Cin7 Core connector](cin7.md).
- [Starshipit shipping](starshipit.md): handoff evidence and unshipped corrections.
- [Gmail connector](gmail.md): Google authorization, rule-scoped mailbox reads, sends and
  push.
- [Canonical commerce projections](commerce-projections.md) and
  [commerce sync](commerce-sync.md).

**Issues and resolution**

- [Exception taxonomy](exception-taxonomy.md): the versioned detection rules and golden
  cases.
- [Detection](exception-detection.md), [diagnosis](exception-diagnosis.md) and
  [durable exception workflows](exception-workflows.md).
- [Case inbox](case-inbox.md) and [case decisions](case-decisions.md).
- [Policy, execution and audit](execution.md).
- [Shadow Mode](shadow-mode.md), [resolution learning](resolution-learning.md) and
  [verified outcomes](resolution-measurement.md).

**Workflows and procurement**

- [Workflow model](workflows.md): contracts, authoring, triggers, readiness and case
  workflows.
- [Sandboxed Code Steps](code-steps.md) and the
  [legacy Resolution workflow format](resolution-playbooks.md).
- [Replenishment](replenishment.md), [procurement records](procurement.md) and
  [supplier commitments](supplier-commitments.md).
- [Operations inbox](messaging.md): mailbox rules, reading, thread work, links and the
  procurement handoff.
- [Ask Luma assistant](assistant.md).

**Workspaces and metrics**

- [Adaptive workspaces](adaptive-workspaces.md): typed fields, saved queries, governed actions and operational packages.

- [Operations overview](operations-overview.md), [Needs you](needs-you.md) and
  [Workspace Activity](workspace-activity.md).
- [Orders](orders-workspace.md), [Products](products-workspace.md),
  [Inventory](inventory-workspace.md), [Customers](customers-workspace.md),
  [Fulfillment](fulfillment-workspace.md) and [Returns](returns-workspace.md) workspaces.
- [Operational metrics](operational-metrics.md): definitions, live delivery and limits.
- [Operational insights charts](operational-insights.md).

## Writing guides

A guide earns its place when a capable engineer or agent reading the code would otherwise
get something wrong. Write it for that reader.

**Keep:**

- Rules and invariants: what counts as "overdue", which source wins, what is never
  written, what Unknown means and when it is shown.
- States and failure behavior: partial reads, stale or uncertain results, retries,
  restarts, recurrence, what a timeout or unavailable dependency produces.
- Authority and isolation constraints: who may do what, tenant scoping, approval and
  verification requirements that are easy to bypass by accident.
- Limits and their reasons: page sizes, timeouts, caps, budgets and the workload they
  were checked against.
- Traps: non-obvious coupling, ordering requirements, things that look safe to change but
  are not.
- Procedures people run: setup, credential rotation, recovery, backfills that remain
  supported. Procedures for extending a recurring pattern belong in a skill instead (see
  [Skills and directory instructions](#skills-and-directory-instructions)).

**Leave out:**

- File, function, route, table and migration catalogs. Name the owning package once if
  it helps; the reader finds files by searching. Skills may list the files to touch.
- Test lists and validation command blocks. Tests are colocated with the code they
  verify; general commands are in [local development](development.md). Mention a command
  only when it is not discoverable, such as an opt-in benchmark variable.
- Dated measurements, benchmark tables, raw-output paths and screenshots. Put the evidence
  in the pull request or Linear issue; keep the resulting limit and how to re-measure.
- Linear ticket IDs, acceptance checklists, rollout steps for finished migrations and
  "previously…/now…" history. Linear and Git hold project history.
- Field-by-field schema descriptions. The contract schemas are the reference.
- UI walkthroughs. Explain user tasks in the product guides.

**Shape:**

- Open with what the feature is and what it guarantees, in two or three sentences.
- One guide per feature area. Extend the existing guide instead of adding a file per
  change, and split by concern, not by pull request. Most guides stay under 150 lines.
- Use short sentences, concrete terms and tables only for genuinely tabular rules.
- Draw flows, lifecycles, sequences and topology as diagrams (see [Diagrams](#diagrams))
  rather than describing them only in prose.
- Explain local implementation details in code comments next to the code instead.
- Record cross-cutting decisions with their alternatives as
  [architecture decisions](architecture/README.md).

**Maintain:**

- Update or delete guidance, including diagrams, in the same change that makes it
  inaccurate.
- Add new guides to the index above with a one-line description.
- `pnpm test:architecture` checks relative links, heading anchors and repository paths in
  backticks across Markdown files.

## Diagrams

Diagrams give a reader the shape of a feature before its rules. Write them as Mermaid in a
fenced `mermaid` block: GitHub renders them, reviewers see changes in the diff, and agents
read them as text.

- Use `flowchart` for flows and decisions, `stateDiagram-v2` for lifecycles and
  `sequenceDiagram` for interactions between processes and providers.
- Draw only what the code does. Name states as the code does, show the failure, uncertain
  and stale paths the guide's rules depend on, and update the diagram when the code changes.
- One idea per diagram, ideally no more than 15 nodes. Prefer `TD` for chains longer than
  about six steps and keep sequence diagrams to five or six participants: GitHub scales a
  diagram to the page width, so wide diagrams become unreadable.
- Don't style diagrams (`classDef`, `style`, colors, themes or init directives). GitHub picks
  colors for its light and dark themes; custom ones break one of them.
- Put the diagram after the opening summary or in the section it explains, followed by the
  rules. A diagram supplements rules; it never replaces them.
- Render a changed diagram before review, for example in GitHub's preview or the
  [Mermaid live editor](https://mermaid.live).

## Skills and directory instructions

Agents and people share two other kinds of guidance:

- **Skills** in `.agents/skills/<name>/SKILL.md` (`.claude/skills` links to the same
  directory) are procedures for extending a recurring pattern. The `description` in the
  front matter says when to use the skill; agents load the full text only when a task
  matches. A skill links to the guides that hold the rules instead of repeating them.
- **Directory instructions** in an `AGENTS.md` next to the code hold local rules and traps for
  work inside that directory, and link to its guides. The root `AGENTS.md` holds the rules
  for the whole repository.

`pnpm test:architecture` also checks that each skill's front matter names its directory and
describes when to use it, and that diagrams carry no styling.
