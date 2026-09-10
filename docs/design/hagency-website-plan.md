# Hagency website: research and delivery plan

Prepared 2026-09-08. Status: proposal for operator review. This document plans
the website; it does not report website implementation or publication.

Visual direction updated 2026-09-08 following the operator's selection of
[ymote/adora-website](https://github.com/ymote/adora-website) as the reference.
Its source, both generation scripts, generated images and deployed desktop
hero were inspected at revision `44ff68f`, matching public `main`.

## 1. Direction

Build Hagency as the umbrella for an open source collaboration ecosystem where
people direct work, agents execute it, and the conversation connects the team.
Give Hagency, Robrix2 and Palpo equally substantial product pages while showing
why their combination is useful.

Proposed headline: **Your team. Your agents. Your infrastructure.**

Proposed supporting copy: **Bring people and coding agents into a shared
workspace. Collaborate in Robrix2, run agents with Hagency, and connect your
team through Palpo and Matrix—with people setting the direction.**

Primary action: **Explore the workflow**. Secondary: **Get started**.
Every project page also exposes its repository and documentation directly.

Assumptions for this proposal: English and Simplified Chinese at launch;
developers and self-hosters as the first adoption audience; team leads get
plain-language explanations before technical depth. The operator was invited
to steer audience priority; no response was available when this draft was written.

Brand spelling: use **Hagency** for the website, **Hagency**, **Robrix2**, and
**Palpo** for the projects. Explain that Robrix2's application and release
assets currently use the name Robrix. Preserve the separate project communities,
licenses and upstream acknowledgments; an ecosystem site does not imply common
legal ownership of every project.

## 2. What the latest-project check established

Read the local checkouts, project contracts, accepted decisions, recent validation
reports, existing book and public repository/release information. Fetched remote
refs without checking out or merging branches. Public and local development lines
have diverged, so neither one substitutes for the other.

| Project | Public default branch inspected | Latest published release found | Local integration revision inspected |
| --- | --- | --- | --- |
| Hagency | `master`, `4fb9749`, September 7 | [v1.2.0](https://github.com/hagency-org/hagency/releases/tag/v1.2.0), July 30 | `c380959`, September 8, `fix/spec-review-closure` |
| Robrix2 | `main`, `e28e118e`, August 30 | [v1.1.0](https://github.com/Project-Robius-China/robrix2/releases/tag/v1.1.0), July 22 | `88ebf221`, September 8 |
| Palpo | `main`, `c96c8e33`, September 7 | [v0.4.0](https://github.com/palpo-im/palpo/releases/tag/v0.4.0), July 7 | `c8748200`, September 8, `feat/hagency-admin-web` in the separate admin worktree |

The primary Palpo checkout remains at `3e4fbd33`; its admin worktree contains
the new website-relevant integration. Hagency is 2 local-only / 27 remote-only
commits from the fetched default branch; Robrix2 is 3 / 67; the Palpo admin
worktree is 1 / 7. These counts describe divergence, not feature quality.

### Hagency: operate and contribute agent capacity

Its public foundation is a local agent control plane with lifecycle management,
messaging, tasks, human approvals, a Matrix bridge and remote relay support.
Recent public work addresses task completion, Matrix membership recovery and
accurate dashboard runtime/usage presentation. [Public repository](https://github.com/hagency-org/hagency).

September 8 local work adds a particularly useful promotional story: configure
resources, define named agents, publish available roles, approve project requests,
and provision or reuse a qualified agent. Recent reports also cover durable
thread follow-ups, ordinary agent DMs, invited-room handling, visible runner
activity, bidirectional files and scoped execution approvals. These should appear
as tested development capabilities until included in a verified public release.

The contributor console answers what capacity is offered, allocated and observed.
Do not turn its marketing into a central scheduling dashboard or a paid compute
marketplace. Token allocation, observed usage and monetary billing are different
concepts; full runtime budget enforcement must not be implied.

Evidence: `knowledge/decisions/adr-022` through `adr-028`, the corresponding
`specs/task-*` files, and September 8 reports under `docs/reviews/`. Existing
native lifecycle skips are explicitly non-passing; focused test evidence is
recorded separately and does not establish universal release readiness.

### Robrix2: the native collaboration experience

Robrix2 is a Rust Matrix client using Makepad and the Matrix Rust SDK. Its
project materials describe rooms, spaces, threads, mentions, rich messages,
reactions, encrypted messaging and device verification. Public recent work also
addresses spaces, room aliases and thread timeline lifecycle.
[Public repository](https://github.com/Project-Robius-China/robrix2).

The local integration adds native owner approval interactions, scoped approval
choices, member refresh and recovered file downloads, including encrypted
attachments. Use the September 8 native validation reports as evidence for that
development build. The current integration was demonstrated on macOS; do not
infer equivalent validation on every platform from source build support.

Verified v1.1.0 release assets include macOS ARM64/x86-64 DMGs, Linux ARM64/x86-64
DEBs, a Windows x86-64 EXE and Android ARM64 APK. The release inspected has no
iOS binary. Treat iOS as a source-build path and OpenHarmony as experimental
according to current project guidance. The client requires native Sliding Sync
support from its homeserver. Installer scripts and package-manager registration
described as future availability must not become primary website install buttons.

### Palpo: the Matrix server and integration foundation

Palpo is a Rust Matrix homeserver using Salvo and PostgreSQL, with client/server
and federation functionality, Docker deployment and application-service support.
The September 7 public change keeps transaction IDs private to event senders.
[Public repository](https://github.com/palpo-im/palpo).

The separate local `web-admin/` implementation adds browser workflows for server
administrators, fleet owners and project members: authorize a fleet, pair it,
verify a real event round trip, register a project and private approval room,
request a role, and track actual admitted agent identity. This is a separate
Node service beside the homeserver, not a built-in Rust server UI already
present in the v0.4.0 release.

Palpo's own README explicitly says large-scale production operational evidence
is still missing. Promote its architecture and evaluation paths accurately;
avoid unsupported performance comparisons or production-maturity claims.
Credential rotation and fleet-wide runtime stop acknowledgment remain admin
integration gaps. [Existing Palpo website](https://palpo.im/).

### Existing material to reuse after review

- Robrix2 contains a bilingual HAgency mdBook with architecture, deployment,
  approvals, threads, team workflows, operations and screenshots. Its older
  `agent-chat` naming and several behavior descriptions need revision against
  the selected current implementation before publication.
- Hagency has extensive console screenshots under `docs/design/shots/`. A sampled
  resource screenshot still shows the earlier manual agent-onboarding flow;
  it is visual reference, not proof of today's resource-first workflow.
- Robrix2 includes native logos and book screenshots. Preserve attribution and
  verify their revision before reuse.
- Palpo already has bilingual public documentation. Link its detailed server
  reference, while Hagency owns the integrated three-project walkthrough.

## 3. Audiences and conversion paths

| Visitor | What the site should answer | Intended next step |
| --- | --- | --- |
| Developer | How do I run useful agents and work with them? | Follow the Hagency quickstart or install Robrix2 |
| Team lead | How does the team coordinate work and retain control? | Explore the annotated workflow, then team setup |
| Resource contributor | How do I offer agent capacity to projects? | Read resource configuration and allocation guidance |
| Matrix administrator | How do I host this and connect a fleet? | Follow Palpo deployment and fleet integration guidance |
| Open source contributor | Where can I help, and who maintains each part? | Open the relevant repository, contribution guide or issue list |

The homepage should explain the value within its opening screen. Deeper pages
should make prerequisites and maturity discoverable at the action that needs them.

## 4. Information architecture

Use `/en/` and `/zh-cn/` as canonical locale prefixes. The paths below are
relative to each locale. The root should provide a predictable default with an
explicit language switch; switching preserves the corresponding page.

| Route | Purpose and planned content |
| --- | --- |
| `/` | Unified promise, workflow preview, three projects, audience paths, latest verified updates, adoption actions |
| `/ecosystem/` | Interactive architecture, responsibility boundaries, data flow, combined and standalone deployment choices |
| `/projects/hagency/` | Resource contribution, agents, tasks/threads, oversight, console tour, setup and availability |
| `/projects/robrix2/` | Native collaboration, rooms/spaces/threads, media, approvals, platform matrix and downloads |
| `/projects/palpo/` | Matrix hosting, Rust/PostgreSQL architecture, federation, application services, admin integration preview and deployment |
| `/demo/` | Guided example of a person requesting work, an agent executing, permission review and a returned artifact |
| `/use-cases/` | Team coding/review, contributed agent capacity, and self-hosted collaboration, each with a concrete walkthrough |
| `/get-started/` | Goal-based chooser: use the client, run agents, host Matrix, or assemble the stack |
| `/downloads/` | Verified project releases, platform/architecture selection, prerequisites, release notes and checksums where supplied |
| `/docs/` | Searchable integration guides, prerequisite map and links to authoritative project reference |
| `/security/` | Human authority, approval scopes, encryption boundaries, model-provider data flow and deployment assumptions |
| `/updates/` | Curated release and development notes with project filters, dates, sources and RSS |
| `/roadmap/` | Released, development preview and planned work, with evidence or issue links |
| `/community/` | Contribution paths for code, docs, design, translations and testing; verified community links |
| `/about/` | Hagency's human-agency philosophy, project origins, maintainers and acknowledgments |
| `/media/` | Approved logos, screenshots, descriptions and a compact project fact sheet for sharing |

Navigation: **Projects · How it works · Use cases · Docs · Community**, followed
by language/theme controls and **Get started**. Keep release status and downloads
easy to reach from each project. A site search should cover both marketing pages
and guides while keeping language results clear.

## 5. Homepage narrative and visual hierarchy

1. **Opening screen:** an Adora-style full-height generated geometric background,
   large centered Hagency wordmark, the headline and supporting copy rendered
   as HTML. Start the guided workflow with one action. A compact project row
   makes Hagency, Robrix2 and Palpo immediately discoverable. Product captures
   appear in the subsequent workflow and product sections.
2. **A task moving through the system:** a human request in Robrix2, a project
   room on Matrix, a Hagency agent working, a private approval when needed,
   and a result delivered into the same task thread.
3. **Three substantial product introductions:** each gets a visual, short
   purpose, three concrete capabilities, availability note and project action.
4. **People direct the work:** show how someone follows progress, responds
   to a request for permission and continues the conversation. State what the
   tested runtime actually supports rather than promising arbitrary interruption.
5. **Choose your starting point:** client user, agent operator, server admin
   or team adopter. Each path has prerequisites and a clear next step.
6. **Evidence and activity:** real screenshots, selected sourced release notes
   and contributions. Technical validation belongs in linked detail, not
   a row of unexplained test-count badges.
7. **Join the ecosystem:** documentation, downloads, repositories and contribution
   links. Avoid a waitlist when people can already install or inspect projects.

## 6. Project-page content requirements

All three pages share a consistent structure: promise, product screenshot,
capabilities grouped by user goal, workflow, architecture, availability, setup,
FAQ and links. Each must stand on its own for search visitors.

**Hagency page:** explain configuring resources and named definitions; publishing
roles; approving requests and selecting qualifying resources; on-demand agent
provisioning; thread-scoped work and follow-ups; collaboration and delegation
where demonstrated; observable activity; files; and contributor control over
permissions. Show provider controls separately from the borrower's project
experience. Document local and remote layouts and the optional Matrix bridge.

**Robrix2 page:** lead with the experience of conversations, task threads,
spaces, mentions and shared files. A native approval card is a distinguishing
integration feature. Include light/dark and desktop/mobile examples only where
we can capture the relevant build. Explain standalone Matrix use and the
additional Hagency integration. Platform tables distinguish a tested source
build, an available installer and an experimental target.

**Palpo page:** lead with operating your own Matrix communication infrastructure.
Explain accounts, rooms, media, federation, PostgreSQL operations and application
services. Introduce the admin integration through its three human roles and
the verified connection/request workflow. Place server deployment guidance
beside the existing Palpo docs; name the companion admin service explicitly.

Shared FAQ: Must I install all three? Can I use another Matrix client/server?
What requires Robrix2's native UI? Which features are in the downloadable release?
What stays on my machine and what reaches a model provider? Which rooms support
encryption in the demonstrated workflow? What does a token allocation mean?

## 7. Demonstration and media plan

Create an interactive, deterministic walkthrough using an example repository
and example identities. Label it **Interactive walkthrough**. It illustrates
the software without presenting fabricated events as a live production session.
Pair it with screenshots or a recording of the corresponding tested build.

Sequence:

1. Configure a resource and publish a role in Hagency.
2. Register a project and request that role through the Palpo admin integration.
3. Show manual provider approval and verified agent admission.
4. In Robrix2, mention the agent with a small, understandable task.
5. Show the task thread and a visible activity update.
6. Move to the separate owner approval conversation when the example operation
   requires it; explain the requested scope before showing available decisions.
7. Return a small file and test result into the task thread.
8. Continue the same task with a follow-up and link to the complete setup guide.

Interaction: step forward/back, replay, switch the highlighted product, inspect
short annotations and follow documentation. Keyboard navigation and a static
transcript provide the same explanation. Reduced-motion mode avoids animated
transitions. No live model calls or user credentials are required.

Capture list: Hagency resources/definitions, pending request and active agent;
Palpo connection verification and project request; Robrix2 project room, thread,
activity update, scoped approval and downloaded artifact. Record revision,
platform, language and capture date. Use isolated example accounts and exclude
private names, server addresses, tokens, host paths and real project content.
Existing historical captures are candidates, not automatically publishable assets.

## 8. Visual direction

### Selected reference: Adora

The operator explicitly likes the Adora website style. Adopt its charcoal
background, amber hero title, teal headings and links, oversized regular-weight
type, restrained monospace navigation, generous space and delicate geometric
imagery. Its broad illustrated sections, translucent panels and interactive
architecture diagrams also fit the comprehensive Hagency content.

Reference palette: charcoal `#0A0A0F`, secondary `#12121A`, teal `#00D4AA`,
amber `#FFB84D`, and off-white text `#E8E8F0`. Use the reference's pale
`#F5F5FA`/`#EAEAF2` surfaces and deeper teal for the light counterpart. Carry
Hagency teal, Robrix2 blue and Palpo amber into diagrams and small project
identifiers without overriding the coherent site palette.

Use Geist-style large, regular-weight headings and monospace section labels,
with licensed self-hosted fonts and a readable CJK companion. Preserve existing
project logos; create a Hagency wordmark and connection motif. Keep thin borders,
subtle hover effects and selective scroll reveals. Reduced-motion and no-JavaScript
paths retain readable content. Support system, light and dark preferences; the
reference itself has black, indigo-dark and light choices.

### Hero-generation scripts inspected

- [generate-hero.cjs](https://github.com/ymote/adora-website/blob/44ff68f/generate-hero.cjs)
  uses `@google/genai`, `GEMINI_API_KEY`, and the configured model
  `gemini-3.1-flash-image-preview`. It calls `generateContent` with IMAGE/TEXT
  modalities, decodes returned inline image bytes and writes `public/images/hero-bg.png`.
- [generate-hero-light.cjs](https://github.com/ymote/adora-website/blob/44ff68f/generate-hero-light.cjs)
  separately generates `hero-bg-light.png` with a pale background and darker lines.
- Both prompts request a landscape image with Renaissance proportion studies,
  fine network paths, restrained colors and a quiet text area. The generated
  picture contains no typography. Both scripts allow three attempts and back off
  after rate-limit errors. They are offline authoring scripts, not browser code.
- The scripts request 1920×1080 only in prose; both inspected PNGs are actually
  **1376×768**. The dark file is about403KiB and light about550KiB. A new
  generator must inspect its actual output instead of treating the prompt's
  dimensions as a guarantee.
- `Hero.astro` puts HTML typography and buttons above a full-height, cover-cropped
  image, swaps dark/light artwork with theme CSS, and adds a subtle overlay for
  legibility. The centered heading grows from56px to120px. The prompt asks for
  empty center-left space, while the actual layout centers text; Hagency's brief
  should explicitly reserve the full central text area, including mobile crops.

### Hagency artwork adaptation

Generate original dark and light backgrounds in the selected visual style. The
subject is the human/agent collaboration network: a small human-directed focal
structure linked to three families of nodes, suggesting conversations, agent
work and federated infrastructure. This is abstract decorative art; the subsequent
interactive architecture supplies the precise explanation and labels.

Draft generation brief:

> Wide landscape background for Hagency, an open source human-and-agent
> collaboration ecosystem. Fine, restrained geometric linework inspired by
> Renaissance engineering diagrams and modern network drawings. Arrange three
> connected constellations around the outer edges, with proportion circles,
> delicate branching paths and a subtle golden-ratio composition. Suggest a
> human-directed network of conversations, agents and independent servers.
> Keep the middle60% quiet and nearly empty for a large centered headline,
> supporting paragraph and buttons. Concentrate detail toward the upper-right
> and lower-left, and preserve a clear central crop for a tall mobile viewport.
> Deep charcoal background, faint teal lines, occasional amber highlights and
> restrained blue depth. Elegant, precise, spacious and low contrast. No text,
> letters, numbers, logos, interface panels, robot characters or photographic
> people. The result is decorative background artwork.

Create the light counterpart from the selected composition with a pale
lavender-white field and darker teal/amber strokes. Prefer a reference-based
variant to keep theme switching compositionally consistent. Preserve the exact
prompt, reference and generation metadata in the website project. The model
named above describes the inspected script, not an assumption of future access.

Keep source PNGs and export appropriately sized WebP/AVIF variants after visual
inspection. Check the actual dimensions, aspect ratio, central clear space,
English/Chinese contrast and desktop/mobile crop. Load the needed theme image
efficiently and use a static color backdrop while it loads. All text, project
names and buttons remain real HTML for localization and accessibility.

### Content below the hero

Use precise diagrams and real UI crops inside wide illustrated product sections,
with translucent panels used selectively for short explanations. Screenshots
should expand on demand rather than becoming unreadable thumbnails. Generated
backgrounds supply atmosphere; product screenshots retain the original pixels
of the tested product UI and their revision labels.

Mobile behavior: stack the architecture vertically, convert the demo into a
step sequence, keep download selection accessible, and allow deliberate
horizontal scrolling only inside code blocks and necessary comparison tables.

## 9. Documentation and launch editorial package

Initial integrated guides:

1. Understand the three projects and choose a deployment path.
2. Install Robrix2 and connect to a compatible homeserver.
3. Run Hagency locally and configure an initial resource.
4. Deploy Palpo with PostgreSQL and verify Matrix access.
5. Pair a fleet and verify event delivery in the development admin integration.
6. Register a project, establish ownership and request an agent.
7. Work in a task thread and continue with follow-ups.
8. Review execution permissions and manage supported approval scopes.
9. Exchange files and understand encrypted attachment behavior.
10. Operate the stack: updates, logs, recovery, backups and common failure states.

Every guide names its applicable release or tested development revision and
shows the expected successful result plus common recovery steps. Commands must
be checked against that version, especially older `agent-chat` naming in the book.

Launch articles: **Introducing Hagency**, **From project request to agent result**,
and **Why the stack uses Matrix**. Publish those alongside concise release notes,
not as unsupported customer case studies. English and Chinese carry equivalent
meaning, commands and status qualifications.

## 10. Website implementation proposal

Create a dedicated managed website project at `projects/hagency-website/`, with
its own repository boundary and task contract. Confirm whether that directory
is a copy or symlink when provisioning it. This source checkout has no existing
managed `projects/` tree; this is a proposed destination, not a provisioned path.
Keep the promotional site independently buildable from the live Hagency console.

Recommended stack: **Astro + TypeScript + Markdown/MDX**, with React islands for
the interactive workflow and selectors. Use a small CSS token system and optional
Tailwind utilities if useful during implementation. Astro's content-first model
and locale routing fit this mostly static, bilingual site.
[Astro rationale](https://docs.astro.build/en/concepts/why-astro/),
[Astro i18n](https://docs.astro.build/en/guides/internationalization/).

The selected Adora reference already uses Astro, Tailwind v4, React and React
Flow. Its structure is a useful implementation reference for the same stack.
Use Hagency's own content, shared locale-aware components and base-aware asset
paths. Image generation is an authoring step; the shipped site serves static
assets and needs no image-provider credentials.

Structure content into projects, capabilities, releases, guides and updates.
Each capability record carries project, locale, maturity, source URL, applicable
revision, last verification date and supporting screenshot. A single release
manifest supplies all download buttons so versions do not drift across pages.

Generate a static site with a client-side search index. Pre-render substantive
content; load interactive code only on pages that need it. Build release metadata
from a reviewed snapshot of repository releases. Failed refreshes must leave a
dated, explicitly last-verified record rather than claim a successful live check.
The public browser needs no repository API token or application credentials.

CI: build and type checks, content-schema and translation completeness checks,
internal links, external download verification, browser navigation and keyboard
checks. Add interaction tests where they verify meaningful state transitions;
do not create tests that merely repeat static page copy.

The static output should work on common static hosts. Select the production host
and domain when a working preview is reviewable. Site creation does not require
changes to current Palpo or Hagency runtime services.

## 11. Discoverability, accessibility and maintenance

- Give each project a descriptive title and summary, canonical URL, localized
  alternate links, social preview and appropriate software metadata. Generate
  sitemaps and RSS; exclude private preview deployments from indexing.
- Target natural topics such as coding-agent coordination, a native Rust Matrix
  client, PostgreSQL Matrix hosting and human oversight of agent work. Avoid
  search pages with duplicated promotional copy.
- Target WCAG 2.2 AA: readable contrast, visible focus, logical landmarks,
  labeled controls, keyboard-complete demos, captions/transcripts and meaningful
  image descriptions. Verify both languages at mobile and zoomed layouts.
- Performance targets: mobile Lighthouse performance/accessibility/SEO at least
  90 in controlled runs, initial compressed route JavaScript below 150 KB,
  responsive image sizing, and no blocking video. Treat lab scores as lab
  evidence; assess real Core Web Vitals after sufficient public traffic exists.
- Measure useful adoption actions if analytics are enabled: project exploration,
  walkthrough completion, guide entry, release download and contribution clicks.
  Do not invent baseline traffic, conversion lifts, testimonials or user counts.
- Refresh releases before launch and on a regular maintenance cadence. Review
  changed claims with source links; keep historical update dates stable. A
  public road map should reflect maintainer commitments, not this site's wishes.

## 12. Delivery sequence and completion criteria

| Stage | Deliverable | Completion criterion |
| --- | --- | --- |
| 1. Evidence and content baseline | This plan, claim inventory, source/release records and asset shortlist | Each project has a dated baseline and clear development/release distinction |
| 2. Visual prototype | Original generated dark/light hero artwork, Adora-inspired homepage plus one full project page, shared tokens and navigation | Reviewable browser preview with real copy, selected artwork, theme behavior and mobile crops |
| 3. Complete core site | All three project pages, ecosystem, use cases, get-started, downloads and community | Every primary visitor path ends at a valid guide, release or repository |
| 4. Demonstration and knowledge | Interactive walkthrough, integrated guides, security explanation and initial articles | Demonstration has accessible controls/transcript; guide steps match pinned versions |
| 5. Bilingual and release checks | Equivalent English/Chinese content, search, metadata, link audit and browser review | No missing translations, broken primary actions or mislabeled release capabilities |
| 6. Publication preparation | Deployable static output, host/domain configuration proposal and maintenance notes | Operator can review the finished preview and concrete publishing configuration |

First implementation milestone should be the homepage, ecosystem section and
one complete project page so the visual direction is inspectable early. The
full launch scope includes the remaining pages and guides above; these are
subsequent milestones rather than omissions from the requested comprehensive site.

Planning estimate: approximately 8–12 focused working days for the full bilingual
editorial scope, assuming access to reproducible demonstration builds and prompt
content review. This is a scope estimate, not a delivery commitment; fresh product
recordings, translation review and integration release preparation may dominate.

Final website acceptance: all primary routes work on desktop and mobile; each
project has a substantive independent page; language switching retains context;
downloads match actual available assets; every development-only claim is labeled;
the demo completes by keyboard; current screenshots match their stated revisions;
links/build checks pass; publication configuration is reviewable. Product test
counts, federation benchmarks and production readiness remain separate evidence.

## 13. Decisions to carry into implementation

Proceed with developer-first English/Chinese content unless the operator changes
the audience preference. Keep the three projects prominent and the human-directed
workflow central. Prefer a static, independent website and a deterministic demo.

Before publishing a feature demonstration, select the exact interoperable
revisions to showcase; the inspected local branches are not a merged release.
Recheck available binaries and their capabilities. Confirm the public community
destination, approved brand assets, production domain and hosting target against
the finished preview. These choices do not block the proposed local prototype.

## Research scope

This was a repository, release and documentation inspection, not a fresh product
test run. Existing test and live-validation reports were read as dated evidence.
No models were invoked, applications restarted, native user profiles accessed,
or product branches merged. The source-root `AGENTS.md` is a workspace template;
`./task-writer`, `docs/projects.md` and `docs/plan.md` are not provisioned here.
No canonical control-plane task state was fabricated.

## Implementation delivered — September 8, 2026

English and Simplified Chinese were confirmed by the operator and implemented
in projects/hagency-website. All 16 core routes, 10 guides, and 3 introductory
articles exist in each language (58 content pages). The site includes original
matching dark/light generated hero artwork and the selected Adora-inspired
visual direction, functional walkthrough/search/download filtering, localized
metadata and feeds, responsive navigation, and a local static preview.

Preview: http://127.0.0.1:4328/en/ · http://127.0.0.1:4328/zh-cn/

Typecheck/build and all eight Node browser tests pass. Native agent-spec skips
are documented separately. See the website README and docs/verification.md for
reviewable evidence and maintenance. Project screenshots were implemented as
explicitly labeled conceptual HTML visuals, preserving accuracy across differing
release and development baselines. Public deployment remains a separate action.
