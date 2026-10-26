# Changelog

## v3 (October 2026)

First end-to-end run with mocked ServiceNow.

**Fixed**
- Manager forms never received the onboarding ID: the HTML node wrapped the markup in backticks and used `${}`, which n8n renders literally. Forms are now Code nodes that build the page.
- Name, start date, manager and type were lost between form display and submit. All seven hire fields now travel as hidden inputs.
- Hire context was dropped when tasks were generated, so REQ/RITM/SCTask records had no onboarding ID or employee.
- Both Split in Batches loops were wired backwards (the "done" output fed the create step, the "loop" output fed itself).
- Nothing aggregated REQ, RITMs and SCTasks into the summary.
- Team grouping keyed on a `team` field no task had, so every team group was empty.
- Gmail nodes replace their input item with the send result; nodes after them read blank values. Every post-Gmail step now reads from the node before it.
- Monitor and Dock could never be requested: the form had no control for them.

**Changed**
- Split in Batches loops replaced by fan-out Code nodes. n8n runs the next node once per item, which is also how the ServiceNow calls will run.
- One Gmail node now sends one email per team that has work, listing that team's SCTasks, instead of four chained nodes that always emailed every team.
- The manager gets an acknowledgement page as soon as the form is submitted, instead of waiting for the whole provisioning run.
- Form link built once, URL-encoded, from a single `BASE_URL` setting. Forms post back with a relative path.
- `employmentType` normalized (any case of "contract…" → Contractor).
- Values echoed into pages and emails are HTML-escaped.
- Test notifications go to Gmail plus-addresses on one inbox instead of placeholder `yourcompany.com` addresses.

## v2 (Patched)

- Added **Restore Payload** after the initial Gmail notice so the hire record survives to the classification branch.

## v1

- HR webhook → manager notification prototype with validated email delivery.
