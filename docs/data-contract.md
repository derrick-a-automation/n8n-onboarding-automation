# Data contract

Every field the workflow reads or produces, where it enters, and what uses it.

## 1. HR trigger: `POST /newhire` (JSON)

| Field | Required | Used by | Notes |
|---|---|---|---|
| `firstName`, `lastName` | Yes | All emails, form header, summary | |
| `employmentType` | Yes* | Hire classification branch | Anything starting with "contract" (any case) becomes `Contractor`; everything else, including a missing value, becomes `FTE`. *Not validated yet, see roadmap. |
| `startDate` | Yes | Emails, form header, summary | `YYYY-MM-DD` |
| `managerEmail` | Yes* | Manager form-link email, no-provision email | *Not validated yet; a missing value fails at the Gmail node. |
| `employeeEmail` | No | Summary | Personal address; the work address doesn't exist until provisioning. |
| `onbId` | No | Everything | Generated as `ONB-XXXXXX-YYYYMMDD-HHMMSS` (UTC) when absent. Only supply it when simulating an intake app that assigns IDs. |
| `jobTitle`, `department`, `location`, `vendor`, `contractEndDate`, `requestedBy` | No | Not yet used | Passed through untouched; reserved for identity provisioning and ServiceNow fields. |

## 2. Manager form link: query string

Built in **Enrich Payload**, URL-encoded, and carried into the form as hidden inputs.

| Param | Source field |
|---|---|
| `onbId` | `onbId` |
| `fn`, `ln` | `firstName`, `lastName` |
| `sd` | `startDate` |
| `me` | `managerEmail` |
| `ee` | `employeeEmail` |
| `et` | normalized `employmentType` |

## 3. Manager form submit: `POST /{fte|contr}-onboarding-submit` (form-urlencoded)

The seven hidden fields above, plus:

| Field | Form control | Notes |
|---|---|---|
| `hardware` | Dropdown | FTE: three laptop models. Contractor: laptop or BYOD. |
| `monitor`, `dock` | Checkboxes | Only sent when ticked. **Map ... Req Fields** joins them into `hardware`. |
| `software`, `network`, `instructions` | Free text | Keyword-matched in **Gather Provision Info**. |

## 4. Derived flags (Gather Provision Info)

| Flag | Rule (case-insensitive) |
|---|---|
| `needsLaptop` | `hardware` contains "laptop" or "notebook" |
| `needsMonitor` / `needsDock` | `hardware` contains "monitor" / "dock" |
| `needsOffice` | `software` contains "office" or "365" |
| `needsSlack` / `needsAdobe` | `software` contains "slack" / "adobe" |
| `needsVPN` | `network` contains "vpn" |
| `needsSharedDriveA` | `network` contains "shared drive a" |
| `needsAdminVLAN` | `network` contains "admin" |
| `hasSpecialInstructions` | `instructions` is not empty |

Flags become tasks through the `TASK_CATALOG` table in **Gen Dyn Tasks List**. Adding a row there adds a task type.

## 5. Record shapes (the ServiceNow swap points)

Downstream nodes depend only on these shapes, so a real API call can replace a mock as long as its result is mapped back into them:

```js
req    = { reqNumber: "REQ1234567",    reqSysId: "..." }   // Mock REQ Create
ritm   = { ritmNumber: "RITM1234567",  ritmSysId: "..." }  // Mock RITM Create (one per category)
sctask = { taskNumber: "SCTASK1234567", taskSysId: "..." } // Mock SCTask Create (one per task)
```

## 6. Final record (Unified Onboarding Summary)

```json
{
  "onboardingId": "ONB-…",
  "ticketId": "TKT-…",
  "employee": { "name": "", "email": "", "classification": "FTE", "startDate": "" },
  "manager": { "email": "" },
  "provisioning": {
    "required": true,
    "tasksGenerated": 0,
    "categories": [],
    "req": {},
    "ritms": [],
    "sctasks": []
  },
  "summaryMessage": "",
  "timestamp": ""
}
```
