# Roadmap

## Next: ServiceNow integration (developer instance)

**Phase 1: Table API.** Replace the three mock nodes one-to-one:

| Mock node | Table | Key fields |
|---|---|---|
| Mock REQ Create | `sc_request` | `correlation_id` = `onbId`, `requested_for`, `short_description` |
| Mock RITM Create | `sc_req_item` | `request` = REQ `sys_id` |
| Mock SCTask Create | `sc_task` | `request_item` = RITM `sys_id`, `assignment_group` from the team, `short_description` = task description |

Implementation notes:

- An HTTP Request node replaces its input item with the API response, exactly as Gmail does. Follow each call with a small Code node that merges `result.number` and `result.sys_id` back into the incoming item, in the `req` / `ritm` / `sctask` shape from [data-contract.md](data-contract.md). Nothing downstream then changes.
- `correlation_id` (present on every task-based table) ties ServiceNow records back to the n8n `onbId` and lets a retry check for an existing REQ before creating a duplicate.
- `requested_for` needs an existing user record, which the new hire doesn't have yet. Decide: use the manager for now, or create the user first.
- Use a dedicated integration user with the `itil` role, not admin. Start with Basic Auth in an n8n credential; move to OAuth 2.0 later.
- Confirm assignment groups exist for hardware, software, network and facilities.
- Developer instances hibernate after inactivity. Wake the instance from the developer portal before testing.

**Phase 2: Service Catalog.** Model onboarding as a catalog item, order it through the Service Catalog API, and let a Flow Designer flow create the tasks. This is how it would run in production; Phase 1 proves the integration first.

## Open items

- [ ] **Input validation on `/newhire`.** Reject a missing `managerEmail` or an unrecognized `employmentType` up front (allow-list instead of the current "starts with contract" rule), and return 400 to the caller.
- [ ] **Error workflow.** The manager is acknowledged before provisioning runs, so a later failure is otherwise silent. Add an n8n Error Workflow that emails on failure, and enable Retry On Fail on API calls.
- [ ] **Intake web app.** Replace Postman with a small Python (Flask/FastAPI) app behind SSO: HR fills the new-hire form, the app assigns the `onbId`, logs the submission and posts to n8n server-to-server with a shared-secret header (n8n Header Auth on `/newhire`).
- [ ] **Identity provisioning.** Use `contractEndDate` as the account expiration date when creating the Entra ID / AD account.
- [ ] **Hosting.** Form links use `BASE_URL` (localhost by default); a tunnel or hosted n8n is needed for anyone else to open them.
